export type AgentType = "claude" | "codex" | "gemini" | "aider" | "pi" | "shell" | string;

export type ApprovalPreset = "readonly" | "standard" | "permissive" | "autonomous";

export type SessionStatus =
  | "running"
  | "ready"
  | "busy"
  | "blocked"
  | "authenticating"
  | "completed"
  | "stopped"
  | "errored"
  | "error"
  | "tool_running"
  | string;

export interface SessionInfo {
  id: string;
  name?: string;
  agentType: AgentType;
  workdir: string;
  status: SessionStatus;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  pid?: number;
  approvalPreset: ApprovalPreset;
  createdAt: Date;
  lastActivityAt: Date;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionFilter {
  status?: SessionStatus;
  statuses?: SessionStatus[];
  workdir?: string;
  agentType?: string;
  name?: string;
  acpxRecordId?: string;
}

export interface SessionStore {
  create(session: SessionInfo): Promise<void>;
  get(id: string): Promise<SessionInfo | null>;
  getByAcpxRecordId(recordId: string): Promise<SessionInfo | null>;
  findByScope(opts: { workdir: string; agentType: string; name?: string }): Promise<SessionInfo | null>;
  list(filter?: SessionFilter): Promise<SessionInfo[]>;
  update(id: string, patch: Partial<SessionInfo>): Promise<void>;
  updateStatus(id: string, status: SessionStatus, error?: string): Promise<void>;
  delete(id: string): Promise<void>;
  sweepStale(maxAgeMs: number): Promise<string[]>;
}

export interface SessionStoreRuntime {
  databaseAdapter?: unknown;
  logger?: {
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    debug?: (message: string, ...args: unknown[]) => void;
  };
  getSetting?: (key: string) => string | undefined;
}
