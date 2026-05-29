#!/usr/bin/env node
import { DaemonCore } from "./core.js";
function parseArgs(args) {
    let serverUrl = "";
    let apiKey = "";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--server-url" && args[i + 1])
            serverUrl = args[++i];
        if (args[i] === "--api-key" && args[i + 1])
            apiKey = args[++i];
    }
    if (!serverUrl || !apiKey)
        return null;
    return { serverUrl, apiKey };
}
const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
    console.error("Usage: collabagent-daemon --server-url <url> --api-key <key>");
    process.exit(1);
}
const daemon = new DaemonCore(parsed);
try {
    daemon.start();
}
catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
}
const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
//# sourceMappingURL=index.js.map