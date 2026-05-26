# Slock 前端 UI 架构方案

> 基于 daemon v0.53.2 逆向分析，为复现 Slock 平台提供前端设计参考

---

## 1. 技术栈建议

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | **React 19** + TypeScript | 与 Slock 生态对齐（pnpm monorepo），AI 代码生成质量最高 |
| 构建 | **Vite** | 快速 HMR、ESM 原生支持 |
| 样式 | **TailwindCSS** | 原子化 CSS，适合快速迭代 |
| 路由 | **React Router v7** | 支持嵌套布局、URL 参数 |
| 状态管理 | **Zustand** | 轻量、TS 友好、支持中间件（persist/devtools） |
| 实时通信 | **原生 WebSocket + 自定义 hook** | 与 daemon ws 库对齐，避免额外依赖 |
| Markdown | **react-markdown + rehype-highlight** | 消息体 Markdown 渲染 + 代码语法高亮 |
| 拖拽 | **@dnd-kit/core** | 任务看板拖拽，现代 API、可访问 |
| 表单 | **React Hook Form + Zod** | 设置/登录表单校验 |
| HTTP | **fetch + undici 模式**（参考 daemon） | 保持与 daemon 一致的请求模式 |

---

## 2. 路由设计

```
/login                          → 登录页
/register                       → 注册页
/channels                      → 频道列表（默认首页）
/channels/:channelName          → 频道消息视图
/dm/:peerName                   → DM 消息视图
/dm/:peerName/:threadId         → DM 线程视图
/channels/:channelName/:threadId → 频道线程视图
/tasks                         → 全局任务看板
/tasks/:channelName             → 频道任务看板
/settings                       → 设置页
/settings/profile               → 个人资料
/settings/integrations          → 第三方集成
/settings/notifications         → 通知设置
/admin                         → 管理后台（owner/admin）
/admin/channels                 → 频道管理
/admin/agents                   → Agent 管理
/admin/members                  → 成员管理
```

### 路由守卫

```typescript
// 认证守卫
<Routes>
  <Route element={<AuthGuard />}>
    <Route element={<AppLayout />}>
      <Route path="/channels" element={<ChannelList />} />
      <Route path="/channels/:channelName" element={<ChannelView />} />
      {/* ... */}
    </Route>
  </Route>
  <Route path="/login" element={<LoginPage />} />
</Routes>
```

---

## 3. 组件树

### 3.1 顶层布局

```
<App>
├── <AuthProvider>                    // 认证上下文
├── <WebSocketProvider>               // WebSocket 连接管理
├── <StoreProvider>                   // Zustand store
├── <AppLayout>
│   ├── <Sidebar>                     // 左侧导航
│   │   ├── <ServerSwitcher>          // 多服务器切换
│   │   ├── <WorkspaceSection>        // 频道列表
│   │   │   ├── <ChannelListItem>      // 单个频道项 (×N)
│   │   │   └── <CreateChannelButton>
│   │   ├── <DmSection>               // 私信列表
│   │   │   ├── <DmListItem>          // 单个 DM 项 (×N)
│   │   │   └── <NewDmButton>
│   │   ├── <TaskBoardLink>           // 任务看板入口
│   │   └── <UserArea>                // 用户信息/设置
│   │       ├── <UserAvatar>
│   │       ├── <UserName>
│   │       └── <SettingsButton>
│   ├── <MainContent>                 // 主内容区 (路由出口)
│   └── <RightSidebar> (可选)          // 右侧面板
│       ├── <ChannelMemberList>       // 频道成员列表
│       └── <ChannelTaskPreview>      // 频道任务预览
```

### 3.2 频道/DM 视图

```
<ChannelView> (or <DmView>)
├── <MessageHeader>
│   ├── <ChannelName> (or <PeerName>)  // "#general" / "@alice"
│   ├── <ChannelDescription>           // 频道描述
│   ├── <MemberCount>                  // 成员数
│   ├── <StarButton>                   // 收藏
│   └── <ChannelSettingsButton>        // 频道设置 (owner/admin)
├── <MessageList>                     // 虚拟滚动消息列表
│   ├── <InfiniteScrollLoader>        // 上拉加载更多
│   ├── <MessageGroup>                // 消息组 (同一发送者合并)
│   │   ├── <MessageItem>            // 单条消息 (×N)
│   │   │   ├── <MessageAvatar>
│   │   │   ├── <MessageBubble>
│   │   │   │   ├── <MessageSender>
│   │   │   │   ├── <MessageContent>  // Markdown 渲染
│   │   │   │   ├── <AttachmentPreview>
│   │   │   │   ├── <ThreadJoinContext> // 线程加入上下文
│   │   │   │   └── <TaskBadge>       // 任务标记 [task #3 in_progress]
│   │   │   ├── <MessageActions>      // hover 显示
│   │   │   │   ├── <ReactButton>
│   │   │   │   ├── <ReplyInThreadButton>
│   │   │   │   └── <MoreActionsMenu>
│   │   │   ├── <Reactions>           // 消息反应 emoji
│   │   │   └── <ThreadPreview>       // 线程回复预览 (N replies)
│   │   └── <DateSeparator>           // 日期分隔符
│   └── <NewMessagesIndicator>        // "N new messages" 浮动提示
├── <MessageComposer>
│   ├── <AttachmentBar>              // 已选附件预览
│   ├── <TextArea>                    // 消息输入 (支持 Markdown)
│   ├── <MentionPopover>             // @提及弹窗
│   ├── <AttachmentButton>
│   ├── <FormatToolbar>              // Markdown 快捷工具栏
│   └── <SendButton>
└── <ThreadPanel> (条件渲染)           // 线程侧面板
    ├── <ThreadHeader>
    │   └── <ParentMessage>
    ├── <ThreadMessageList>
    └── <ThreadComposer>
```

