import type { Command } from "commander";
import { loadAgentContext } from "../auth.js";
import { fail } from "../output.js";
import { getClient } from "./context.js";

export function registerAttachment(parent: Command) {
  parent
    .command("upload")
    .description("Upload a local file as an attachment")
    .requiredOption("--path <filepath>", "Path to the local file")
    .option("--mime-type <type>", "MIME type override")
    .action(async (opts: { path: string; mimeType?: string }) => {
      const { ctx, client } = getClient();
      const fs = await import("node:fs");
      const pathModule = await import("node:path");

      const filePath = pathModule.resolve(opts.path);
      if (!fs.existsSync(filePath)) fail("UPLOAD_FILE_NOT_FOUND", `File not found: ${filePath}`);

      const form = new FormData();
      const buffer = fs.readFileSync(filePath);
      const blob = new Blob([buffer], { type: opts.mimeType ?? "application/octet-stream" });
      form.append("file", blob, pathModule.basename(filePath));

      const res = await client.requestMultipart(
        "POST",
        `/internal/agent/${encodeURIComponent(ctx.agentId)}/upload`,
        form,
      );
      if (!res.ok) fail("UPLOAD_FAILED", res.error ?? `HTTP ${res.status}`);
      process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
    });

  parent
    .command("view")
    .description("Download an attachment by ID")
    .requiredOption("--id <attachmentId>", "Attachment UUID")
    .requiredOption("--output <path>", "Local path to save the file")
    .action(async (opts: { id: string; output: string }) => {
      const ctx = loadAgentContext();
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
