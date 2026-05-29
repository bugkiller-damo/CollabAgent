export interface DaemonConfig {
    serverUrl: string;
    apiKey: string;
    dataDir?: string;
}
export declare class DaemonCore {
    private config;
    private ws;
    private serverUrl;
    private apiKey;
    private slockDir;
    private reconnectTimer;
    private reconnectDelay;
    private client;
    private agentId;
    private agents;
    private driver;
    private agentDrivers;
    private agentSessions;
    private lastCh;
    private agentHistory;
    private agentLastChannel;
    private chatHistory;
    constructor(config: DaemonConfig);
    start(): void;
    private setupSlockWrapper;
    private loadExistingAgents;
    private connect;
    private findMentionedAgent;
    private scheduleReconnect;
    private getTools;
    private executeTool;
    private sendReply;
    private logStatus;
    private spawnAgent;
    private sendToAgent;
    private callAI;
    private handleMessage;
    stop(): Promise<void>;
}
//# sourceMappingURL=core.d.ts.map