#!/usr/bin/env bash
# P1.26 测试 server 启动脚本（NODE_ENV=test 跳过限流；启动自动应用 023 迁移）
cd "$(dirname "$0")/../packages/server" || exit 1
export DATABASE_URL=$(grep '^DATABASE_URL' .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
export NODE_ENV=test
npx tsx src/index.ts > /c/Users/14431/AppData/Local/Temp/slock-p126-server.log 2>&1 &
sleep 14
curl -s http://localhost:3001/api/health
echo
grep -E "Migration|DB" /c/Users/14431/AppData/Local/Temp/slock-p126-server.log | tail -5
