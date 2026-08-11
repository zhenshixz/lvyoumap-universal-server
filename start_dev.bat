@echo off
chcp 65001 > nul
title Lvyoumap Universal Server (Hot Reload)
echo ===================================================
echo [INFO] 启动具有热更新机制的本地服务 (nodemon)
echo [INFO] 编码格式已设为 UTF-8，防止终端乱码
echo ===================================================
npx nodemon server/index.js
