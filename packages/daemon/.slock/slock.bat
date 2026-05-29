@echo off
set SLOCK_AGENT_ID=d2c974d8-a547-4b83-8d2d-94b90d85b530
set SLOCK_SERVER_URL=http://localhost:3001
set SLOCK_AGENT_TOKEN=sk_machine_ax2c72mex96l0xxanuzbi3c4ryx7fi4l
set SLOCK_AGENT_ACTIVE_CAPABILITIES=send,read,mentions,tasks,reactions,server,channels
npx tsx "D:\code\slock\packages\daemon\packages\daemon\src\cli.ts" %*