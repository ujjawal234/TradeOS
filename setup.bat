@echo off
REM One-time setup for TradeOS on Windows. Full output goes to setup_log.txt
cd /d "%~dp0"
set LOG=%~dp0setup_log.txt
echo TradeOS setup started %DATE% %TIME% > "%LOG%"

set PY=
py -3 --version >nul 2>&1 && set PY=py -3
if not defined PY python --version >nul 2>&1 && set PY=python
if not defined PY (
  echo [ERROR] Python 3.10+ not found. >> "%LOG%"
  echo Python 3.10+ not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run setup.bat again.
  pause
  exit /b 1
)
%PY% --version >> "%LOG%" 2>&1

echo [1/5] Creating virtual environment...
echo ===== venv ===== >> "%LOG%"
if not exist .venv %PY% -m venv .venv >> "%LOG%" 2>&1
if not exist .venv\Scripts\python.exe (echo [ERROR] venv failed, see setup_log.txt & echo [ERROR] venv failed >> "%LOG%" & pause & exit /b 1)

echo [2/5] Installing packages (a few minutes)...
echo ===== pip ===== >> "%LOG%"
.venv\Scripts\python -m pip install --upgrade pip >> "%LOG%" 2>&1
.venv\Scripts\python -m pip install -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 (echo [ERROR] pip install failed, see setup_log.txt & echo [ERROR] pip failed >> "%LOG%" & pause & exit /b 1)

if not exist .env copy .env.example .env >nul

echo [3/5] Initialising...
echo ===== init ===== >> "%LOG%"
.venv\Scripts\python -m tradeos init >> "%LOG%" 2>&1

echo [4/5] Running tests...
echo ===== tests ===== >> "%LOG%"
.venv\Scripts\python -m pytest -q tests >> "%LOG%" 2>&1

echo [5/5] Checking NSE data from Yahoo...
echo ===== check-data ===== >> "%LOG%"
.venv\Scripts\python -m tradeos check-data >> "%LOG%" 2>&1

echo ===== DONE ===== >> "%LOG%"
echo.
echo Setup finished. Results are in setup_log.txt
echo Next: open .env, paste your ANTHROPIC_API_KEY, then double-click chat.bat
pause
