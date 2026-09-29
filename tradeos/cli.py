"""Command line for TradeOS. Run `python -m tradeos --help`."""
from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
from pathlib import Path

from .config import get_settings


def _p(obj) -> None:
    print(json.dumps(obj, indent=2, default=str, ensure_ascii=False))


def _spec(args) -> dict:
    if getattr(args, "spec", None):
        return json.loads(Path(args.spec).read_text())
    if getattr(args, "json", None):
        return json.loads(args.json)
    return {}


def _manager(args, quiet=False):
    from .manager import Manager
    return Manager(get_settings(args.home, args.provider), quiet=quiet)


def _metrics_line(m: dict) -> str:
    keys = ["total_return_pct", "cagr_pct", "max_drawdown_pct", "sharpe", "trades", "win_rate_pct", "profit_factor"]
    return "  ".join(f"{k}={m.get(k)}" for k in keys if k in m)


def cmd_chat(args) -> None:
    from .brain import MainAgent
    from .llm import LLMUnavailable
    m = _manager(args)
    try:
        agent = MainAgent(m)
    except LLMUnavailable as e:
        sys.exit(f"Main Agent needs Claude: {e}")
    print("TradeOS Main Agent. Type what you want; 'exit' to quit.\n")
    while True:
        try:
            text = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text.lower() in ("exit", "quit"):
            break
        if text:
            reply = agent.ask(text, on_tool=lambda n, a: print(f"  · {n} {json.dumps(a, default=str)[:140]}"))
            print(f"\nagent> {reply}\n")


def cmd_demo(args) -> None:
    """Offline walkthrough on SYNTHETIC data: create agents, backtest, simulate 15 paper days."""
    import pandas as pd

    from .data.synthetic import SyntheticProvider
    from .manager import Manager
    home = Path(args.home) if args.home else Path(tempfile.mkdtemp(prefix="tradeos_demo_"))
    m = Manager(get_settings(home, "synthetic"), provider=SyntheticProvider(), quiet=True)
    print(f"Demo home: {home}  (synthetic prices — NOT real market data)\n")
    specs = [
        ("alert", "Level alerts", {"alerts": [{"symbol": "RELIANCE", "expr": "cross_above(close, sma(close, 50))",
                                               "message": "Reliance reclaimed 50 DMA"},
                                              {"symbol": "NIFTY", "expr": "rsi(close, 14) < 35"}]}),
        ("rule", "EMA trend", {"symbols": ["RELIANCE", "HDFCBANK", "INFY", "TCS"],
                               "entry": "cross_above(ema(close,20), ema(close,50))",
                               "exit": "cross_below(ema(close,20), ema(close,50))", "stop_loss_pct": 8}),
        ("rotation", "Sector momentum", {"universe": "sectors", "lookback": 63, "skip": 5, "top_n": 3,
                                         "rebalance": "weekly", "trend_filter": None}),
        ("option_selling", "Nifty weekly strangle", {"underlying": "NIFTY", "structure": "strangle",
                                                      "delta": 0.15, "stop_loss_mult": 2.0}),
    ]
    ids = []
    for t, n, s in specs:
        a = m.create_agent(t, n, s)
        ids.append(a["id"])
        bt = m.backtest(a["id"], start="2019-01-01")
        print(f"[{a['id']}] {n} ({t})")
        if "metrics" in bt:
            print("   backtest:", _metrics_line(bt["metrics"]))
            print("   NIFTY   :", bt.get("benchmark_nifty"))
        else:
            for x in bt.get("alerts", []):
                print(f"   alert {x['symbol']}: triggered {x['times_triggered']}x, avg fwd 20d {x['avg_fwd_20d_pct']}%")
    days = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=15)
    for d in days:
        r = m.run_daily(d, notify_summary=False)
    print(f"\nSimulated {len(days)} paper days. Last report: {r['report']}")
    for a in m.list_agents():
        print(f"   {a['id']} {a['name']:<24} equity={a['equity']}")


