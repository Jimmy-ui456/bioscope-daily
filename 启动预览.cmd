@echo off
cd /d "%~dp0"
title BioScope Research Daily
echo BioScope - Local research daily prototype
echo Open http://127.0.0.1:4173 in your browser after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
echo.
node server.mjs
pause
