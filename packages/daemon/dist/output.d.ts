export declare class CliExit extends Error {
    exitCode: number;
    constructor(exitCode: number);
}
export declare function emit(payload: Record<string, unknown>): void;
export declare function fail(code: string, message: string, exitCode?: number): never;
//# sourceMappingURL=output.d.ts.map