"""Symbols, index mappings and universes.

Symbols are plain NSE tickers (RELIANCE, TCS, M&M, BAJAJ-AUTO). Indices use short keys
(NIFTY, BANKNIFTY, INDIAVIX, NIFTYIT ...). Edit NIFTY50 when the index is reconstituted.
"""
from __future__ import annotations

# Short key -> Yahoo Finance ticker. Verify with `tradeos check-data` on first run.
YAHOO_INDEX = {
    "NIFTY": "^NSEI", "NIFTY50": "^NSEI",
    "BANKNIFTY": "^NSEBANK", "NIFTYBANK": "^NSEBANK",
    "SENSEX": "^BSESN",
    "INDIAVIX": "^INDIAVIX",
    "NIFTYIT": "^CNXIT",
    "NIFTYPHARMA": "^CNXPHARMA",
    "NIFTYFMCG": "^CNXFMCG",
    "NIFTYAUTO": "^CNXAUTO",
    "NIFTYMETAL": "^CNXMETAL",
    "NIFTYREALTY": "^CNXREALTY",
    "NIFTYENERGY": "^CNXENERGY",
    "NIFTYPSUBANK": "^CNXPSUBANK",
    "NIFTYMEDIA": "^CNXMEDIA",
    "NIFTYINFRA": "^CNXINFRA",
    "NIFTYFIN": "NIFTY_FIN_SERVICE.NS",
}

SECTORS = ["NIFTYBANK", "NIFTYIT", "NIFTYPHARMA", "NIFTYFMCG", "NIFTYAUTO", "NIFTYMETAL",
           "NIFTYREALTY", "NIFTYENERGY", "NIFTYPSUBANK", "NIFTYMEDIA", "NIFTYINFRA", "NIFTYFIN"]

# Nifty 50 constituents (approximate, 2025-26). Check NSE and edit when it changes.
NIFTY50 = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJFINANCE",
    "BAJAJFINSV", "BEL", "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL",
    "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK",
    "INDUSINDBK", "INFY", "ITC", "JIOFIN", "JSWSTEEL", "KOTAKBANK", "LT", "M&M", "MARUTI", "NESTLEIND",
    "NTPC", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SBIN", "SHRIRAMFIN", "SUNPHARMA", "TATACONSUM",
    "TMPV", "TATASTEEL", "TCS", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "WIPRO",
]

INDICES = ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTYFIN"]

UNIVERSES: dict[str, list[str]] = {
    "nifty50": NIFTY50,
    "sectors": SECTORS,
    "indices": INDICES,
}


def norm(symbol: str) -> str:
    return symbol.strip().upper()


def is_index(symbol: str) -> bool:
    s = norm(symbol)
    return s in YAHOO_INDEX or s.startswith("^")


def to_yahoo(symbol: str) -> str:
    s = norm(symbol)
    if s in YAHOO_INDEX:
        return YAHOO_INDEX[s]
    if s.startswith("^") or "." in s:
        return s
    return f"{s}.NS"


def resolve_universe(u: str | list[str]) -> list[str]:
    if isinstance(u, (list, tuple)):
        if not u:
            raise ValueError("Universe list is empty")
        return [norm(x) for x in u]
    key = str(u).lower()
    if key not in UNIVERSES:
        raise ValueError(f"Unknown universe '{u}'. Known: {', '.join(UNIVERSES)} or pass a list of symbols.")
    return list(UNIVERSES[key])
