@echo off
rem Build novel-reader plugin: compile TS then deploy main.js to plugin root
set TSC=C:\Users\sixco\.workbuddy\binaries\node\workspace\node_modules\typescript\bin\tsc
set NODE=C:\Users\sixco\.workbuddy\binaries\node\versions\22.22.2-3\node.exe
cd /d "%~dp0"
"%NODE%" "%TSC%" -p tsconfig.json || exit /b 1
copy /y dist\main.js main.js >nul
echo Build OK
