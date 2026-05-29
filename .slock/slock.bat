@echo off
set SLOCK_AGENT_ID=00000000-0000-0000-0000-000000000001
set SLOCK_SERVER_URL=http://localhost:3001
set SLOCK_AGENT_TOKEN=sk_machine_test
set SLOCK_AGENT_ACTIVE_CAPABILITIES=send,read,mentions,tasks,reactions,server,channels
node "D:\code\slock\packages\daemon\dist\cli\index.js" %*