def main(argv=None) -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="tradeos", description="TradeOS: agentic research, backtest & paper trading (NSE)")
    p.add_argument("--home", help="data folder (default ./tradeos_data or $TRADEOS_HOME)")
    p.add_argument("--provider", help="yahoo | csv | synthetic (default $TRADEOS_PROVIDER or yahoo)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create the data folder and database")
    sub.add_parser("types", help="list sub-agent types, defaults and examples")
    sub.add_parser("chat", help="talk to the Main Agent (needs ANTHROPIC_API_KEY)")
    a = sub.add_parser("ask", help="one-shot instruction to the Main Agent")
    a.add_argument("text", nargs="+")
    sub.add_parser("demo", help="offline demo on synthetic data")

    c = sub.add_parser("create", help="create a sub-agent")
    c.add_argument("type")
    c.add_argument("--name", required=True)
    c.add_argument("--spec", help="path to JSON spec")
    c.add_argument("--json", help="inline JSON spec")
    c.add_argument("--backtest", action="store_true", help="backtest immediately")

    ls = sub.add_parser("list", help="list agents")
    ls.add_argument("--all", action="store_true")
    for name in ("show", "pause", "resume"):
        sub.add_parser(name).add_argument("id")
    d = sub.add_parser("destroy")
    d.add_argument("id")
    d.add_argument("--keep-positions", action="store_true")
    u = sub.add_parser("update", help="merge JSON into an agent's spec")
    u.add_argument("id")
    u.add_argument("--json", required=True)
    for name in ("add-symbols", "remove-symbols"):
        x = sub.add_parser(name)
        x.add_argument("id")
        x.add_argument("symbols", nargs="+")
    al = sub.add_parser("add-alert")
    al.add_argument("id")
    al.add_argument("--symbol", required=True)
    g = al.add_mutually_exclusive_group(required=True)
    g.add_argument("--above", type=float)
    g.add_argument("--below", type=float)
    g.add_argument("--expr")
    al.add_argument("--message")

    b = sub.add_parser("backtest")
    b.add_argument("id")
    b.add_argument("--start")
    b.add_argument("--end")
    dy = sub.add_parser("daily", help="run the daily paper cycle (schedule after 15:45 IST)")
    dy.add_argument("--date")
    rk = sub.add_parser("rank", help="relative strength ranking")
    rk.add_argument("--universe", default="sectors")
    rk.add_argument("--top", type=int)
    q = sub.add_parser("quote", help="price summary for a symbol")
    q.add_argument("symbol")
    cd = sub.add_parser("check-data", help="verify symbols resolve with the data provider")
    cd.add_argument("symbols", nargs="*")

    args = p.parse_args(argv)
    if args.cmd == "chat":
        return cmd_chat(args)
    if args.cmd == "demo":
        return cmd_demo(args)
    if args.cmd == "ask":
        from .brain import MainAgent
        print(MainAgent(_manager(args)).ask(" ".join(args.text)))
        return

    m = _manager(args)
    if args.cmd == "init":
        print(f"TradeOS ready at {m.settings.home} (provider={m.settings.provider})")
        print(f"Drop reports for research agents into {m.settings.inbox_dir}")
    elif args.cmd == "types":
        _p(m.agent_types())
    elif args.cmd == "create":
        a = m.create_agent(args.type, args.name, _spec(args))
        print(f"Created {a['type']} agent '{a['name']}' id={a['id']}")
        if args.backtest:
            bt = m.backtest(a["id"])
            _p({k: bt.get(k) for k in ("metrics", "benchmark_nifty", "output_folder", "alerts") if k in bt})
    elif args.cmd == "list":
        for a in m.list_agents(args.all):
            print(f"{a['id']}  {a['status']:<9} {a['type']:<15} {a['name']:<28} equity={a['equity']} "
                  f"last={a['last_processed']}")
    elif args.cmd == "show":
        _p(m.agent_report(args.id))
    elif args.cmd in ("pause", "resume"):
        _p(m.set_status(args.id, "paused" if args.cmd == "pause" else "active"))
    elif args.cmd == "destroy":
        _p(m.destroy_agent(args.id, liquidate=not args.keep_positions))
    elif args.cmd == "update":
        _p(m.update_agent(args.id, json.loads(args.json)))
    elif args.cmd == "add-symbols":
        _p(m.add_symbols(args.id, args.symbols))
    elif args.cmd == "remove-symbols":
        _p(m.remove_symbols(args.id, args.symbols))
    elif args.cmd == "add-alert":
        alert = {"symbol": args.symbol}
        for k in ("above", "below", "expr", "message"):
            if getattr(args, k) is not None:
                alert[k] = getattr(args, k)
        _p(m.add_alert(args.id, alert))
    elif args.cmd == "backtest":
        bt = m.backtest(args.id, args.start, args.end)
        _p({k: v for k, v in bt.items() if k != "recent_trades"})
    elif args.cmd == "daily":
        _p(m.run_daily(args.date))
    elif args.cmd == "rank":
        import pandas as pd
        print(pd.DataFrame(m.rank(args.universe, top=args.top)).to_string(index=False))
    elif args.cmd == "quote":
        _p(m.price_summary(args.symbol))
    elif args.cmd == "check-data":
        from .data.universe import INDICES, SECTORS, to_yahoo
        syms = args.symbols or (INDICES + SECTORS + ["INDIAVIX", "RELIANCE"])
        for s in syms:
            try:
                df = m.provider.history(s)
                print(f"OK    {s:<14} {to_yahoo(s):<22} {len(df)} bars, last {df.index[-1].date()}")
            except Exception as e:
                print(f"FAIL  {s:<14} {to_yahoo(s):<22} {e}")


if __name__ == "__main__":
    main()
