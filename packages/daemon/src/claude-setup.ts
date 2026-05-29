import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildSystemPrompt(agentName: string): string {
  return [
    "## Who you are",
    "",
    `You are "${agentName}", an AI agent in CollabAgent — a collaborative platform for human-AI collaboration. You are a persistent team member with memory and tool access.`,
    "",
    "Use the `slock` CLI for chat, task, and attachment operations. Key commands:",
    "",
    "  slock message send --target <target>   Send message (content via stdin)",
    "  slock message check                     Check new messages",
    "  slock message read --channel <target>   Read message history",
    "  slock message search --query <q>        Search messages",
    "  slock server info                       List channels and agents",
    "  slock channel members <target>          List channel members",
    "  slock channel join --target <channel>   Join a channel",
    "  slock task list --channel <channel>     View task board",
    "  slock task claim --channel <ch> --number <n>  Claim a task",
    "  slock task update --channel <ch> --number <n> --status <s>  Update task",
    "  slock task create --channel <ch>        Create tasks",
    "  slock attachment upload --path <file>   Upload a file",
    "  slock attachment view --id <id> --output <path>  Download file",
    "  slock profile show                      Show profile",
    "  slock profile update                    Update profile",
    "  slock reminder schedule/list/cancel     Manage reminders",
    "  slock action prepare --target <ch>      Prepare action card",
    "",
    "## Rules",
    "",
    "1. Always claim a task before working on it: `slock task claim`",
    "2. Post progress updates in task threads",
    "3. Task status: todo → in_progress → in_review → done",
    "4. Target format: #channel-name, dm:@peer, #channel:threadId",
    "5. Keep MEMORY.md updated as your persistent memory index",
    "6. Use `slock message send` (not Bash echo) to communicate with the team",
    "",
    "Your working directory is persistent across sessions.",
  ].join("\n");
}

export function writeSlockWrapper(
  slockDir: string,
  slockCliPath: string,
  agentId: string,
  serverUrl: string,
  token: string
): void {
  mkdirSync(slockDir, { recursive: true });

  const cmdContent = [
    "@echo off",
    `set "SLOCK_AGENT_ID=${agentId}"`,
    `set "SLOCK_SERVER_URL=${serverUrl}"`,
    `set "SLOCK_AGENT_TOKEN=${token}"`,
    `"${process.execPath}" "${slockCliPath}" %*`,
    "",
  ].join("\r\n") + "\r\n";

  writeFileSync(join(slockDir, "slock.cmd"), cmdContent);
}

export function resolveSlockCliPath(): string {
  const candidates = [
    resolve(__dirname, "..", "dist", "cli", "index.js"),
    resolve(__dirname, "..", "..", "cli", "dist", "index.js"),
    resolve(process.cwd(), "packages", "daemon", "dist", "cli", "index.js"),
    resolve(__dirname, "cli.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return resolve(__dirname, "cli.js");
}
