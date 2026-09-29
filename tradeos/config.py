from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE per line). Existing env vars win."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


@dataclass
class Settings:
    home: Path
    provider: str = "yahoo"
    model: str = "claude-sonnet-5-5"
    anthropic_api_key: str | None = None
    telegram_token: str | None = None
    telegram_chat_id: str | None = None
    risk_free: float = 0.065  # annual; used for Sharpe and option pricing

    def _dir(self, name: str) -> Path:
        p = self.home / name
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def db_path(self) -> Path:
        return self.home / "tradeos.db"

    @property
    def cache_dir(self) -> Path:
        return self._dir("cache")

    @property
    def reports_dir(self) -> Path:
        return self._dir("reports")

    @property
    def backtests_dir(self) -> Path:
        return self._dir("backtests")

    @property
    def inbox_dir(self) -> Path:
        return self._dir("inbox")

    @property
    def csv_dir(self) -> Path:
        return self._dir("csv")


def get_settings(home: str | Path | None = None, provider: str | None = None) -> Settings:
    _load_dotenv(Path.cwd() / ".env")
    home_path = Path(home or os.environ.get("TRADEOS_HOME") or Path.cwd() / "tradeos_data").expanduser()
    home_path.mkdir(parents=True, exist_ok=True)
    return Settings(
        home=home_path,
        provider=provider or os.environ.get("TRADEOS_PROVIDER", "yahoo"),
        model=os.environ.get("TRADEOS_MODEL", "claude-sonnet-5-5"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        telegram_token=os.environ.get("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID"),
        risk_free=float(os.environ.get("TRADEOS_RISK_FREE", "0.065")),
    )
