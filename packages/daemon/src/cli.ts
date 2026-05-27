#!/usr/bin/env node
import { Command } from "commander";
import { loadAgentContext, AgentBootstrapError } from "./auth.js";
import { ApiClient } from "./client.js";
import { CliExit, emit, fail } from "./output.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function registerWhoami(parent: Command) {
  parent
    .command("whoami")
    .description("Print the agent context resolved from env (token redacted)")
    .action(() => {
      const ctx = loadAgentContext();
      emit({
        ok: true,
        data: { agentId: ctx.agentId, serverUrl: ctx.serverUrl, serverId: ctx.serverId, clientMode: ctx.clientMode, secretSource: ctx.secretSource },
      });
    });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function registerServerInfo(parent: Command) {
  parent
    .command("info")
    .description("List channels, agents, and humans on the current server")
    .action(async () => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/server`);
      if (!res.ok) fail("INFO_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Channel: members, join, leave
// ---------------------------------------------------------------------------
function registerChannelMembers(parent: Command) {
  parent
    .command("members")
    .description("List agents and humans who are members of a channel, DM, or thread")
    .argument("<target>", "Channel / DM / thread target")
    .action(async (target: string) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/channel-members?channel=${encodeURIComponent(target)}`);
      if (!res.ok) fail("MEMBERS_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerChannelJoin(parent: Command) {
  parent
    .command("join")
    .description("Join a visible public channel")
    .requiredOption("--target <target>", "Channel to join")
    .action(async (opts: { target: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/channels/${encodeURIComponent(opts.target.replace(/^#/, ""))}/join`, {});
      if (!res.ok) fail("JOIN_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Joined ${opts.target}\n`);
    });
}

function registerChannelLeave(parent: Command) {
  parent
    .command("leave")
    .description("Leave a regular channel you have joined")
    .requiredOption("--target <target>", "Channel to leave")
    .action(async (opts: { target: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/channels/${encodeURIComponent(opts.target.replace(/^#/, ""))}/leave`, {});
      if (!res.ok) fail("LEAVE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Left ${opts.target}\n`);
    });
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------
function registerThreadUnfollow(parent: Command) {
  parent
    .command("unfollow")
    .description("Stop following a thread")
    .requiredOption("--target <target>", "Thread target")
    .action(async (opts: { target: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/threads/unfollow`, { target: opts.target });
      if (!res.ok) fail("UNFOLLOW_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`Unfollowed ${opts.target}\n`);
    });
}

// ---------------------------------------------------------------------------
// Message: send, check, read, search, react
// ---------------------------------------------------------------------------
function registerMessageSend(parent: Command) {
  parent
    .command("send")
    .description("Send a message to a channel, DM, or thread. Content is read from stdin.")
    .requiredOption("--target <target>", "Target channel, DM, or thread")
    .option("--send-draft", "Send a saved draft after reviewing newer messages")
    .option("--attachment-id <id>", "Attachment ID to link (repeatable)", (v: string, prev: string[] = []) => prev.concat(v))
    .action(async (opts: { target: string; sendDraft?: boolean; attachmentId?: string[] }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);

      // Read content from stdin
      let content = "";
      if (!opts.sendDraft) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        content = Buffer.concat(chunks).toString("utf-8");
        if (!content.trim()) fail("SEND_NO_CONTENT", "No message content received on stdin.");
      }

      const body: Record<string, unknown> = { target: opts.target };
      if (opts.sendDraft) {
        body.sendDraft = true;
        body.content = "";
      } else {
        body.content = content;
      }
      if (opts.attachmentId?.length) body.attachmentIds = opts.attachmentId;

      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/send`, body);
      if (!res.ok) fail("SEND_FAILED", res.error ?? `HTTP ${res.status}`);

      const data = res.data as { state?: string; messageId?: string };
      if (data.state === "held") {
        process.stdout.write(`Message held as draft for ${opts.target}\n`);
      } else {
        process.stdout.write(`Message sent to ${opts.target}. ID: ${data.messageId}\n`);
      }
    });
}

function registerMessageCheck(parent: Command) {
  parent
    .command("check")
    .description("Non-blocking check for new messages")
    .action(async () => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/receive`);
      if (!res.ok) fail("CHECK_FAILED", res.error ?? `HTTP ${res.status}`);
      const data = res.data as { messages?: unknown[] };
      if (data.messages?.length) {
        process.stdout.write(JSON.stringify(data.messages, null, 2) + "\n");
      } else {
        process.stdout.write("No new messages.\n");
      }
    });
}

function registerMessageRead(parent: Command) {
  parent
    .command("read")
    .description("Read message history for a channel, DM, or thread")
    .requiredOption("--channel <target>", "Target channel, DM, or thread")
    .option("--before <seq>", "Return messages before this seq")
    .option("--after <seq>", "Return messages after this seq")
    .option("--around <idOrSeq>", "Center the window on this message ID or seq")
    .option("--limit <n>", "Max messages to return")
    .action(async (opts: { channel: string; before?: string; after?: string; around?: string; limit?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const params = new URLSearchParams();
      params.set("channel", opts.channel);
      if (opts.before) params.set("before", opts.before);
      if (opts.after) params.set("after", opts.after);
      if (opts.around) params.set("around", opts.around);
      if (opts.limit) params.set("limit", opts.limit);

      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/history?${params.toString()}`);
      if (!res.ok) fail("READ_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerMessageSearch(parent: Command) {
  parent
    .command("search")
    .description("Search messages")
    .requiredOption("--query <q>", "Search query")
    .option("--channel <target>", "Limit to channel")
    .option("--sender <handle>", "Limit to sender")
    .option("--limit <n>", "Max results")
    .action(async (opts: { query: string; channel?: string; sender?: string; limit?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const params = new URLSearchParams();
      params.set("q", opts.query);
      if (opts.channel) params.set("channel", opts.channel);
      if (opts.sender) params.set("sender", opts.sender);
      if (opts.limit) params.set("limit", opts.limit);

      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/search?${params.toString()}`);
      if (!res.ok) fail("SEARCH_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerMessageReact(parent: Command) {
  parent
    .command("react")
    .description("Add or remove your reaction on a message")
    .requiredOption("--message-id <id>", "Message UUID")
    .requiredOption("--emoji <emoji>", "Reaction emoji")
    .option("--remove", "Remove reaction instead of adding")
    .action(async (opts: { messageId: string; emoji: string; remove?: boolean }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const method = opts.remove ? "DELETE" : "POST";
      const res = await client.request(method, `/internal/agent/${encodeURIComponent(ctx.agentId)}/messages/${opts.messageId}/reactions`, { emoji: opts.emoji });
      if (!res.ok) fail("REACT_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`${opts.remove ? "Removed" : "Added"} reaction ${opts.emoji}\n`);
    });
}

// ---------------------------------------------------------------------------
// Attachment: upload, view
// ---------------------------------------------------------------------------
function registerAttachmentUpload(parent: Command) {
  parent
    .command("upload")
    .description("Upload a local file as an attachment")
    .requiredOption("--path <filepath>", "Path to the local file")
    .option("--mime-type <type>", "MIME type override")
    .action(async (opts: { path: string; mimeType?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const fs = await import("node:fs");
      const pathModule = await import("node:path");

      const filePath = pathModule.resolve(opts.path);
      if (!fs.existsSync(filePath)) fail("UPLOAD_FILE_NOT_FOUND", `File not found: ${filePath}`);

      const form = new FormData();
      const buffer = fs.readFileSync(filePath);
      const blob = new Blob([buffer], { type: opts.mimeType ?? "application/octet-stream" });
      form.append("file", blob, pathModule.basename(filePath));

      const res = await client.requestMultipart("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/upload`, form);
      if (!res.ok) fail("UPLOAD_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerAttachmentView(parent: Command) {
  parent
    .command("view")
    .description("Download an attachment by ID")
    .requiredOption("--id <attachmentId>", "Attachment UUID")
    .requiredOption("--output <path>", "Local path to save the file")
    .action(async (opts: { id: string; output: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await fetch(`${ctx.serverUrl}/api/attachments/${opts.id}`, {
        headers: { Authorization: `Bearer ${ctx.token}` },
      });
      if (!res.ok) fail("VIEW_FAILED", `HTTP ${res.status}`);
      const fs = await import("node:fs");
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(opts.output, buffer);
      process.stdout.write(`Downloaded to: ${opts.output}\n`);
    });
}

// ---------------------------------------------------------------------------
// Task: list, create, claim, unclaim, update
// ---------------------------------------------------------------------------
function registerTaskList(parent: Command) {
  parent
    .command("list")
    .description("List tasks in a channel")
    .requiredOption("--channel <target>", "Channel target")
    .option("--status <s>", "Filter by status")
    .action(async (opts: { channel: string; status?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const params = new URLSearchParams();
      params.set("channel", opts.channel);
      if (opts.status) params.set("status", opts.status);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks?${params.toString()}`);
      if (!res.ok) fail("TASK_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerTaskCreate(parent: Command) {
  parent
    .command("create")
    .description("Create one or more tasks in a channel")
    .requiredOption("--channel <target>", "Channel target")
    .argument("[titles...]", "Task titles")
    .action(async (titles: string[], opts: { channel: string }) => {
      if (!titles.length) fail("TASK_NO_TITLES", "At least one task title is required");
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks`, {
        channel: opts.channel,
        tasks: titles.map((t) => ({ title: t })),
      });
      if (!res.ok) fail("TASK_CREATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerTaskClaim(parent: Command) {
  parent
    .command("claim")
    .description("Claim tasks by number or message ID")
    .requiredOption("--channel <target>", "Channel target")
    .option("--number <n>", "Task number to claim")
    .option("--message-id <id>", "Message ID to claim")
    .action(async (opts: { channel: string; number?: string; messageId?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const body: Record<string, unknown> = { channel: opts.channel };
      if (opts.number) body.task_numbers = [Number(opts.number)];
      if (opts.messageId) body.message_ids = [opts.messageId];
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/claim`, body);
      if (!res.ok) fail("TASK_CLAIM_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerTaskUnclaim(parent: Command) {
  parent
    .command("unclaim")
    .description("Release a previously claimed task")
    .requiredOption("--channel <target>", "Channel target")
    .requiredOption("--number <n>", "Task number to unclaim")
    .action(async (opts: { channel: string; number: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/unclaim`, {
        channel: opts.channel,
        task_number: Number(opts.number),
      });
      if (!res.ok) fail("TASK_UNCLAIM_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Task unclaimed\n");
    });
}

function registerTaskUpdate(parent: Command) {
  parent
    .command("update")
    .description("Update task status")
    .requiredOption("--channel <target>", "Channel target")
    .requiredOption("--number <n>", "Task number")
    .requiredOption("--status <status>", "New status: todo | in_progress | in_review | done")
    .action(async (opts: { channel: string; number: string; status: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/tasks/update-status`, {
        channel: opts.channel,
        number: Number(opts.number),
        status: opts.status,
      });
      if (!res.ok) fail("TASK_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Profile: show, update
// ---------------------------------------------------------------------------
function registerProfileShow(parent: Command) {
  parent
    .command("show")
    .description("Show a profile (omit target for self)")
    .argument("[target]", "Handle like @alice")
    .action(async (target?: string) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const path = target
        ? `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile?target=${encodeURIComponent(target)}`
        : `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile`;
      const res = await client.request("GET", path);
      if (!res.ok) fail("PROFILE_SHOW_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerProfileUpdate(parent: Command) {
  parent
    .command("update")
    .description("Update your own profile")
    .option("--display-name <name>", "New display name")
    .option("--description <text>", "New description")
    .action(async (opts: { displayName?: string; description?: string }) => {
      if (!opts.displayName && !opts.description) fail("PROFILE_NO_CHANGES", "At least one field is required");
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const body: Record<string, string> = {};
      if (opts.displayName) body.displayName = opts.displayName;
      if (opts.description) body.description = opts.description;
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/profile`, body);
      if (!res.ok) fail("PROFILE_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Integration: list, login
// ---------------------------------------------------------------------------
function registerIntegrationList(parent: Command) {
  parent
    .command("list")
    .description("List registered third-party services and active logins")
    .action(async () => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/integrations`);
      if (!res.ok) fail("INTEGRATION_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerIntegrationLogin(parent: Command) {
  parent
    .command("login")
    .description("Provision or reuse this agent's login for a registered service")
    .requiredOption("--service <id>", "Service ID")
    .option("--scope <scope>", "Requested scope")
    .action(async (opts: { service: string; scope?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/integrations/login`, {
        service: opts.service,
        scope: opts.scope,
      });
      if (!res.ok) fail("INTEGRATION_LOGIN_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Reminder: schedule, list, cancel, snooze, update, log
// ---------------------------------------------------------------------------
function registerReminderSchedule(parent: Command) {
  parent
    .command("schedule")
    .description("Schedule a reminder")
    .requiredOption("--title <t>", "Reminder title")
    .option("--fire-at <iso>", "Absolute fire time (ISO 8601)")
    .option("--in <duration>", "Relative fire time (e.g. 30m, 2h, 1d)")
    .option("--cadence <rule>", "Recurrence rule (e.g. every:15m, daily@09:00)")
    .action(async (opts: { title: string; fireAt?: string; in?: string; cadence?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const body: Record<string, unknown> = { title: opts.title };
      if (opts.fireAt) body.fireAt = opts.fireAt;
      if (opts.in) body.delaySeconds = parseDuration(opts.in);
      if (opts.cadence) body.repeat = opts.cadence;
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders`, body);
      if (!res.ok) fail("REMINDER_SCHEDULE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerReminderList(parent: Command) {
  parent
    .command("list")
    .description("List your reminders")
    .option("--all", "Include cancelled reminders")
    .action(async (opts: { all?: boolean }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const path = opts.all
        ? `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders?status=all`
        : `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders`;
      const res = await client.request("GET", path);
      if (!res.ok) fail("REMINDER_LIST_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerReminderCancel(parent: Command) {
  parent
    .command("cancel")
    .description("Cancel a scheduled reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .action(async (opts: { id: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("DELETE", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`);
      if (!res.ok) fail("REMINDER_CANCEL_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write("Reminder cancelled\n");
    });
}

function registerReminderSnooze(parent: Command) {
  parent
    .command("snooze")
    .description("Snooze a reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .requiredOption("--by <duration>", "Snooze duration (e.g. 30m, 2h)")
    .action(async (opts: { id: string; by: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/snooze`, { duration: opts.by });
      if (!res.ok) fail("REMINDER_SNOOZE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerReminderUpdate(parent: Command) {
  parent
    .command("update")
    .description("Update a scheduled reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .option("--fire-at <iso>", "New fire time")
    .option("--in <duration>", "New relative fire time")
    .option("--cadence <rule>", "New recurrence rule")
    .option("--title <text>", "New title")
    .action(async (opts: { id: string; fireAt?: string; in?: string; cadence?: string; title?: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const body: Record<string, unknown> = {};
      if (opts.fireAt) body.fireAt = opts.fireAt;
      if (opts.in) body.delaySeconds = parseDuration(opts.in);
      if (opts.cadence) body.repeat = opts.cadence;
      if (opts.title) body.title = opts.title;
      const res = await client.request("PATCH", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}`, body);
      if (!res.ok) fail("REMINDER_UPDATE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

function registerReminderLog(parent: Command) {
  parent
    .command("log")
    .description("Show lifecycle events for a reminder")
    .requiredOption("--id <id>", "Reminder ID")
    .action(async (opts: { id: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/reminders/${opts.id}/log`);
      if (!res.ok) fail("REMINDER_LOG_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Action: prepare
// ---------------------------------------------------------------------------
function registerActionPrepare(parent: Command) {
  parent
    .command("prepare")
    .description("Prepare an action card for a human to commit")
    .requiredOption("--target <ch>", "Target channel")
    .action(async (opts: { target: string }) => {
      const ctx = loadAgentContext();
      const client = new ApiClient(ctx);
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const actionJson = Buffer.concat(chunks).toString("utf-8");
      const action = JSON.parse(actionJson);
      const res = await client.request("POST", `/internal/agent/${encodeURIComponent(ctx.agentId)}/prepare-action`, {
        target: opts.target,
        action,
      });
      if (!res.ok) fail("ACTION_PREPARE_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseDuration(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = Number(match[1]);
  switch (match[2]) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: return value;
  }
}

// ---------------------------------------------------------------------------
// Program entry
// ---------------------------------------------------------------------------
const program = new Command();
program
  .name("slock")
  .description("Agent-facing execution interface for CollabAgent")
  .version("0.1.0");

// Top-level command groups
const authCmd = program.command("auth").description("Auth introspection");
registerWhoami(authCmd);

const channelCmd = program.command("channel").description("Channel membership operations");
registerChannelMembers(channelCmd);
registerChannelJoin(channelCmd);
registerChannelLeave(channelCmd);

const threadCmd = program.command("thread").description("Thread attention operations");
registerThreadUnfollow(threadCmd);

const serverCmd = program.command("server").description("Server information");
registerServerInfo(serverCmd);

const messageCmd = program.command("message").description("Message operations");
registerMessageSend(messageCmd);
registerMessageCheck(messageCmd);
registerMessageRead(messageCmd);
registerMessageSearch(messageCmd);
registerMessageReact(messageCmd);

const attachmentCmd = program.command("attachment").description("Attachment operations");
registerAttachmentUpload(attachmentCmd);
registerAttachmentView(attachmentCmd);

const taskCmd = program.command("task").description("Task board operations");
registerTaskList(taskCmd);
registerTaskCreate(taskCmd);
registerTaskClaim(taskCmd);
registerTaskUnclaim(taskCmd);
registerTaskUpdate(taskCmd);

const profileCmd = program.command("profile").description("Profile operations");
registerProfileShow(profileCmd);
registerProfileUpdate(profileCmd);

const integrationCmd = program.command("integration").description("Third-party service integration");
registerIntegrationList(integrationCmd);
registerIntegrationLogin(integrationCmd);

const reminderCmd = program.command("reminder").description("Reminder operations");
registerReminderSchedule(reminderCmd);
registerReminderList(reminderCmd);
registerReminderCancel(reminderCmd);
registerReminderSnooze(reminderCmd);
registerReminderUpdate(reminderCmd);
registerReminderLog(reminderCmd);

const actionCmd = program.command("action").description("Action card operations");
registerActionPrepare(actionCmd);

program.parseAsync().catch((err) => {
  if (err instanceof CliExit) {
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`Unexpected error: ${(err as Error)?.message ?? err}\n`);
    process.exitCode = 1;
  }
});

export { program };
