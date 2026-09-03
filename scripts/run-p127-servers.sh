#!/usr/bin/env bash
# P1.27 双实例探针前置：起 A(3001)/B(3002) 两个 server 实例，共用同一 PG + Valkey。
# NODE_ENV=test 跳过限流；显式 VALKEY_URL 走 Redis 在线集合（多实例 presence 的实锤前提）；
# SLOCK_INSTANCE_ID 显式区分（metrics_samples.instance 列断言用）。
# 启动自动应用 024 迁移（index.ts runMigrations + P0.10 advisory lock 保证并发安全）。
cd "$(dirname "$0")/../packages/server" || exit 1
export DATABASE_URL=$(grep '^DATABASE_URL' .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
export NODE_ENV=test
export VALKEY_URL=redis://127.0.0.1:6379

PORT=3001 SLOCK_INSTANCE_ID=instA npx tsx src/index.ts > /c/Users/14431/AppData/Local/Temp/slock-p127-a.log 2>&1 &
sleep 14
curl -s http://localhost:3001/api/health
echo

PORT=3002 SLOCK_INSTANCE_ID=instB npx tsx src/index.ts > /c/Users/14431/AppData/Local/Temp/slock-p127-b.log 2>&1 &
sleep 14
curl -s http://localhost:3002/api/health
echo