### 3.3 线程视图

```
<ThreadView>
├── <ThreadHeader>
│   ├── <ThreadTitle>                 // "Thread in #general"
│   ├── <ParentChannelLink>           // 跳回父频道
│   └── <ThreadActions>
├── <ParentMessageCard>               // 父消息卡片（始终可见）
│   ├── <MessageSender>
│   ├── <MessageContent>
│   ├── <MessageTimestamp>
│   └── <TaskInfo> (if task)
├── <MessageList>                     // 线程回复列表
│   └── <MessageItem> (×N)
├── <MessageComposer>                 // 线程回复框
└── <ThreadSidebar>
    ├── <ThreadReplyCount>
    ├── <ThreadActivity>              // 回复动态
    └── <QuickJumpToLatest>
```

### 3.4 任务看板

```
<TaskBoard>
├── <TaskBoardHeader>
│   ├── <Breadcrumb>                  // #channel → Tasks
│   ├── <FilterBar>
│   │   ├── <StatusFilter>           // 全部/todo/in_progress/in_review/done
│   │   ├── <AssigneeFilter>         // 按负责人筛选
│   │   └── <SearchBox>
│   ├── <ViewToggle>                 // 看板/列表视图切换
│   └── <CreateTaskButton>
├── <KanbanBoard> (看板视图)
│   ├── <KanbanColumn status="todo">
│   │   ├── <ColumnHeader>
│   │   │   ├── <StatusIcon>
│   │   │   ├── <ColumnTitle>        // "Todo"
│   │   │   └── <TaskCount>
│   │   └── <TaskCard> (×N)           // 可拖拽
│   │       ├── <TaskNumber>          // "#3"
│   │       ├── <TaskTitle>
│   │       ├── <TaskAssignee>
│   │       ├── <TaskPriority>
│   │       ├── <TaskLabels>
│   │       └── <TaskThreadPreview>
│   ├── <KanbanColumn status="in_progress">
│   ├── <KanbanColumn status="in_review">
│   └── <KanbanColumn status="done">
└── <TaskDetail> (点击弹出/侧面板)
    ├── <TaskHeader>                  // 任务标题 + 编号
    ├── <TaskMetadata>                // 状态、负责人、创建时间
    ├── <TaskStatusFlow>              // 状态流转按钮
    │   ├── <StartButton>            // → in_progress
    │   ├── <ReviewButton>           // → in_review
    │   ├── <ApproveButton>          // → done (人工确认)
    │   └── <ReopenButton>           // → todo
    ├── <TaskClaimButton>             // Claim / Unclaim
    ├── <TaskDescription>             // 任务描述 (Markdown)
    └── <TaskThread>                  // 任务讨论线程
```

### 3.5 设置页面

```
<SettingsLayout>
├── <SettingsNav>
│   ├── <NavItem to="profile">个人资料</NavItem>
│   ├── <NavItem to="notifications">通知</NavItem>
│   ├── <NavItem to="integrations">集成</NavItem>
│   └── (admin) <NavItem to="admin">管理</NavItem>
├── <SettingsContent>
│   ├── <ProfileSettings>
│   │   ├── <AvatarUpload>
│   │   ├── <DisplayNameInput>
│   │   ├── <DescriptionInput>
│   │   └── <SaveButton>
│   ├── <IntegrationSettings>
│   │   ├── <ServiceList>
│   │   └── <ServiceLoginButton>
│   └── <AdminPanel> (owner/admin)
│       ├── <ChannelManagement>
│       │   ├── <CreateChannelForm>
│       │   └── <ChannelList>
│       ├── <AgentManagement>
│       │   ├── <CreateAgentForm>
│       │   └── <AgentList>
│       └── <MemberManagement>
│           ├── <InviteMemberForm>
│           └── <MemberRoleEditor>
```

### 3.6 登录/注册

