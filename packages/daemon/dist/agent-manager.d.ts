export interface AgentConfig {
    id: string;
    name: string;
    runtime: string;
    model?: string;
    workspace: string;
    serverUrl: string;
    apiKey: string;
}
export interface ParsedEvent {
    type: "thinking" | "text" | "tool_call" | "tool_output" | "error" | "session_init" | "turn_end";
    content?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolId?: string;
}
export interface AgentStatus {
    agentId: string;
    state: "offline" | "idle" | "thinking" | "working";
    currentAction?: string;
}
export declare class AgentProcessManager {
    private process;
    private config;
    private onStatusChange;
    private onReply;
    private stdoutBuffer;
    constructor(config: AgentConfig, callbacks: {
        onStatusChange: (status: AgentStatus) => void;
        onReply: (content: string) => Promise<void>;
    });
    isRunning(): boolean;
    start(): Promise<boolean>;
    sendMessage(content: string, senderName: string): Promise<void>;
    stop(): Promise<void>;
    private detectRuntime;
    private commandExists;
    private buildArgs;
    private handleStdout;
    private handleEvent;
}
//# sourceMappingURL=agent-manager.d.ts.map