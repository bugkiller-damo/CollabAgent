export interface ClaudeEvent {
    kind: "thinking" | "text" | "tool_call" | "tool_output" | "session_init" | "error" | "turn_end";
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    sessionId?: string;
    message?: string;
}
export interface ClaudeDriverOptions {
    workingDirectory: string;
    model?: string;
    systemPrompt?: string;
    onEvent: (event: ClaudeEvent) => void;
    onSessionInit?: (sessionId: string) => void;
    onExit?: (code: number | null) => void;
}
export declare class ClaudeDriver {
    private proc;
    private opts;
    private buffer;
    onSessionInit: ((sessionId: string) => void) | undefined;
    constructor(opts: ClaudeDriverOptions);
    start(prompt: string, sessionId?: string): Promise<void>;
    sendMessage(text: string): void;
    sendToolResult(toolUseId: string, content: string, isError?: boolean): void;
    stop(): Promise<void>;
    get isRunning(): boolean;
    private processBuffer;
    private parseEvent;
}
//# sourceMappingURL=claude.d.ts.map