```
<LoginPage>
├── <LoginForm>
│   ├── <EmailInput>
│   ├── <PasswordInput>
│   └── <LoginButton>
├── <OAuthButtons>                    // GitHub / Google 登录
└── <RegisterLink>

<RegisterPage>
├── <RegisterForm>
│   ├── <NameInput>
│   ├── <EmailInput>
│   ├── <PasswordInput>
│   └── <RegisterButton>
└── <LoginLink>
```

---

## 4. 状态管理设计

### 4.1 Store 架构 (Zustand)

```typescript
// stores/authStore.ts
interface AuthState {
  user: User | null;
  token: string | null;
  machineToken: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithOAuth: (provider: string) => Promise<void>;
  logout: () => void;
  refreshToken: () => Promise<void>;
}

// stores/channelStore.ts
interface ChannelState {
  channels: Channel[];
  joinedChannels: Set<string>;
  activeChannelId: string | null;
  unreadCounts: Record<string, number>;      // channel → unread count
  fetchChannels: () => Promise<void>;
  joinChannel: (name: string) => Promise<void>;
  leaveChannel: (name: string) => Promise<void>;
  markRead: (channelId: string) => void;
  setActiveChannel: (id: string) => void;
}

// stores/messageStore.ts
interface MessageState {
  messagesByTarget: Record<string, Message[]>; // target → messages
  pendingMessages: Message[];                   // 待确认发送
  lastSeenSeq: Record<string, number>;          // 已读位置
  fetchHistory: (target: string, opts?: PaginationOpts) => Promise<void>;
  sendMessage: (target: string, content: string, attachments?: string[]) => Promise<void>;
  receiveMessage: (message: Message) => void;    // WebSocket 推送
  searchMessages: (query: string, filters?: SearchFilters) => Promise<Message[]>;
  addReaction: (messageId: string, emoji: string) => Promise<void>;
  removeReaction: (messageId: string, emoji: string) => Promise<void>;
}

// stores/taskStore.ts
interface TaskState {
  tasksByChannel: Record<string, Task[]>;
  taskDetail: Task | null;
  fetchTasks: (channel: string, status?: TaskStatus) => Promise<void>;
  createTask: (channel: string, title: string) => Promise<void>;
  claimTasks: (channel: string, taskNumbers: number[]) => Promise<void>;
  unclaimTask: (channel: string, taskNumber: number) => Promise<void>;
  updateTaskStatus: (channel: string, taskNumber: number, status: TaskStatus) => Promise<void>;
  setTaskDetail: (task: Task | null) => void;
}

// stores/dmStore.ts
interface DmState {
  dmList: DmConversation[];
  activeDmId: string | null;
  fetchDmList: () => Promise<void>;
  setActiveDm: (peerName: string) => void;
}

// stores/profileStore.ts
interface ProfileState {
  profiles: Record<string, Profile>;   // handle → profile
  myProfile: Profile | null;
  fetchProfile: (handle: string) => Promise<Profile>;
  updateProfile: (updates: Partial<Profile>) => Promise<void>;
  uploadAvatar: (file: File) => Promise<string>;
}

// stores/reminderStore.ts
interface ReminderState {
  reminders: Reminder[];
  fetchReminders: (opts?: { status?: string[] }) => Promise<void>;
  scheduleReminder: (opts: ReminderScheduleOpts) => Promise<void>;
  snoozeReminder: (id: string, by: string) => Promise<void>;
  updateReminder: (id: string, updates: Partial<ReminderUpdate>) => Promise<void>;
  cancelReminder: (id: string) => Promise<void>;
  getReminderLog: (id: string) => Promise<ReminderEvent[]>;
}

// stores/integrationStore.ts
interface IntegrationState {
  services: Service[];
  activeLogins: ActiveLogin[];
  fetchServices: () => Promise<void>;
  login: (serviceId: string, scopes?: string[]) => Promise<void>;
}

// stores/uiStore.ts
interface UiState {
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  threadPanelOpen: boolean;
  activeThreadId: string | null;
  theme: 'light' | 'dark' | 'system';
  toggleSidebar: () => void;
  openThread: (messageId: string) => void;
  closeThread: () => void;
  setTheme: (theme: UiState['theme']) => void;
}
```

### 4.2 数据流

```
┌─────────────────────────────────────────────────────┐
│                    WebSocket                         │
│   ws://api.slock.ai/daemon/connect?key=...          │
└──────────────┬──────────────────────────────────────┘
               │ JSON messages
               ▼
┌──────────────────────────────────────────────────────┐
│              WebSocketProvider                        │
│  - 连接生命周期管理 (connect/reconnect/disconnect)     │
│  - 消息反序列化 + 类型路由                             │
│  - Ack 机制 (seq 确认)                                │
│  - Inbound watchdog (70s 无消息 → 强制重连)            │
│  - 离线消息补拉 (since=lastSeenSeq)                    │
└──────────────┬───────────────────────────────────────┘
               │ message dispatch
               ▼
┌──────────────────────────────────────────────────────┐
│              Message Router                           │
│  switch (message.type):                              │
│    case "agent:deliver" → messageStore.receive()      │
│    case "reminder.upsert" → reminderStore.upsert()    │
│    case "reminder.cancel" → reminderStore.remove()    │
│    case "agent:status" → statusStore.update()         │
│    ...                                               │
└──────────────┬───────────────────────────────────────┘
               │ store updates
               ▼
┌──────────────────────────────────────────────────────┐
│              Zustand Stores → React Components        │
│  useAuthStore()  useMessageStore()  useTaskStore()    │
│  useChannelStore()  useUiStore()  ...                │
└──────────────────────────────────────────────────────┘
```

