export interface User {
  id: string;
  email: string;
  role: string;
  dailyLimit: number;
  monthlyLimit: number;
  usage?: { day: number; month: number };
}
export interface Project {
  id: string;
  name: string;
  rootPath?: string;
  excluded?: boolean;
  excludePatterns?: string[];
  createdAt?: string;
}
export interface Session {
  id: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  recording?: boolean;
  deviceId?: string;
}
export interface RecordEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  fileId?: string;
  filePath?: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
export interface SourceFile {
  id: string;
  path?: string;
  filePath?: string;
  language?: string;
  problemStatement?: string;
}
export interface SessionDetail {
  session: Session;
  files: SourceFile[];
  events: RecordEvent[];
  summaries: Array<{
    id?: string;
    summary?: string;
    text?: string;
    createdAt?: string;
  }>;
  gaps: number[];
}
export type Review =
  | "needs_review"
  | "supported"
  | "insufficient"
  | "conflict"
  | "unknown";
export interface ArticleBlock {
  id: string;
  type: "heading" | "paragraph" | "quote" | "code" | "list" | "image";
  text: string;
  language?: string;
  url?: string;
  evidenceIds: string[];
  review: Review;
}
export interface Article {
  id: string;
  ownerId: string;
  sessionId: string;
  fileId?: string;
  title: string;
  version: number;
  editingCompletedAt?: string | null;
  lexical: Record<string, unknown>;
  blocks: ArticleBlock[];
  status: string;
  publication?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface Job {
  id: string;
  kind: string;
  status: string;
  progress: number;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  articleId?: string;
  sessionId?: string;
  stream?: { text?: string; stage?: string; delta?: string };
}
export interface Revision {
  id: string;
  version: number;
  kind: string;
  createdAt: string;
  title?: string;
}
export interface Suggestion {
  id: string;
  blockId: string;
  baseVersion: number;
  status: string;
  content?: string;
  text?: string;
  proposedBlock?: ArticleBlock;
  block?: ArticleBlock;
  instruction?: string;
  [key: string]: unknown;
}
export interface Device {
  id: string;
  name: string;
  createdAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
}
export interface AdminData {
  users: User[];
  modelRuns: Array<Record<string, unknown>>;
  jobs: Job[];
  settings: { model: string; provider: string; signupPaused?: boolean };
  waitlist?: Array<{ email: string; createdAt: string; reason?: string }>;
  credit?: Record<string, unknown> | null;
  alerts?: unknown[];
  metrics?: Record<string, unknown>;
}
