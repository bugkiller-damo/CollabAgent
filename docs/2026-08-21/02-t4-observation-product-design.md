# Step 7 设计：T4 观察帧产品化（D4 并入）

> 日期：2026-08-21
> 方案依据：`docs/2026-08-20/01-daemon-evolution-plan.md` §D4、`docs/2026-08-19/01-buzz-borrowing-todo.md` T4
> 执行跟踪：`docs/2026-08-20/02-daemon-evolution-tracker.md` Step 7
> 用户确认：
> 1. T4 面板 + D4 频道进度都做；
> 2. 回合结束：agent 已 `send_message` → **删**进度条；reply-guard 代发 → **改写**成最终正文；分诊/巡检沉默 **不发**进度；
> 3. 频道进度默认开（`SLOCK_CHANNEL_PROGRESS=0` 关）；
> 4. 频道/DM/线程顶栏加紧凑「@agent 正在…」（消费 `agent:progress`，不必打开终端面板）。

---

## 0. 一句话

观察帧从调试事件流升为人类可读活动卡；同一聚合结果节流写成频道内一条 ⏳ 进度消息（原地 PUT），回合结束消掉或改写成答案；聊天顶栏另走瞬态 WS，不落库。

## 1. 数据流

```
stream-json → ObservationFrame（B1 已有）
           ├─ 侧栏 AgentObsStream（中文工具标签 + 当前 headline）
           ├─ agent:progress WS → 顶栏 AgentProgressBar（按频道）
           └─ createProgressTurn（2s 节流）
                POST /internal/agent/:id/send     首次
                PUT  /internal/agent/:id/messages/:id  更新
                DELETE 同上 或 PUT 改写为最终正文
```

## 2. 结束策略

| 回合结局 | 进度消息 |
|---|---|
| agent 自己 `send_message` | DELETE（硬删无回复；有回复则软删） |
| reply-guard 有正文 | PUT 改写成最终答案（少一条消息） |
| 分诊/巡检 / `isNudge` | 不发进度（`enabled: false`），仍推顶栏 |
| mid-turn 进程退出 | DELETE |

前缀 `⏳ `：D1 `packThreadContext` 丢弃；web 进度条删除不留「已删除」占位。

## 3. 开关

| 旋钮 | 默认 | env |
|---|---|---|
| 频道进度 | 开 | `SLOCK_CHANNEL_PROGRESS=0` 关 |
| 节流 | 2000ms | `SLOCK_PROGRESS_THROTTLE_MS` |

顶栏 `agent:progress` 不受频道进度开关影响。

## 4. 不做

- 不把 thinking 全文进频道（只短 headline + 最多 4 条工具）；
- 不写 `message_edits` / 审计（高频路径）；
- 不拆 (agent, thread) 进程池；
- 不改 PTY 冻结路径（无结构化帧，无进度条）。