### 4.3 关键数据流场景

**发送消息：**
```
User types → MessageComposer (local state)
  → onSend → messageStore.sendMessage(target, content)
    → POST /internal/agent-api/send
      → freshness check (hadNewerMessages?)
        → "held" → 回显未读消息 + 用户确认重发
        → "sent" → messageSeq 确认
          → WebSocket 广播 agent:deliver (包含 seq)
            → messageStore.receiveMessage() 更新 UI
```

**接收消息：**
```
WebSocket → agent:deliver { seq, message }
  → messageStore.receiveMessage(message)
    → 按 target 追加到 messagesByTarget
    → 判断是否在当前视图
      → 是 → 直接渲染 + 更新 lastSeenSeq + send ack
      → 否 → 更新未读计数 + send ack
```

**任务状态变更：**
```
User → drag task card to new column / click status button
  → taskStore.updateTaskStatus(channel, taskNumber, status)
    → POST /internal/agent-api/tasks/update-status
      → server validates transition (todo→in_progress, etc.)
      → success → optimistic update confirmed
      → failure → rollback optimistic update + show error
```

---

## 5. WebSocket 实时通信层设计

### 5.1 useWebSocket Hook

```typescript
// hooks/useWebSocket.ts
interface WebSocketHook {
  isConnected: boolean;
  lastMessage: ServerMessage | null;
  connect: () => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  reconnectAttempt: number;
}

function useWebSocket(options: {
  serverUrl: string;
  apiKey: string;
  onMessage: (msg: ServerMessage) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  minReconnectDelayMs?: number;   // 默认 1000ms
  maxReconnectDelayMs?: number;   // 默认 30000ms
  inboundWatchdogMs?: number;     // 默认 70000ms
}): WebSocketHook
```

### 5.2 连接管理

```
                     ┌──────────┐
          ┌─────────→│ CONNECTED │←────────────┐
          │          └─────┬─────┘             │
          │                │                    │
          │          onOpen / onMessage         │
          │          (重置 reconnectAttempt)     │
          │                │                    │
     ┌────┴─────┐    ┌────┴─────┐         ┌────┴─────┐
     │RECONNECT │    │ WATCHDOG │          │  CLOSED  │
     │SCHEDULED │    │ (70s无消息)│         │ (主动断开) │
     └────┬─────┘    └────┬─────┘         └──────────┘
          │               │
          │          ws.terminate()
          │               │
          └─────┬─────────┘
                │
          reconnectTimer
          (exp backoff 1s→2s→4s→...→30s)
                │
                ▼
          doConnect()
```

### 5.3 消息类型路由

```typescript
// websocket/messageRouter.ts
type ServerMessageHandler = (msg: ServerMessage) => void;

const messageRouter: Record<string, ServerMessageHandler> = {
  'agent:deliver': (msg) => messageStore.handleDelivery(msg),
  'agent:start': (msg) => agentStore.handleStart(msg),
  'agent:stop': (msg) => agentStore.handleStop(msg),
  'agent:status': (msg) => statusStore.handleAgentStatus(msg),
  'reminder.upsert': (msg) => reminderStore.upsert(msg.reminder),
  'reminder.cancel': (msg) => reminderStore.remove(msg.reminderId),
  'reminder.snapshot': (msg) => reminderStore.setSnapshot(msg),
  'ping': () => connection.send({ type: 'pong' }),
};
```

### 5.4 离线/重连策略

```
1. WebSocket close (非主动)
   → 状态标记为 disconnected
   → UI 显示连接断开提示（顶部 banner）
   → scheduleReconnect(): 指数退避重连 (1s→2s→4s→...→30s max)

2. Watchdog 超时 (70s 无入站消息)
   → ws.terminate()
   → scheduleReconnect()

3. 重连成功
   → ready message 发送
   → 拉取 lastSeenSeq 之后的离线消息:
     GET /internal/agent-api/events?since={lastSeenSeq}&limit=200
   → 合并到 messageStore
   → 更新未读计数

4. 用户切回页面 (visibilitychange)
   → 检查连接状态
   → 断线 → 立即重连
   → 连接中 → 拉取离线消息
```

### 5.5 HTTP 服务降级

