"""Option-selling agent: short strangle / straddle / iron condor / single-leg on an index.

Pricing is MODEL-BASED: Black-Scholes with India VIX as implied volatility. That ignores skew
(OTM puts trade richer in reality), so treat results as directional research, not exact P&L.
Plug a real option-chain feed (broker API) into _price() for exact prices.

Defaults follow NSE rules as of 2026: NIFTY weekly expiry on Tuesday, lot size 65;
BANKNIFTY is monthly only (last Tuesday), lot size 30. Verify with your broker.
"""
from __future__ import annotations

import pandas as pd

from ..backtest import compute_metrics
from ..data.universe import norm
from ..options_math import bs_delta, bs_price, intrinsic, next_expiry
from ..paper import PaperBroker
from ..storage import Store, dstr
from .base import BaseAgent, register

UNDERLYINGS = {  # lot size, strike step, default expiry
    "NIFTY": {"lot_size": 65, "strike_step": 50, "expiry": "weekly"},
    "BANKNIFTY": {"lot_size": 30, "strike_step": 100, "expiry": "monthly"},
    "NIFTYFIN": {"lot_size": 60, "strike_step": 50, "expiry": "monthly"},
}


@register
class OptionSellingAgent(BaseAgent):
    type_name = "option_selling"
    description = ("Systematic index option selling (NIFTY weekly, BANKNIFTY/FINNIFTY monthly): short strangle, "
                   "straddle, iron condor, short_put or short_call. Strikes by target delta or % OTM. Exits: stop-loss "
                   "as multiple of credit, profit target % of credit, time exit, or expiry. Optional India VIX filter. "
                   "Model-priced (Black-Scholes with VIX), so results are approximate.")
    defaults = {"underlying": "NIFTY", "structure": "strangle", "expiry": None, "expiry_weekday": 1,
                "strike_mode": "delta", "delta": 0.15, "otm_pct": 2.0, "wing_width": 500,
                "strike_step": None, "lot_size": None, "lots": 1, "min_dte": 2,
                "stop_loss_mult": 2.0, "profit_target_pct": 50, "exit_dte": 0,
                "min_vix": None, "max_vix": None, "iv_mult": 1.0, "capital": 500_000,
                "fee_per_order": 20, "cost_pct_premium": 0.15, "vix_symbol": "INDIAVIX"}
    example = {"underlying": "NIFTY", "structure": "iron_condor", "delta": 0.2, "wing_width": 400,
               "stop_loss_mult": 2.0, "profit_target_pct": 60, "lots": 2}

    @classmethod
    def _check(cls, s: dict) -> None:
        s["underlying"] = norm(s["underlying"])
        base = UNDERLYINGS.get(s["underlying"], {"lot_size": 1, "strike_step": 50, "expiry": "monthly"})
        for k in ("lot_size", "strike_step", "expiry"):
            if s.get(k) in (None, ""):
                s[k] = base[k]
        if s["structure"] not in ("strangle", "straddle", "iron_condor", "short_put", "short_call"):
            raise ValueError("structure: strangle | straddle | iron_condor | short_put | short_call")
        if s["expiry"] not in ("weekly", "monthly"):
            raise ValueError("expiry must be weekly or monthly")
        if s["strike_mode"] not in ("delta", "otm_pct"):
            raise ValueError("strike_mode must be delta or otm_pct")
        if not 0 < float(s["delta"]) < 0.5:
            raise ValueError("delta must be between 0 and 0.5")

    def symbols(self) -> list[str]:
        return [self.spec["underlying"], self.spec["vix_symbol"]]

    # ---------------------------------------------------------------- helpers
    def _expiry_for(self, d: pd.Timestamp) -> pd.Timestamp:
        monthly = self.spec["expiry"] == "monthly"
        cand = d
        for _ in range(60):
            e = next_expiry(cand, int(self.spec["expiry_weekday"]), monthly)
            if (e - d).days >= int(self.spec["min_dte"]):
                return e
            cand = e + pd.Timedelta(days=1)
        raise RuntimeError("could not find expiry")

    @staticmethod
    def _T(d: pd.Timestamp, exp: pd.Timestamp) -> float:
        return ((exp - d).days + 0.25) / 365  # at close, ~a quarter-day left on expiry morning

    def _price(self, S, K, T, sigma, kind) -> float:
        return bs_price(S, K, T, self.ctx.settings.risk_free, sigma, kind)

    def _strike(self, S, T, sigma, kind) -> float:
        step = self.spec["strike_step"]
        atm = round(S / step) * step
        if self.spec["strike_mode"] == "otm_pct":
            k = S * (1 + self.spec["otm_pct"] / 100) if kind == "CE" else S * (1 - self.spec["otm_pct"] / 100)
            return round(k / step) * step
        r, K = self.ctx.settings.risk_free, atm
        for i in range(400):
            K = atm + i * step if kind == "CE" else atm - i * step
            if abs(bs_delta(S, K, T, r, sigma, kind)) <= self.spec["delta"]:
                break
        return K

    def _legs(self, S, T, sigma) -> list[tuple[str, float, int]]:
        st, step = self.spec["structure"], self.spec["strike_step"]
        atm = round(S / step) * step
        if st == "straddle":
            return [("CE", atm, -1), ("PE", atm, -1)]
        legs = []
        if st in ("strangle", "iron_condor", "short_call"):
            legs.append(("CE", self._strike(S, T, sigma, "CE"), -1))
        if st in ("strangle", "iron_condor", "short_put"):
            legs.append(("PE", self._strike(S, T, sigma, "PE"), -1))
        if st == "iron_condor":
            w = self.spec["wing_width"]
            legs += [("CE", legs[0][1] + w, +1), ("PE", legs[1][1] - w, +1)]
        return legs

    def _fees(self, q, px) -> float:
        return self.spec["fee_per_order"] + abs(q) * px * self.spec["cost_pct_premium"] / 100

    def _close_all(self, b: PaperBroker, d, marks: dict, reason: str, emit: bool) -> None:
        for sym, p in b.positions().items():
            b.execute(d, sym, -p["qty"], marks[sym], note=reason, fees=self._fees(p["qty"], marks[sym]))
        if emit:
            self.signal(d, self.spec["underlying"], "CLOSE", None, f"Closed option position: {reason}")

    # ---------------------------------------------------------------- core step (shared by backtest & paper)
    def _step(self, b: PaperBroker, d: pd.Timestamp, S: float, vix: float, st: dict, emit: bool,
              cycles: list) -> dict:
        sigma = vix / 100 * self.spec["iv_mult"]
        pos = b.positions()
        if pos:
            meta = next(iter(pos.values()))["meta"]
            exp, credit = pd.Timestamp(meta["expiry"]), float(meta["credit"])
            if d >= exp:
                marks = {s: intrinsic(S, p["meta"]["strike"], p["meta"]["kind"]) for s, p in pos.items()}
                reason = "expiry settlement"
            else:
                T = self._T(d, exp)
                marks = {s: self._price(S, p["meta"]["strike"], T, sigma, p["meta"]["kind"]) for s, p in pos.items()}
                ctc = -sum(p["qty"] * marks[s] for s, p in pos.items())  # cost to close (+ for net short)
                reason = None
                if self.spec["stop_loss_mult"] and ctc >= credit * self.spec["stop_loss_mult"]:
                    reason = "stop loss"
                elif self.spec["profit_target_pct"] and ctc <= credit * (1 - self.spec["profit_target_pct"] / 100):
                    reason = "profit target"
                elif self.spec["exit_dte"] and (exp - d).days <= self.spec["exit_dte"]:
                    reason = "time exit"
                if not reason:
                    return marks
            self._close_all(b, d, marks, reason, emit)
            pnl = b.cash - st["cycle_cash"]
            cycles.append({"entry_date": st["cycle_entry"], "exit_date": dstr(d), "expiry": dstr(exp),
                           "credit": round(credit, 2), "pnl": round(pnl, 2), "reason": reason})
            st["cooldown_until"] = None if reason == "expiry settlement" else dstr(exp)
        # ---- entry
        cd = st.get("cooldown_until")
        if cd and d <= pd.Timestamp(cd):
            return {}
        if (self.spec["min_vix"] and vix < self.spec["min_vix"]) or (self.spec["max_vix"] and vix > self.spec["max_vix"]):
            return {}
        exp = self._expiry_for(d)
        T = self._T(d, exp)
        units = int(self.spec["lots"]) * int(self.spec["lot_size"])
        legs = self._legs(S, T, sigma)
        priced = [(k, K, sgn, self._price(S, K, T, sigma, k)) for k, K, sgn in legs]
        credit = sum(-sgn * units * px for _, _, sgn, px in priced)
        if credit <= 0:
            return {}
        st["cycle_cash"], st["cycle_entry"] = b.cash, dstr(d)
        und, marks, desc = self.spec["underlying"], {}, []
        for kind, K, sgn, px in priced:
            sym = f"{und} {exp:%d%b%y} {int(K)} {kind}".upper()
            q = sgn * units
            b.execute(d, sym, q, px, note="open", fees=self._fees(q, px),
                      meta={"kind": kind, "strike": K, "expiry": dstr(exp), "credit": credit, "spot": S})
            marks[sym] = px
            desc.append(f"{'SELL' if sgn < 0 else 'BUY'} {int(K)}{kind} @{px:.1f}")
        if emit:
            self.signal(d, und, "OPEN", S, f"{self.spec['structure']} exp {dstr(exp)}: " + ", ".join(desc)
                        + f" | credit ₹{credit:,.0f} | spot {S:.0f} VIX {vix:.1f}")
        return marks

    def _data(self, start=None, end=None) -> pd.DataFrame:
        spot = self.ctx.provider.history(self.spec["underlying"], start, end)["close"].rename("S")
        vix = self.ctx.provider.history(self.spec["vix_symbol"], start, end)["close"].rename("vix")
        return pd.concat([spot, vix], axis=1).ffill().dropna()

    # ---------------------------------------------------------------- backtest / paper
    def backtest(self, start=None, end=None) -> dict:
        df = self._data(start, end)
        b = PaperBroker(Store(), "bt", self.spec["capital"], 0)
        st, cycles, eq = {}, [], {}
        for d, row in df.iterrows():
            marks = self._step(b, d, float(row.S), float(row.vix), st, False, cycles)
            eq[d] = b.mark(d, marks)
        equity = pd.Series(eq)
        m = compute_metrics(equity, cycles, self.ctx.settings.risk_free)
        reasons = pd.Series([c["reason"] for c in cycles]).value_counts().to_dict() if cycles else {}
        m.update({"cycles": len(cycles), "exit_reasons": reasons,
                  "note": "Model-priced with Black-Scholes + India VIX; no skew, no slippage beyond fees."})
        return {"equity": equity, "trades": cycles, "metrics": m}

    def run_daily(self, asof) -> dict:
        df = self._data(end=asof)
        if df.empty:
            return {"signals": [], "note": "no data"}
        b = self.broker()
        st = self.state.setdefault("cycle", {})
        cycles = self.state.setdefault("cycles", [])
        for d in self.new_dates(df.index, asof):
            row = df.loc[d]
            n_before = len(cycles)
            marks = self._step(b, d, float(row.S), float(row.vix), st, True, cycles)
            for c in cycles[n_before:]:
                self.signal(d, self.spec["underlying"], "CYCLE", None,
                            f"Cycle closed ({c['reason']}): P&L ₹{c['pnl']:,.0f}", notify=False)
            b.mark(d, marks)
            self.state["last_processed"] = dstr(d)
        self.state["cycles"] = cycles[-100:]
        self.save_state()
        return {"signals": self._emitted}

    def liquidate(self, asof, note: str = "agent destroyed") -> list[dict]:
        df = self._data(end=asof)
        b = self.broker()
        pos = b.positions()
        if not pos or df.empty:
            return []
        d, S, vix = df.index[-1], float(df.S.iloc[-1]), float(df.vix.iloc[-1])
        marks = {s: self._price(S, p["meta"]["strike"], self._T(d, pd.Timestamp(p["meta"]["expiry"])),
                                vix / 100 * self.spec["iv_mult"], p["meta"]["kind"]) for s, p in pos.items()}
        self._close_all(b, d, marks, note, emit=False)
        b.mark(d)
        return [{"closed": list(marks)}]

    def status(self) -> dict:
        cyc = self.state.get("cycles", [])
        wins = [c for c in cyc if c["pnl"] > 0]
        return {"cycles_closed": len(cyc), "win_rate_pct": round(100 * len(wins) / len(cyc), 1) if cyc else None,
                "last_cycles": cyc[-3:]}
