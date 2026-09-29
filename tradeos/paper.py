"""Paper broker: cash, positions (signed qty; negative = short), trades, equity marks.

The same class runs backtests (on an in-memory Store) and live paper accounts (on disk),
so both use identical accounting.
"""
from __future__ import annotations

from .storage import Store, dstr


class PaperBroker:
    def __init__(self, store: Store, agent_id: str, initial_capital: float, cost_pct: float = 0.12):
        self.store = store
        self.agent_id = agent_id
        self.cost_pct = cost_pct
        if store.get_account(agent_id) is None:
            store.set_account(agent_id, float(initial_capital), float(initial_capital))

    @property
    def cash(self) -> float:
        return float(self.store.get_account(self.agent_id)["cash"])

    @property
    def initial(self) -> float:
        return float(self.store.get_account(self.agent_id)["initial"])

    def positions(self) -> dict[str, dict]:
        return self.store.get_positions(self.agent_id)

    def qty(self, symbol: str) -> float:
        p = self.positions().get(symbol)
        return float(p["qty"]) if p else 0.0

    def execute(self, date, symbol: str, qty: float, price: float, note: str = "",
                fees: float | None = None, meta: dict | None = None) -> dict | None:
        qty = float(qty)
        if abs(qty) < 1e-9:
            return None
        price = float(price)
        if fees is None:
            fees = abs(qty) * price * self.cost_pct / 100
        pos = self.positions().get(symbol)
        cur_q = float(pos["qty"]) if pos else 0.0
        avg = float(pos["avg_price"]) if pos else 0.0
        opened = pos["opened"] if pos else dstr(date)
        m = dict(pos["meta"]) if pos else {}
        realized = 0.0
        if cur_q == 0 or (cur_q > 0) == (qty > 0):  # opening / adding
            new_q = cur_q + qty
            new_avg = (cur_q * avg + qty * price) / new_q
            if meta:
                m.update(meta)
        else:  # reducing / closing / flipping
            closing = min(abs(qty), abs(cur_q))
            realized = closing * (price - avg) * (1 if cur_q > 0 else -1)
            new_q = cur_q + qty
            if abs(new_q) < 1e-9:
                new_q, new_avg = 0.0, 0.0
            elif (new_q > 0) != (cur_q > 0):
                new_avg, opened, m = price, dstr(date), dict(meta or {})
            else:
                new_avg = avg
        self.store.set_account(self.agent_id, self.cash - qty * price - fees)
        if new_q == 0:
            self.store.del_position(self.agent_id, symbol)
        else:
            self.store.set_position(self.agent_id, symbol, new_q, new_avg, opened, m)
        net = realized - fees
        self.store.add_trade(self.agent_id, dstr(date), symbol, qty, price, fees, net, note)
        return {"date": dstr(date), "symbol": symbol, "qty": qty, "price": price, "fees": round(fees, 2),
                "realized": round(net, 2), "note": note}

    def equity(self, marks: dict[str, float] | None = None) -> float:
        marks = marks or {}
        return self.cash + sum(float(p["qty"]) * float(marks.get(s, p["avg_price"]))
                               for s, p in self.positions().items())

    def mark(self, date, marks: dict[str, float] | None = None) -> float:
        eq = self.equity(marks)
        self.store.set_equity(self.agent_id, dstr(date), eq)
        return eq