```typescript
// 当 WebSocket 不可用时，退化为轮询
class MessagePoller {
  private pollInterval = 5000;
  private timer: number | null;

  start() {
    this.timer = setInterval(async () => {
      const events = await fetch(
        `/internal/agent-api/events?since=${lastSeenSeq}&limit=50`
      );
      events.forEach(msg => messageRouter[msg.type]?.(msg));
    }, this.pollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
```

---

## 6. 消息渲染

### 6.1 Markdown 支持

```typescript
// components/message/MessageContent.tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm, remarkBreaks]}
  rehypePlugins={[rehypeHighlight, rehypeSanitize]}
  components={{
    // @mention 高亮
    a: ({ href, children }) => {
      if (href?.startsWith('@')) {
        return <MentionLink handle={href.slice(1)} />;
      }
      if (href?.startsWith('#')) {
        return <ChannelLink target={href} />;
      }
      return <ExternalLink href={href}>{children}</ExternalLink>;
    },
    // 代码块
    code: ({ className, children, ...props }) => {
      const match = /language-(\w+)/.exec(className || '');
      return match ? (
        <CodeBlock language={match[1]} code={String(children)} />
      ) : (
        <InlineCode {...props}>{children}</InlineCode>
      );
    },
    // 内联渲染: @alice → Mention 组件
    text: ({ children }) => {
      return <InlineParser text={String(children)} />;
    }
  }}
/>
```

### 6.2 内联解析规则

```
#general          → 链接到频道
#general:abc123   → 链接到线程
@alice            → 链接到用户资料
task #42          → 链接到任务
@slock-frontend   → 链接到 Agent

URL 自动识别:
http://...       → 可点击链接
非 ASCII 文本后的 URL → 用 <url> 包裹防止标点吞入
```

### 6.3 附件预览

```typescript
// components/message/AttachmentPreview.tsx
function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  if (attachment.mimeType?.startsWith('image/')) {
    return (
      <Lightbox>
        <img src={attachmentUrl(attachment.id)} alt={attachment.filename} />
      </Lightbox>
    );
  }

  return (
    <FileCard>
      <FileIcon mimeType={attachment.mimeType} />
      <FileName>{attachment.filename}</FileName>
      <FileSize>{formatBytes(attachment.sizeBytes)}</FileSize>
      <DownloadButton attachmentId={attachment.id} />
    </FileCard>
  );
}
```

### 6.4 消息组

同一发送者在短时间内（< 5 分钟）的连续消息合并显示，隐藏重复头像和发送者名：

```
┌─────────────────────────────────────────┐
│ [Avatar] @alice                    10:30 │  ← 第一条：显示头像+名字
│ 你好，我来看看这个 bug                    │
│                                         │
│ 看起来是 WebSocket 重连的问题             │  ← 后续：只显示消息内容
│                                         │
│ [Avatar] @bob                      10:35 │  ← 新发送者：显示头像+名字
│ 对，我修一下                             │
└─────────────────────────────────────────┘
```

### 6.5 线程加入上下文

当用户通过链接进入线程时，父消息卡片显示：

```
┌─ Thread in #general ────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ @alice  Tue 10:30                   │ │
│ │ Fix the login bug [task #3 done]   │ │
│ │ 这个问题我来修                        │ │
│ └─────────────────────────────────────┘ │
│ ─────────────────────────────────────── │
│ ┌─ @bob  Tue 10:35 ──────────────────┐ │
│ │ 修好了，PR 在这里                     │ │
│ └─────────────────────────────────────┘ │
│ ┌─ @alice  Tue 10:36 ────────────────┐ │
│ │ LGTM, merge 了                       │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## 7. 任务 UI 设计

### 7.1 看板视图

```
┌─ Todo (3) ─────┐ ┌─ In Progress (2) ┐ ┌─ In Review (1) ┐ ┌─ Done (12) ────┐
│ ┌────────────┐  │ │ ┌──────────────┐ │ │ ┌────────────┐ │ │ ┌────────────┐  │
│ │ #1 登录页面 │  │ │ │ #3 WebSocket │ │ │ │ #5 PR 审核  │ │ │ │ #2 数据库   │  │
│ │ @alice     │  │ │ │   重连实现    │ │ │ │ @bob        │ │ │ │   schema    │  │
│ │ ────────   │  │ │ │ @alice       │ │ │ │ ────────    │ │ │ │ ────────    │  │
│ │ 3 replies  │  │ │ │ ────────     │ │ │ │ 5 replies   │ │ │ │ 8 replies   │  │
│ └────────────┘  │ │ └──────────────┘ │ │ └────────────┘ │ │ └────────────┘  │
│ ┌────────────┐  │ │ ┌──────────────┐ │ │                │ │ ┌────────────┐  │
│ │ #4 附件上传  │  │ │ │ #6 API 接口  │ │ │                │ │ │ #0 项目初始化 │  │
│ │ 未分配      │  │ │ │ @slock-front │ │ │                │ │ │ @alice      │  │
│ │ ────────   │  │ │ │ ────────     │ │ │                │ │ │ ────────    │  │
│ │ 1 reply    │  │ │ │ 2 replies    │ │ │                │ │ │ done        │  │
│ └────────────┘  │ │ └──────────────┘ │ │                │ │ └────────────┘  │
│ ┌────────────┐  │ │                 │ │                │ │                 │
│ │ #7 通知系统  │  │ │                 │ │                │ │                 │
│ │ 未分配      │  │ │                 │ │                │ │                 │
│ └────────────┘  │ │                 │ │                │ │                 │
└─────────────────┘ └─────────────────┘ └────────────────┘ └─────────────────┘
```

### 7.2 拖拽交互

```typescript
// 使用 @dnd-kit/core
<DndContext
  onDragEnd={async (event) => {
    const { active, over } = event;
    const taskNumber = active.data.current.taskNumber;
    const newStatus = over.data.current.status; // 目标列
    // optimistic update
    taskStore.updateTaskStatus(channel, taskNumber, newStatus);
  }}
  collisionDetection={closestCenter}
  modifiers={[restrictToHorizontalAxis]}
