export class CliExit extends Error {
  exitCode: number;
  constructor(exitCode: number) {
    super(`CliExit(${exitCode})`);
    this.exitCode = exitCode;
    this.name = "CliExit";
  }
}

export function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

export function fail(code: string, message: string, exitCode = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + "\n");
  throw new CliExit(exitCode);
}
