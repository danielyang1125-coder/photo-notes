@echo off
REM Wrapper for WeChat DevTools CLI — needed because Node v24 spawn() cannot
REM execute .bat files directly (EINVAL error).
REM The miniprogram-automator library calls this as "cliPath".
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" %*
