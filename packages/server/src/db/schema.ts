import { pgTable, uuid, varchar, text, boolean, timestamp, bigint, integer, jsonb, uniqueIndex, index, primaryKey, foreignKey } from "./drizzle-pg.js";

// ---- users ----
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  handle: varchar("handle", { length: 80 }).notNull().unique(),
  displayName: varchar("display_name", { length: 80 }),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("idx_users_handle_lower").on(t.handle),
]);

// ---- servers ----
export const servers = pgTable("servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---- agents ----
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  serverId: uuid("server_id").references(() => servers.id).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  displayName: varchar("display_name", { length: 80 }),
  description: text("description"),
  avatarUrl: text("avatar_url"),
  runtimeProfile: jsonb("runtime_profile"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  capabilities: jsonb("capabilities"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("idx_agents_server_name").on(t.serverId, t.name),
]);

// ---- channels ----
export const channels = pgTable("channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").references(() => servers.id).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  visibility: varchar("visibility", { length: 20 }).default("public").notNull(),
  archived: boolean("archived").default(false).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("idx_channels_server_name").on(t.serverId, t.name),
]);

// ---- channel_members ----
export const channelMembers = pgTable("channel_members", {
  channelId: uuid("channel_id").references(() => channels.id).notNull(),
  memberId: uuid("member_id").notNull(),
  memberType: varchar("member_type", { length: 10 }).notNull(),
  role: varchar("role", { length: 20 }).default("member"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.channelId, t.memberId, t.memberType] }),
]);

// ---- messages ----
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id").references(() => channels.id).notNull(),
  serverId: uuid("server_id").references(() => servers.id).notNull(),
  senderId: uuid("sender_id").notNull(),
  senderType: varchar("sender_type", { length: 10 }).notNull(),
  content: text("content").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  threadId: uuid("thread_id"),
  taskNumber: integer("task_number"),
  taskStatus: varchar("task_status", { length: 20 }),
  taskAssignee: uuid("task_assignee"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("idx_messages_channel_seq").on(t.channelId, t.seq),
  index("idx_messages_thread").on(t.threadId),
  index("idx_messages_sender").on(t.senderId),
  index("idx_messages_task_status").on(t.channelId, t.taskStatus),
]);

// ---- reactions ----
export const messageReactions = pgTable("message_reactions", {
  messageId: uuid("message_id").references(() => messages.id).notNull(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  emoji: varchar("emoji", { length: 16 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
]);

// ---- reminders ----
export const reminders = pgTable("reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id).notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  fireAt: timestamp("fire_at").notNull(),
  repeatRule: varchar("repeat_rule", { length: 200 }),
  channelRef: varchar("channel_ref", { length: 200 }),
  anchorMsgId: uuid("anchor_msg_id"),
  status: varchar("status", { length: 20 }).default("scheduled").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("idx_reminders_status_fire").on(t.status, t.fireAt),
  index("idx_reminders_owner").on(t.ownerId),
]);

// ---- attachments ----
export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  uploaderId: uuid("uploader_id").notNull(),
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
  userId: uuid("user_id").references(() => users.id).notNull(),
  serverId: uuid("server_id").references(() => servers.id).notNull(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  tokenPrefix: varchar("token_prefix", { length: 20 }).notNull(),
  scope: jsonb("scope").default({}).notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
