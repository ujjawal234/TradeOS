"""Notifications: console + log file always; Telegram when TELEGRAM_BOT_TOKEN/CHAT_ID are set."""
from __future__ import annotations

import logging
from datetime import datetime

log = logging.getLogger("tradeos.notify")


class Notifier:
    def __init__(self, settings, quiet: bool = False):
        self.settings = settings
        self.quiet = quiet
        self.logfile = settings.home / "notifications.log"

    def send(self, text: str) -> None:
        line = f"[{datetime.now():%Y-%m-%d %H:%M}] {text}"
        if not self.quiet:
            print(line)
        with open(self.logfile, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        self._telegram(text)

    def _telegram(self, text: str) -> None:
        tok, chat = self.settings.telegram_token, self.settings.telegram_chat_id
        if not (tok and chat):
            return
        try:
            import requests
            requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                          data={"chat_id": chat, "text": text[:4000]}, timeout=10)
        except Exception as e:  # never let a notification failure break a run
            log.warning("Telegram send failed: %s", e)
