#!/usr/bin/env node
import { Command } from "commander";
import { registerAction } from "./cli/action.js";
import { registerAgent } from "./cli/agent.js";
import { registerAttachment } from "./cli/attachment.js";
import { registerAuth } from "./cli/auth.js";
import { registerChannel } from "./cli/channel.js";
import { registerCost } from "./cli/cost.js";
import { registerDispatch } from "./cli/dispatch.js";
import { registerIntegration } from "./cli/integration.js";
import { registerMessage } from "./cli/message.js";
import { registerPatrol } from "./cli/patrol.js";
import { registerProfile } from "./cli/profile.js";
import { registerReminder } from "./cli/reminder.js";
import { registerServer } from "./cli/server.js";
import { registerSession } from "./cli/session.js";
import { registerTask } from "./cli/task.js";
import { registerThread } from "./cli/thread.js";
import { CliExit } from "./output.js";

const program = new Command();
program.name("slock").description("Agent-facing execution interface for CollabAgent").version("0.1.0");

registerAuth(program.command("auth").description("Auth introspection"));
registerChannel(program.command("channel").description("Channel membership operations"));
registerThread(program.command("thread").description("Thread attention operations"));
registerServer(program.command("server").description("Server information"));
registerMessage(program.command("message").description("Message operations"));
registerAttachment(program.command("attachment").description("Attachment operations"));
registerTask(program.command("task").description("Task board operations"));
registerDispatch(program.command("dispatch").description("Manager/worker task dispatch operations"));
registerProfile(program.command("profile").description("Profile operations"));
registerIntegration(program.command("integration").description("Third-party service integration"));
registerReminder(program.command("reminder").description("Reminder operations"));
registerPatrol(program.command("patrol").description("Proactive patrol jobs (agent cron)"));
registerAction(program.command("action").description("Action card operations"));
registerAgent(program.command("agent").description("Agent duty / listing"));
registerCost(program.command("cost").description("Local daemon cost accounting (D3)"));
registerSession(program.command("session").description("Local thread↔session map (D2)"));

program.parseAsync().catch((err) => {
  if (err instanceof CliExit) {
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`Unexpected error: ${(err as Error)?.message ?? err}\n`);
    process.exitCode = 1;
  }
});

export { program };
