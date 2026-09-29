"""SQLite persistence: agents, runs, signals, paper accounts, positions, trades, equity."""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents(
    id TEXT PRIMARY KEY, name TEXT, type TEXT, spec TEXT, state TEXT DEFAULT '{}',
    status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, run_date TEXT,
    summary TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS signals(
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, date TEXT, symbol TEXT,
    action TEXT, price REAL, message TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS accounts(agent_id TEXT PRIMARY KEY, cash REAL, initial REAL);
CREATE TABLE IF NOT EXISTS positions(
    agent_id TEXT, symbol TEXT, qty REAL, avg_price REAL, opened TEXT, meta TEXT DEFAULT '{}',
    PRIMARY KEY(agent_id, symbol));
CREATE TABLE IF NOT EXISTS trades(
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, date TEXT, symbol TEXT, qty REAL,
    price REAL, fees REAL, realized REAL, note TEXT);
CREATE TABLE IF NOT EXISTS equity(agent_id TEXT, date TEXT, equity REAL, PRIMARY KEY(agent_id, date));
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def dstr(d: Any) -> str:
    """Normalise a date-like to YYYY-MM-DD."""
    if hasattr(d, "date") and callable(d.date):
        d = d.date()
    return str(d)[:10]


class Store:
    def __init__(self, path: str = ":memory:"):
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def _x(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        cur = self.conn.execute(sql, args)
        self.conn.commit()
        return cur

    # ---------------- agents
    @staticmethod
    def _agent(r: sqlite3.Row) -> dict:
        d = dict(r)
        d["spec"] = json.loads(d["spec"] or "{}")
        d["state"] = json.loads(d["state"] or "{}")
        return d

    def add_agent(self, name: str, type_: str, spec: dict) -> str:
        aid = uuid.uuid4().hex[:8]
        self._x("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)",
                (aid, name, type_, json.dumps(spec), "{}", "active", now(), now()))
        return aid

    def get_agent(self, aid: str) -> dict | None:
        r = self.conn.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone()
        return self._agent(r) if r else None

    def list_agents(self, include_destroyed: bool = False) -> list[dict]:
        sql = "SELECT * FROM agents" + ("" if include_destroyed else " WHERE status!='destroyed'")
        return [self._agent(r) for r in self.conn.execute(sql + " ORDER BY created_at")]

    def update_agent(self, aid: str, **fields: Any) -> None:
        for k in ("spec", "state"):
            if k in fields:
                fields[k] = json.dumps(fields[k], default=str)
        fields["updated_at"] = now()
        cols = ", ".join(f"{k}=?" for k in fields)
        self._x(f"UPDATE agents SET {cols} WHERE id=?", (*fields.values(), aid))

    # ---------------- runs
    def add_run(self, aid: str, kind: str, run_date: str, summary: dict) -> None:
        self._x("INSERT INTO runs(agent_id, kind, run_date, summary, created_at) VALUES (?,?,?,?,?)",
                (aid, kind, run_date, json.dumps(summary, default=str), now()))

    def list_runs(self, aid: str, kind: str | None = None, limit: int = 10) -> list[dict]:
        sql, args = "SELECT * FROM runs WHERE agent_id=?", [aid]
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        rows = self.conn.execute(sql + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [{**dict(r), "summary": json.loads(r["summary"])} for r in rows]

    # ---------------- signals
    def add_signal(self, aid: str, date: str, symbol: str, action: str, price: float | None, message: str) -> dict:
        self._x("INSERT INTO signals(agent_id, date, symbol, action, price, message, created_at) VALUES (?,?,?,?,?,?,?)",
                (aid, date, symbol, action, price, message, now()))
        return {"agent_id": aid, "date": date, "symbol": symbol, "action": action, "price": price, "message": message}

    def list_signals(self, aid: str | None = None, limit: int = 50) -> list[dict]:
        if aid:
            rows = self.conn.execute("SELECT * FROM signals WHERE agent_id=? ORDER BY id DESC LIMIT ?", (aid, limit))
        else:
            rows = self.conn.execute("SELECT * FROM signals ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows]

    # ---------------- paper accounts
    def get_account(self, aid: str) -> dict | None:
        r = self.conn.execute("SELECT * FROM accounts WHERE agent_id=?", (aid,)).fetchone()
        return dict(r) if r else None

    def set_account(self, aid: str, cash: float, initial: float | None = None) -> None:
        if initial is None:
            self._x("UPDATE accounts SET cash=? WHERE agent_id=?", (cash, aid))
        else:
            self._x("INSERT OR REPLACE INTO accounts VALUES (?,?,?)", (aid, cash, initial))

    def get_positions(self, aid: str) -> dict[str, dict]:
        out = {}
        for r in self.conn.execute("SELECT * FROM positions WHERE agent_id=?", (aid,)):
            d = dict(r)
            d["meta"] = json.loads(d["meta"] or "{}")
            out[d["symbol"]] = d
        return out

    def set_position(self, aid: str, symbol: str, qty: float, avg: float, opened: str, meta: dict) -> None:
        self._x("INSERT OR REPLACE INTO positions VALUES (?,?,?,?,?,?)",
                (aid, symbol, qty, avg, opened, json.dumps(meta, default=str)))

    def del_position(self, aid: str, symbol: str) -> None:
        self._x("DELETE FROM positions WHERE agent_id=? AND symbol=?", (aid, symbol))

    def add_trade(self, aid: str, date: str, symbol: str, qty: float, price: float,
                  fees: float, realized: float, note: str) -> None:
        self._x("INSERT INTO trades(agent_id, date, symbol, qty, price, fees, realized, note) VALUES (?,?,?,?,?,?,?,?)",
                (aid, date, symbol, qty, price, fees, realized, note))

    def list_trades(self, aid: str, limit: int | None = None) -> list[dict]:
        sql = "SELECT * FROM trades WHERE agent_id=? ORDER BY id DESC" + (f" LIMIT {int(limit)}" if limit else "")
        return [dict(r) for r in self.conn.execute(sql, (aid,))]

    def set_equity(self, aid: str, date: str, equity: float) -> None:
        self._x("INSERT OR REPLACE INTO equity VALUES (?,?,?)", (aid, date, equity))

    def equity_series(self, aid: str) -> list[tuple[str, float]]:
        return [(r["date"], r["equity"]) for r in
                self.conn.execute("SELECT date, equity FROM equity WHERE agent_id=? ORDER BY date", (aid,))]

    def reset_paper(self, aid: str) -> None:
        for t in ("accounts", "positions", "trades", "equity"):
            self._x(f"DELETE FROM {t} WHERE agent_id=?", (aid,))