>
  {statuses.map(status => (
    <SortableContext items={tasksByStatus[status]}>
      <KanbanColumn status={status}>
        {tasks.map(task => (
          <TaskCard key={task.number} task={task} />
        ))}
      </KanbanColumn>
    </SortableContext>
  ))}
</DndContext>
```

### 7.3 状态流转规则

```
todo ──→ in_progress ──→ in_review ──→ done
  ↑         │                │            │
  └─────────┴────────────────┴────────────┘  (reopen)

流转约束:
- todo → in_progress: 任何人可以 claim 后开始
- in_progress → in_review: 当前 assignee
- in_review → done: human 确认 (admin/reviewer)
- 任意状态 → todo: admin 可以 reopen
- done 状态不能 unclaim
```

### 7.4 批量操作

```typescript
// 多选模式
<BulkActionBar visible={selectedTasks.length > 0}>
  <span>{selectedTasks.length} selected</span>
  <Button onClick={bulkClaim}>Claim All</Button>
  <Button onClick={bulkMove}>Move to...</Button>
  <Button onClick={bulkAssign}>Assign to...</Button>
</BulkActionBar>
```

---

## 8. Action Card 审批流

```
┌─────────────────────────────────────────┐
│ ⚡ Action Card: Create Channel           │
│                                         │
│ Channel Name: #engineering              │
│ Visibility: Private                     │
│ Initial Members: @alice, @bob          │
│                                         │
│ Requested by: @slock-frontend (agent)   │
│                                         │
│ [Approve]  [Reject]  [Modify...]       │
└─────────────────────────────────────────┘
```

Agent 通过 `slock action prepare` 发出，前端渲染为可交互的审批卡片，human 点击 Approve 后执行（创建频道、创建 agent、添加成员）。

---

## 9. 性能考量

### 9.1 虚拟滚动

消息列表使用虚拟滚动（react-virtuoso），处理大量历史消息：

```typescript
<Virtuoso
  data={messages}
  itemContent={(index, message) => <MessageItem message={message} />}
  initialTopMostItemIndex={messages.length - 1}  // 从最新开始
  followOutput="smooth"                          // 新消息平滑滚动
  atBottomStateChange={(atBottom) => setAtBottom(atBottom)}
/>
```

### 9.2 消息分页

- 首次加载最近 50 条
- 向上滚动触发 `GET /internal/agent-api/history?channel=...&before={oldestSeq}&limit=50`
- 使用 `useInfiniteQuery` (TanStack Query) 管理分页缓存

### 9.3 频道列表优化

- 未读计数：WebSocket 推送更新 + Zustand store
- 频道成员列表：懒加载（展开时才请求 `slock channel members`）
- 活跃状态：通过 `agent:status` WebSocket 消息实时更新

---

## 10. 错误处理

### 10.1 全局错误边界

```typescript
<ErrorBoundary
  fallback={({ error, reset }) => (
    <ErrorPage>
      <h2>Something went wrong</h2>
      <pre>{error.message}</pre>
      <button onClick={reset}>Try again</button>
    </ErrorPage>
  )}
>
  <App />
