#!/usr/bin/env bash
# P1.26：重启测试 server（tsx 无热重载，改代码后必须重启）并跑指定 vitest 文件。
# 用法：bash scripts/run-p126-restart-tests.sh [vitest 参数，如 test/agents-dispatch.test.ts]
for pid in $(netstat -ano | grep ":3001" | grep LISTENING | awk '{print $5}'); do
  taskkill //PID $pid //F 2>/dev/null
done
sleep 1
bash "$(dirname "$0")/run-p126-server.sh" > /dev/null 2>&1
cd "$(dirname "$0")/../packages/server" || exit 1
export DATABASE_URL=$(grep '^DATABASE_URL' .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
npx vitest run "$@"
