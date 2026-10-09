export interface DshSessionHeader {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
  agentPreset?: string;
  [key: string]: unknown;
}

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
  [key: string]: unknown;
}

export interface DshSessionSnapshot {
  header: DshSessionHeader;
  events: readonly DshSessionEvent[];
  lastSeq: number;
}

export interface DshPersistenceReadResult {
  events: readonly DshSessionEvent[];
  eventState?: string;
}

export interface DshPersistenceReadHandle {
  readonly header: DshSessionHeader;
  read(offset?: number, length?: number): Promise<DshPersistenceReadResult>;
  close(): Promise<void> | void;
}

export interface DshPersistenceListEntry {
  header: DshSessionHeader;
}

export interface DshSessionPersistence {
  list(): Promise<readonly DshPersistenceListEntry[]>;
  open(id: string, access: "read"): Promise<DshPersistenceReadHandle>;
}

export interface DshLiveSession {
  readonly id: string;
}

export interface DshSessionsService {
  get(id: string): DshLiveSession | undefined;
  flush(session: DshLiveSession): Promise<unknown>;
}

export interface DshHubMessage {
  role: string;
  text?: string;
  ts?: number;
  raw: unknown;
}

export interface DshHubSession {
  agent: "dsh";
  machine: string;
  source_id: string;
  title?: string;
  cwd?: string;
  created_at: number;
  updated_at: number;
  messages: DshHubMessage[];
}

export interface UploadResult {
  ok: boolean;
  status: number;
}

export interface SubprocessCapturedOutput {
  text: string;
  nextOffset: number;
  lossy: boolean;
  spillPath?: string;
}

export interface SubprocessStreamCapture {
  readFrom(offset: number): SubprocessCapturedOutput;
}

export interface DshSubprocessHandle {
  done: Promise<{ exitCode: number | null; signal?: string | null }>;
  collected: {
    stdout?: SubprocessStreamCapture;
    stderr?: SubprocessStreamCapture;
  };
}

export interface DshSubprocessService {
  resolveExecutable(name: "node"): Promise<string>;
  spawn(options: {
    argv: string[];
    cwd?: string;
    stdio: {
      stdin: { data: string };
      stdout: { maxBytes: number };
      stderr: { maxBytes: number };
    };
    graceMs: number;
  }): DshSubprocessHandle;
}

export interface DshFsTarget {
  readonly targetKey: unknown;
  readonly displayPath: string;
}

export interface DshFsService {
  resolve(path: string, options?: { cwd?: string }): Promise<DshFsTarget>;
  processPath(target: DshFsTarget): string;
  readText(target: DshFsTarget): Promise<string>;
}

export interface RetryScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface DshLogger {
  info(message: string): void;
  warn(message: string): void;
}