</ErrorBoundary>
```

### 10.2 API 错误码处理

```typescript
// 对应 CLI 错误码体系
const ERROR_HANDLERS = {
  MISSING_TOKEN: () => redirectToLogin(),
  INVALID_AGENT_PROXY_TOKEN: () => authStore.logout(),
  UPDATE_FAILED: (msg) => toast.error(msg),
  CLAIM_CONFLICT: () => toast.warning('Task already claimed by someone else'),
  SERVER_5XX: () => retryWithBackoff(),
};
```

### 10.3 发送失败处理

- 乐观更新（先显示消息，标记为 "sending"）
- 发送失败 → 显示重试按钮 + 错误信息
- Draft 模式：消息保存为草稿，用户可稍后重发

---

## 11. 实施优先级

### Phase 1: MVP 核心（3–4 周）

| 功能 | 优先级 | 说明 |
|---|---|---|
| 登录/注册 | P0 | 认证基础 |
| 频道列表 + 消息视图 | P0 | 核心聊天功能 |
| DM 对话 | P0 | 一对一私信 |
| 消息发送/接收 | P0 | 文本 + Markdown |
| WebSocket 连接 | P0 | 实时消息推送 |
| 线程视图 | P0 | 从消息开启/回复线程 |
| 基础任务看板 | P1 | 列表视图 + 状态流转 |

### Phase 2: 完善体验（1–2 周）

| 功能 | 优先级 | 说明 |
|---|---|---|
| 文件附件上传/预览 | P1 | 图片预览 + 文件下载 |
| @提及高亮 + 自动补全 | P1 | 频道/用户链接 |
| 消息搜索 | P1 | 全文+过滤 |
| 离线重连 | P1 | 断线恢复 |
| 未读计数 | P1 | 频道/线程红点 |
| 消息反应 | P2 | Emoji 反应 |
| 代码高亮 | P2 | 语法着色 |

### Phase 3: 增强功能（2–3 周）

| 功能 | 优先级 | 说明 |
|---|---|---|
| 任务看板拖拽 | P2 | Kanban 视图 |
| Action Card 审批 | P2 | Agent 操作确认卡片 |
| 第三方集成登录 | P2 | OAuth 流程 |
| 设置页面 | P2 | 资料/通知/集成管理 |
| 管理后台 | P3 | 频道/Agent/成员管理 |
| 提醒管理 UI | P3 | 创建/查看/管理提醒 |

---

## 12. 项目结构建议

```
slock-web/
├── src/
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppLayout.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── RightSidebar.tsx
│   │   ├── channel/
│   │   │   ├── ChannelView.tsx
│   │   │   ├── ChannelList.tsx
│   │   │   └── ChannelListItem.tsx
│   │   ├── message/
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageItem.tsx
│   │   │   ├── MessageComposer.tsx
│   │   │   ├── MessageContent.tsx
│   │   │   ├── AttachmentPreview.tsx
│   │   │   ├── ThreadPreview.tsx
│   │   │   ├── ReactionBar.tsx
│   │   │   └── DateSeparator.tsx
│   │   ├── thread/
│   │   │   ├── ThreadView.tsx
│   │   │   └── ThreadPanel.tsx
│   │   ├── task/
│   │   │   ├── TaskBoard.tsx
│   │   │   ├── TaskCard.tsx
│   │   │   ├── KanbanColumn.tsx
│   │   │   ├── TaskDetail.tsx
│   │   │   └── BulkActionBar.tsx
│   │   ├── dm/
│   │   │   ├── DmView.tsx
│   │   │   └── DmList.tsx
│   │   ├── settings/
│   │   │   ├── SettingsLayout.tsx
│   │   │   ├── ProfileSettings.tsx
│   │   │   ├── IntegrationSettings.tsx
│   │   │   └── AdminPanel.tsx
│   │   ├── action/
│   │   │   └── ActionCard.tsx
│   │   ├── auth/
│   │   │   ├── LoginForm.tsx
│   │   │   └── RegisterForm.tsx
│   │   ├── markdown/
│   │   │   ├── InlineParser.tsx
│   │   │   ├── CodeBlock.tsx
│   │   │   ├── MentionLink.tsx
│   │   │   └── ChannelLink.tsx
│   │   └── shared/
│   │       ├── Avatar.tsx
│   │       ├── UserBadge.tsx
│   │       ├── ErrorBoundary.tsx
│   │       ├── LoadingSpinner.tsx
│   │       ├── ConnectionStatus.tsx
│   │       └── VirtualScroll.tsx
│   ├── hooks/
│   │   ├── useWebSocket.ts
│   │   ├── useMessages.ts
│   │   ├── useChannels.ts
│   │   ├── useTasks.ts
│   │   ├── useMentions.ts
│   │   └── useConnectionStatus.ts
│   ├── stores/
│   │   ├── authStore.ts
│   │   ├── messageStore.ts
│   │   ├── channelStore.ts
│   │   ├── taskStore.ts
│   │   ├── dmStore.ts
│   │   ├── profileStore.ts
│   │   ├── reminderStore.ts
│   │   ├── integrationStore.ts
│   │   └── uiStore.ts
│   ├── websocket/
│   │   ├── connection.ts
│   │   ├── messageRouter.ts
│   │   └── types.ts
│   ├── api/
│   │   ├── client.ts              // HTTP client (fetch wrapper)
│   │   ├── messages.ts
│   │   ├── channels.ts
│   │   ├── tasks.ts
│   │   ├── auth.ts
│   │   ├── profile.ts
│   │   ├── attachments.ts
│   │   ├── reminders.ts
│   │   └── integrations.ts
│   ├── types/
│   │   ├── message.ts
│   │   ├── channel.ts
│   │   ├── task.ts
│   │   ├── user.ts
│   │   ├── reminder.ts
│   │   ├── attachment.ts
│   │   └── websocket.ts
│   ├── utils/
│   │   ├── formatting.ts          // 时间格式化、字节大小
│   │   ├── targetParser.ts        // #channel / dm:@peer 解析
│   │   ├── seq.ts                 // 消息序列号处理
│   │   └── markdown.ts            // Markdown 渲染配置
│   ├── router.tsx
│   ├── App.tsx
│   └── main.tsx
├── public/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

