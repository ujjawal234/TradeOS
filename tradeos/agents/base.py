"""Sub-agent base class and registry.

Every sub-agent type implements:
  validate(spec)      -> spec with defaults filled (raises ValueError on bad input)
  backtest(start,end) -> dict of results (metrics, output folder, ...)
  run_daily(asof)     -> dict with the signals it emitted on its paper account
To add a new kind of agent, subclass BaseAgent, decorate with @register, and import it
in agents/__init__.py. The Main Agent discovers it automatically.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Callable

import pandas as pd

from ..paper import PaperBroker
from ..storage import dstr

AGENT_TYPES: dict[str, type["BaseAgent"]] = {}


def register(cls):
    AGENT_TYPES[cls.type_name] = cls
    return cls


@dataclass
class AgentContext:
    provider: object
    store: object
    notifier: object
    settings: object
    llm: Callable[[], object]  # lazily creates the LLM client


class BaseAgent:
    type_name = "base"
    description = ""
    defaults: dict = {}
    example: dict = {}

    def __init__(self, row: dict, ctx: AgentContext):
        self.id = row["id"]
        self.name = row["name"]
        self.spec = row["spec"]
        self.state = row.get("state") or {}
        self.ctx = ctx
        self._emitted: list[dict] = []

    # ---- spec handling
    @classmethod
    def validate(cls, spec: dict) -> dict:
        s = copy.deepcopy(cls.defaults)
        s.update(spec or {})
        cls._check(s)
        return s

    @classmethod
    def _check(cls, spec: dict) -> None:
        pass

    @classmethod
    def info(cls) -> dict:
        return {"type": cls.type_name, "description": cls.description,
                "defaults": cls.defaults, "example_spec": cls.example}

    # ---- helpers
    def symbols(self) -> list[str]:
        return []

    def broker(self) -> PaperBroker:
        return PaperBroker(self.ctx.store, self.id, float(self.spec.get("capital", 1_000_000)),
                           float(self.spec.get("cost_pct", 0.12)))

    def save_state(self) -> None:
        self.ctx.store.update_agent(self.id, state=self.state)

    def signal(self, date, symbol: str, action: str, price: float | None, message: str, notify: bool = True) -> dict:
        sig = self.ctx.store.add_signal(self.id, dstr(date), symbol, action,
                                        None if price is None else round(float(price), 2), message)
        self._emitted.append(sig)
        if notify:
            self.ctx.notifier.send(f"[{self.name}] {action} {symbol}: {message}")
        return sig

    def new_dates(self, index: pd.DatetimeIndex, asof, max_catchup: int = 10) -> list[pd.Timestamp]:
        """Bars not yet processed on the paper account (catch-up if daily runs were missed)."""
        asof = pd.Timestamp(asof)
        idx = index[index <= asof]
        last = self.state.get("last_processed")
        if not last:
            return list(idx[-1:])
        return list(idx[idx > pd.Timestamp(last)][-max_catchup:])

    def liquidate(self, asof, note: str = "agent destroyed") -> list[dict]:
        b, out = self.broker(), []
        for sym, p in b.positions().items():
            try:
                px = self.ctx.provider.last_close(sym, end=asof)
            except Exception:
                px = p["avg_price"]
            out.append(b.execute(asof, sym, -p["qty"], px, note=note))
        b.mark(asof)
        return out

    # ---- to implement
    def backtest(self, start=None, end=None) -> dict:
        raise NotImplementedError

    def run_daily(self, asof) -> dict:
        raise NotImplementedError

    def status(self) -> dict:
        """Type-specific extra status for reports."""
        return {}
