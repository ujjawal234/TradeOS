"""Safe expression DSL for strategy and alert conditions.

Expressions are evaluated over a whole price history at once, for example:

    cross_above(ema(close, 20), ema(close, 50)) and rsi(close, 14) > 50
    close > shift(highest(high, 20), 1) and volume > 1.5 * sma(volume, 20)
    close < 2400

Only whitelisted variables and functions are allowed; user text is parsed with `ast`
and interpreted — never passed to eval().
"""
from __future__ import annotations

import ast
import operator

import numpy as np
import pandas as pd

from . import indicators as ind


class RuleError(ValueError):
    pass


VARIABLES = {
    "open": "open price", "high": "high", "low": "low", "close": "close", "volume": "volume",
    "hl2": "(high+low)/2", "dow": "day of week (0=Mon .. 4=Fri)", "pe": "index P/E", "pb": "index P/B", "dy": "index dividend yield",
}

FUNC_DOCS = {
    "sma(x, n)": "simple moving average",
    "ema(x, n)": "exponential moving average",
    "wma(x, n)": "weighted moving average",
    "rsi(x, n=14)": "relative strength index",
    "atr(n=14)": "average true range (points)",
    "atr_pct(n=14)": "ATR as % of close",
    "macd(x, fast=12, slow=26)": "MACD line",
    "macd_signal(x, fast=12, slow=26, signal=9)": "MACD signal line",
    "bb_upper(x, n=20, k=2) / bb_lower(...)": "Bollinger bands",
    "highest(x, n) / lowest(x, n)": "rolling max / min INCLUDING today; use shift(...,1) for breakouts",
    "shift(x, n=1) / prev(x)": "value n bars ago",
    "change(x, n=1)": "x - x n bars ago",
    "roc(x, n=1)": "% change over n bars",
    "stdev(x, n) / zscore(x, n)": "rolling std-dev / z-score",
    "volatility(x, n=20)": "annualised volatility %",
    "cross_above(a, b) / cross_below(a, b)": "true only on the bar a crosses b",
    "count_true(cond, n)": "how many of the last n bars cond was true",
    "abs(x), max(a, b), min(a, b)": "math helpers",
}

_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_CMP = {ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt, ast.LtE: operator.le,
        ast.Eq: operator.eq, ast.NotEq: operator.ne}


