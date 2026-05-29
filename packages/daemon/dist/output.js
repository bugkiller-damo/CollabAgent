export class CliExit extends Error {
    exitCode;
    constructor(exitCode) {
        super(`CliExit(${exitCode})`);
        this.exitCode = exitCode;
        this.name = "CliExit";
    }
}
export function emit(payload) {
    process.stdout.write(JSON.stringify(payload) + "\n");
}
export function fail(code, message, exitCode = 1) {
    process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
    throw new CliExit(exitCode);
}
//# sourceMappingURL=output.js.map