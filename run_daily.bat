@echo off
REM Daily paper-trading run. Schedule in Task Scheduler for weekdays 15:50 IST.
cd /d "%~dp0"
if not exist tradeos_data mkdir tradeos_data
.venv\Scripts\python -m tradeos daily >> tradeos_data\daily.log 2>&1
