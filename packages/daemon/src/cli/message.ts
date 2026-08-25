import type { Command } from "commander";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerMessage(parent: Command) {
  parent
    .command("send")
    .description("Send a message to a channel, DM, or thread. Content is read from stdin.")
    .requiredOption("--target <target>", "Target channel, DM, or thread")
    .option("--send-draft", "Send a saved draft after reviewing newer messages")
    .option("--attachment-id <id>", "Attachment ID to link (repeatable)", (v: string, prev: string[] = []) =>
      prev.concat(v),
    )
    .action(async (opts: { target: string; sendDraft?: boolean; attachmentId?: string[] }) => {
      const { ctx, client } = getClient();

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

  parent
    .command("check")
    .description("Non-blocking check for new messages")
    .action(async () => {
      const { ctx, client } = getClient();
      const res = await client.request("GET", `/internal/agent/${encodeURIComponent(ctx.agentId)}/receive`);
      if (!res.ok) fail("CHECK_FAILED", res.error ?? `HTTP ${res.status}`);
      const data = res.data as { messages?: unknown[] };
      if (data.messages?.length) {
        process.stdout.write(JSON.stringify(data.messages, null, 2) + "\n");
      } else {
        process.stdout.write("No new messages.\n");
      }
    });

  parent
    .command("read")
    .description("Read message history for a channel, DM, or thread")
    .requiredOption("--channel <target>", "Target channel, DM, or thread")
    .option("--before <seq>", "Return messages before this seq")
    .option("--after <seq>", "Return messages after this seq")
    .option("--around <idOrSeq>", "Center the window on this message ID or seq")
    .option("--limit <n>", "Max messages to return")
    .action(async (opts: { channel: string; before?: string; after?: string; around?: string; limit?: string }) => {
      const { ctx, client } = getClient();
      const params = new URLSearchParams();
      params.set("channel", opts.channel);
      if (opts.before) params.set("before", opts.before);
      if (opts.after) params.set("after", opts.after);
      if (opts.around) params.set("around", opts.around);
      if (opts.limit) params.set("limit", opts.limit);

      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/history?${params.toString()}`,
      );
      if (!res.ok) fail("READ_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("search")
    .description("Search messages")
    .requiredOption("--query <q>", "Search query")
    .option("--channel <target>", "Limit to channel")
    .option("--sender <handle>", "Limit to sender")
    .option("--limit <n>", "Max results")
    .action(async (opts: { query: string; channel?: string; sender?: string; limit?: string }) => {
      const { ctx, client } = getClient();
      const params = new URLSearchParams();
      params.set("q", opts.query);
      if (opts.channel) params.set("channel", opts.channel);
      if (opts.sender) params.set("sender", opts.sender);
      if (opts.limit) params.set("limit", opts.limit);

      const res = await client.request(
        "GET",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/search?${params.toString()}`,
      );
      if (!res.ok) fail("SEARCH_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("react")
    .description("Add or remove your reaction on a message")
    .requiredOption("--message-id <id>", "Message UUID")
    .requiredOption("--emoji <emoji>", "Reaction emoji")
    .option("--remove", "Remove reaction instead of adding")
    .action(async (opts: { messageId: string; emoji: string; remove?: boolean }) => {
      const { ctx, client } = getClient();
      const method = opts.remove ? "DELETE" : "POST";
      const res = await client.request(
        method,
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/messages/${opts.messageId}/reactions`,
        { emoji: opts.emoji },
      );
      if (!res.ok) fail("REACT_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(`${opts.remove ? "Removed" : "Added"} reaction ${opts.emoji}\n`);
    });
}
