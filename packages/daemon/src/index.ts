import { Command } from "commander";

const program = new Command();

program
  .name("collabagent-daemon")
  .description("CollabAgent 本地守护进程")
  .version("0.1.0")
  .requiredOption("--server-url <url>", "服务器地址")
  .requiredOption("--api-key <key>", "API 密钥");

program.parse();
console.log("CollabAgent daemon starting...");
