# Alerts

`latest.json` is written by the daily job. When it changes, `.github/workflows/telegram.yml` sends it to Telegram if the repo secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
