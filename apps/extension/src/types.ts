export type EventType =
  | "snapshot"
  | "edit"
  | "run"
  | "memo"
  | "session_start"
  | "session_stop";
export interface RecordEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: EventType;
  fileId?: string;
  filePath?: string;
  occurredAt: string;
  documentVersion?: number;
  data: Record<string, unknown>;
}
export interface SessionManifest {
  schemaVersion: 1;
  id: string;
  rootPath: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  lastActivityAt: string;
  projectId?: string;
  ownerId?: string;
  apiUrl?: string;
  recording: boolean;
  excludePatterns: string[];
  remoteExcludePatterns?: string[];
  serverCreated?: boolean;
  serverEnded?: boolean;
}
export interface SyncAck {
  ackThrough: number;
  received: number[];
  gaps: number[];
}