---

## 13. 关键数据模型 TypeScript 定义

```typescript
// types/message.ts
interface Message {
  message_id: string;
  id?: string;
  seq: number;
  channel_id: string;
  channel_name: string;
  channel_type: 'channel' | 'dm' | 'thread';
  parent_channel_name?: string;
  parent_channel_type?: 'channel' | 'dm';
  sender_id: string;
  sender_name: string;
  sender_type: 'human' | 'agent' | 'system';
  sender_description?: string | null;
  content: string;
  timestamp: string;       // ISO 8601
  traceparent?: string;
  attachments?: Attachment[];
  task_status?: string;
  task_number?: number;
  task_assignee_id?: string;
  task_assignee_type?: string;
  thread_join_context?: ThreadJoinContext;
  errors?: string[];
  result?: string;
  reactions?: Reaction[];
}

// types/task.ts
type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';

interface Task extends Message {
  task_number: number;
  task_status: TaskStatus;
  task_assignee_id?: string;
  task_assignee_type?: 'human' | 'agent';
}

// types/channel.ts
interface Channel {
  id: string;
  name: string;
  description?: string;
  visibility: 'public' | 'private';
  joined: boolean;
  memberCount?: number;
  unreadCount: number;
  lastMessage?: Message;
}

// types/user.ts
interface User {
  id: string;
  name: string;            // handle like "alice"
  displayName: string;
  description?: string;
  avatarUrl?: string;
  type: 'human' | 'agent';
  isOnline?: boolean;
  role?: 'owner' | 'admin' | 'member';
}

// types/attachment.ts
interface Attachment {
  id: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
}

// types/reminder.ts
interface Reminder {
  reminderId: string;
  version: number;
  ownerAgentId: string;
  fireAt: string;          // ISO 8601
  title: string;
  status: 'scheduled' | 'fired' | 'canceled';
  repeat?: string;         // "every:15m" | "daily@09:00" etc.
  channelRef?: string;
  anchorMsgId?: string;
}
```

---

## 附录 A: 与 Daemon 的 HTTP 代理模式对照

前端直接请求 REST API，不走 daemon proxy（daemon proxy 是为 agent CLI 设计的本地代理）：

| 操作 | CLI (via daemon proxy) | 前端 (direct REST API) |
|---|---|---|
| 发送消息 | `POST /internal/agent-api/send` | `POST /api/messages` (推测) |
| 读取历史 | `GET /internal/agent-api/history?channel=...&before=...` | `GET /api/messages?channel=...&before=...` (推测) |
| 拉取事件 | `GET /internal/agent-api/events?since=...` | WebSocket 替代 |
| Claim 任务 | `POST /internal/agent-api/tasks/claim` | `POST /api/tasks/{number}/claim` (推测) |
| 更新任务 | `POST /internal/agent-api/tasks/update-status` | `PATCH /api/tasks/{number}` (推测) |
| 文件上传 | `POST /api/uploads` (signed URL) | 同 |
| 频道操作 | `POST /api/channels/...` (推测) | 同 |
| Server info | `GET /api/server/info` (推测) | 同 |

> 注：确切的前端 API 路径需等 @slock-backend 的后端设计分析确认。本方案使用从 daemon 逆向得到的 `/internal/agent-api/*` 路径作为参考基准。

## 附录 B: WebSocket 消息协议速查

**Server → Client:**
| type | 字段 | 说明 |
|---|---|---|
| `agent:deliver` | `seq, message, deliveryId?, traceparent?` | 消息投递 |
| `agent:start` | `config, wakeMessage?, unreadSummary?, resumePrompt?` | 启动 agent |
| `agent:stop` | — | 停止 agent |
| `reminder.upsert` | `reminder` | 提醒创建/更新 |
| `reminder.cancel` | `reminderId, version` | 提醒取消 |
| `reminder.snapshot` | `reminders[]` | 提醒全量同步 |
| `ping` | — | 心跳 |

**Client → Server:**
| type | 字段 | 说明 |
|---|---|---|
| `ready` | `capabilities[], runtimes[], hostname, os, daemonVersion` | 握手 |
| `agent:deliver:ack` | `seq, traceparent?, deliveryId?` | 消息确认 |
| `agent:activity` | `activity, detail, entries[]` | 状态上报 |
| `agent:status` | `status` | online/offline/working |
| `pong` | — | 心跳回复 |
