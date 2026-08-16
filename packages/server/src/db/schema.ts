import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "./drizzle-pg.js";

// ---- users ----
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    handle: varchar("handle", { length: 80 }).notNull().unique(),
    displayName: varchar("display_name", { length: 80 }),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    passwordHash: text("password_hash").notNull(),
    email: varchar("email", { length: 255 }),
    tokenVersion: varchar("token_version", { length: 64 }),
    nickname: varchar("nickname", { length: 80 }),
    resetCode: varchar("reset_code", { length: 10 }),
    resetExpires: timestamp("reset_expires"),
    deactivatedAt: timestamp("deactivated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_users_handle_lower").on(t.handle)],
);

// ---- servers ----
export const servers = pgTable("servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  personal: boolean("personal").default(false).notNull(),
  ownerId: uuid("owner_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- agents ----
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    displayName: varchar("display_name", { length: 80 }),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    runtimeProfile: jsonb("runtime_profile"),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    capabilities: jsonb("capabilities"),
    lastSeenSeq: bigint("last_seen_seq", { mode: "number" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_agents_server_name").on(t.serverId, t.name)],
);

// ---- channels ----
export const channels = pgTable(
  "channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    type: varchar("type", { length: 20 }).default("public").notNull(),
    archived: boolean("archived").default(false).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_channels_server_name").on(t.serverId, t.name)],
);

// ---- channel_members ----
export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: uuid("channel_id")
      .references(() => channels.id)
      .notNull(),
    memberId: uuid("member_id").notNull(),
    memberType: varchar("member_type", { length: 10 }).notNull(),
    role: varchar("role", { length: 20 }).default("member"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.memberId, t.memberType] })],
);

// ---- messages ----
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .references(() => channels.id)
      .notNull(),
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    senderId: uuid("sender_id").notNull(),
    senderType: varchar("sender_type", { length: 10 }).notNull(),
    content: text("content").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    threadId: uuid("thread_id"),
    taskNumber: integer("task_number"),
    taskStatus: varchar("task_status", { length: 20 }),
    taskAssignee: uuid("task_assignee"),
    editedAt: timestamp("edited_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_messages_channel_seq").on(t.channelId, t.seq),
    index("idx_messages_server_seq").on(t.serverId, t.seq),
    index("idx_messages_thread").on(t.threadId),
    index("idx_messages_sender").on(t.senderId),
    index("idx_messages_task_status").on(t.channelId, t.taskStatus),
  ],
);