class RuleEngine:
    def __init__(self, df: pd.DataFrame):
        self.df = df
        self.index = df.index
        self.vars = {k: df[k].astype(float) for k in ("open", "high", "low", "close", "volume") if k in df}
        self.vars["hl2"] = (df["high"] + df["low"]) / 2
        self.vars["dow"] = pd.Series(df.index.dayofweek, index=df.index, dtype=float)
        for k in ("pe", "pb", "dy"):  # index valuation when the data has it (NSE indices)
            self.vars[k] = df[k].astype(float) if k in df else pd.Series(np.nan, index=df.index)
        self.funcs = self._funcs()

    # -- helpers
    def _s(self, x) -> pd.Series:
        if isinstance(x, pd.Series):
            return x
        return pd.Series(float(x), index=self.index)

    def _bool(self, v) -> pd.Series:
        if isinstance(v, pd.Series):
            if v.dtype == bool:
                return v
            return v.fillna(0).astype(float) != 0
        return pd.Series(bool(v), index=self.index)

    def _funcs(self) -> dict:
        s, df = self._s, self.df
        return {
            "sma": lambda x, n: ind.sma(s(x), n),
            "ema": lambda x, n: ind.ema(s(x), n),
            "wma": lambda x, n: ind.wma(s(x), n),
            "rsi": lambda x, n=14: ind.rsi(s(x), n),
            "atr": lambda n=14: ind.atr(df, n),
            "atr_pct": lambda n=14: ind.atr(df, n) / df["close"] * 100,
            "macd": lambda x, fast=12, slow=26: ind.macd(s(x), fast, slow),
            "macd_signal": lambda x, fast=12, slow=26, signal=9: ind.macd_signal(s(x), fast, slow, signal),
            "bb_upper": lambda x, n=20, k=2: ind.bb_upper(s(x), n, k),
            "bb_lower": lambda x, n=20, k=2: ind.bb_lower(s(x), n, k),
            "highest": lambda x, n: s(x).rolling(int(n), min_periods=int(n)).max(),
            "lowest": lambda x, n: s(x).rolling(int(n), min_periods=int(n)).min(),
            "shift": lambda x, n=1: s(x).shift(int(n)),
            "prev": lambda x: s(x).shift(1),
            "change": lambda x, n=1: s(x).diff(int(n)),
            "roc": lambda x, n=1: s(x).pct_change(int(n), fill_method=None) * 100,
            "stdev": lambda x, n: s(x).rolling(int(n), min_periods=int(n)).std(),
            "zscore": lambda x, n: ind.zscore(s(x), n),
            "volatility": lambda x, n=20: ind.volatility(s(x), n),
            "cross_above": lambda a, b: ind.cross_above(s(a), s(b)),
            "cross_below": lambda a, b: ind.cross_below(s(a), s(b)),
            "count_true": lambda c, n: self._bool(c).astype(float).rolling(int(n), min_periods=1).sum(),
            "abs": lambda x: x.abs() if isinstance(x, pd.Series) else abs(x),
            "max": lambda a, b: np.maximum(s(a), s(b)),
            "min": lambda a, b: np.minimum(s(a), s(b)),
        }

    # -- public
    def eval(self, expr: str):
        if not expr or not str(expr).strip():
            raise RuleError("Empty expression")
        try:
            tree = ast.parse(str(expr).strip(), mode="eval")
        except SyntaxError as e:
            raise RuleError(f"Syntax error in '{expr}': {e.msg}") from None
        return self._ev(tree.body)

    def condition(self, expr: str) -> pd.Series:
        return self._bool(self.eval(expr))

    # -- interpreter
    def _ev(self, node):
        if isinstance(node, ast.BoolOp):
            vals = [self._bool(self._ev(v)) for v in node.values]
            out = vals[0]
            for v in vals[1:]:
                out = (out & v) if isinstance(node.op, ast.And) else (out | v)
            return out
        if isinstance(node, ast.UnaryOp):
            v = self._ev(node.operand)
            if isinstance(node.op, ast.Not):
                return ~self._bool(v)
            if isinstance(node.op, ast.USub):
                return -v
            if isinstance(node.op, ast.UAdd):
                return v
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
            return _BIN[type(node.op)](self._ev(node.left), self._ev(node.right))
        if isinstance(node, ast.Compare):
            left, result = self._ev(node.left), None
            for op, comp in zip(node.ops, node.comparators):
                if type(op) not in _CMP:
                    raise RuleError("Unsupported comparison")
                right = self._ev(comp)
                r = self._bool(_CMP[type(op)](left, right))
                result = r if result is None else (result & r)
                left = right
            return result
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in self.funcs:
                name = getattr(node.func, "id", "?")
                raise RuleError(f"Unknown function '{name}'. Allowed: {', '.join(sorted(self.funcs))}")
            args = [self._ev(a) for a in node.args]
            kwargs = {k.arg: self._ev(k.value) for k in node.keywords}
            try:
                return self.funcs[node.func.id](*args, **kwargs)
            except TypeError as e:
                raise RuleError(f"Bad arguments to {node.func.id}(): {e}") from None
        if isinstance(node, ast.Name):
            if node.id in self.vars:
                return self.vars[node.id]
            raise RuleError(f"Unknown variable '{node.id}'. Allowed: {', '.join(self.vars)}")
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, bool)):
            return node.value
        raise RuleError(f"Unsupported syntax: {ast.dump(node)[:60]}")


def _sample_df(n: int = 300) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    idx = pd.bdate_range("2020-01-01", periods=n)
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                         "volume": rng.integers(1000, 5000, n).astype(float)}, index=idx)


def validate(expr: str) -> None:
    """Raise RuleError if the expression cannot be evaluated."""
    RuleEngine(_sample_df()).condition(expr)


def docs() -> str:
    lines = ["Variables: " + ", ".join(f"{k} ({v})" for k, v in VARIABLES.items()), "Functions:"]
    lines += [f"  {k}: {v}" for k, v in FUNC_DOCS.items()]
    lines.append("Operators: + - * / %, comparisons (> >= < <= == !=), and / or / not. Numbers are literals.")
    return "\n".join(lines)