// ---- reactions ----
export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .references(() => messages.id)
      .notNull(),
    // 不加 users 外键：reactor 可能是 human 也可能是 agent（id 在 agents 表）
    userId: uuid("user_id").notNull(),
    emoji: varchar("emoji", { length: 16 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

// ---- reminders ----
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // owner 可能是 human 也可能是 agent（id 在 agents 表），故不加 users 外键
    ownerId: uuid("owner_id").notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    fireAt: timestamp("fire_at").notNull(),
    repeatRule: varchar("repeat_rule", { length: 200 }),
    channelRef: varchar("channel_ref", { length: 200 }),
    anchorMsgId: uuid("anchor_msg_id"),
    status: varchar("status", { length: 20 }).default("scheduled").notNull(),
    fireCount: integer("fire_count").default(0).notNull(),
    lastFiredAt: timestamp("last_fired_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("idx_reminders_status_fire").on(t.status, t.fireAt), index("idx_reminders_owner").on(t.ownerId)],
);

// ---- attachments ----
export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  uploaderId: uuid("uploader_id").notNull(),
  uploaderType: varchar("uploader_type", { length: 10 }).default("human").notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(),
  storageUrl: text("storage_url").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- machine_tokens ----
export const machineTokens = pgTable("machine_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  serverId: uuid("server_id")
    .references(() => servers.id)
    .notNull(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  tokenPrefix: varchar("token_prefix", { length: 20 }).notNull(),
  scope: jsonb("scope").default({}).notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- server_members ----
export const serverMembers = pgTable(
  "server_members",
  {
    serverId: uuid("server_id")
      .references(() => servers.id)
      .notNull(),
    userId: uuid("user_id").notNull(),
    role: varchar("role", { length: 20 }).default("member").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.userId] })],
);

// ---- invites ----
export const invites = pgTable("invites", {
  token: varchar("token", { length: 64 }).primaryKey(),
  serverId: uuid("server_id")
    .references(() => servers.id)
    .notNull(),
  createdBy: uuid("created_by")
    .references(() => users.id)
    .notNull(),
  role: varchar("role", { length: 20 }).default("member").notNull(),
  maxUses: integer("max_uses").default(0).notNull(),
  uses: integer("uses").default(0).notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- notifications ----
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  actorId: uuid("actor_id").notNull(),
  actorName: varchar("actor_name", { length: 160 }),
  channelId: uuid("channel_id"),
  messageId: uuid("message_id"),
  title: text("title").notNull(),
  body: text("body"),
  metadata: jsonb("metadata"),
  read: boolean("read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- action_cards ----
export const actionCards = pgTable("action_cards", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id")
    .references(() => channels.id)
    .notNull(),
  createdBy: uuid("created_by").notNull(),
  targetUser: uuid("target_user")
    .references(() => users.id)
    .notNull(),
  actionType: varchar("action_type", { length: 50 }).notNull(),
  actionData: jsonb("action_data").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- integrations ----
export const integrations = pgTable("integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceId: varchar("service_id", { length: 100 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  provider: varchar("provider", { length: 100 }).notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- reminder_events ----
export const reminderEvents = pgTable("reminder_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  reminderId: uuid("reminder_id")
    .references(() => reminders.id)
    .notNull(),
  eventType: varchar("event_type", { length: 30 }).notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- message_attachments ----
export const messageAttachments = pgTable(
  "message_attachments",
  {
    messageId: uuid("message_id")
      .references(() => messages.id)
      .notNull(),
    attachmentId: uuid("attachment_id")
      .references(() => attachments.id)
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.attachmentId] })],
);

// ---- agent_credentials ----
export const agentCredentials = pgTable("agent_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id")
    .references(() => agents.id)
    .notNull()
    .unique(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  tokenPrefix: varchar("token_prefix", { length: 20 }).notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- agent_logins ----
export const agentLogins = pgTable("agent_logins", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id")
    .references(() => agents.id)
    .notNull(),
  integrationId: uuid("integration_id")
    .references(() => integrations.id)
    .notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ---- user_sessions ----
export const userSessions = pgTable("user_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  refreshId: uuid("refresh_id").notNull(),
  userAgent: text("user_agent"),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
});

// ---- metrics_samples ----
export const metricsSamples = pgTable("metrics_samples", {
  id: uuid("id").defaultRandom().primaryKey(),
  sampledAt: timestamp("sampled_at").defaultNow().notNull(),
  messagesSent: bigint("messages_sent", { mode: "number" }).default(0).notNull(),
  dmSent: bigint("dm_sent", { mode: "number" }).default(0).notNull(),
  remindersFired: bigint("reminders_fired", { mode: "number" }).default(0).notNull(),
  errors: bigint("errors", { mode: "number" }).default(0).notNull(),
  logins: bigint("logins", { mode: "number" }).default(0).notNull(),
  rssMb: integer("rss_mb").default(0).notNull(),
  heapUsedMb: integer("heap_used_mb").default(0).notNull(),
  heapTotalMb: integer("heap_total_mb").default(0).notNull(),
  daemonCount: integer("daemon_count").default(0).notNull(),
  agentTotal: integer("agent_total").default(0).notNull(),
  agentOnline: integer("agent_online").default(0).notNull(),
});

// ---- events（审计日志 / 事件流水，O2）----
// 运行时以 migrations/010_events.sql 为准（BIGINT IDENTITY id + 无外键）。
// 此处仅作类型参考；id 在真实表是 IDENTITY，drizzle 模型里用 bigint 占位。
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    actorId: text("actor_id").notNull(),
    actorType: varchar("actor_type", { length: 10 }).notNull(),
    verb: varchar("verb", { length: 50 }).notNull(),
    objectType: varchar("object_type", { length: 40 }).notNull(),
    objectId: text("object_id").notNull(),
    payload: jsonb("payload").default({}).notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_events_object").on(t.objectType, t.objectId),
    index("idx_events_actor").on(t.actorId),
    index("idx_events_verb").on(t.verb),
  ],
);
