import { OpenCode, type OpenCodeClient, type SessionInfo, type SessionMessageInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SESSION_LIMITS,
  loadConfig,
  uploadSession,
  mirrorDelete,
  type SessionHubConfig,
  type UploadResult,
  type DeleteMirrorResult,
  transformSession,
  type PluginSourceMessage,
  type PluginSourceSession,
  type SyncEvent,
  type TransformedSession,
} from "./plugin.js";

const V2_VERSION = "2.0.26";

/**
 * V2 公共事件流 → 同步信号。
 * 2.0.26 执行终态统一归并为 idle；shutdown 中断不视为完成。
 * 保留旧 idle/status 兼容；删除只认 session.deleted。
 */
export function classifyV2Event(event: { type?: unknown; data?: unknown }): SyncEvent | null {
  const data =
    typeof event?.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : null;
  if (!data || typeof data["sessionID"] !== "string" || data["sessionID"].length === 0) return null;
  const sourceId = data["sessionID"];
  if (event.type === "session.idle" || event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
    return { type: "session.idle", source_id: sourceId };
  }
  if (event.type === "session.execution.interrupted") {
    const reason = data["reason"];
    return reason === "user" || reason === "superseded" || reason === "inactivity"
      ? { type: "session.idle", source_id: sourceId }
      : null;
  }
  if (event.type === "session.status") {
    const status = data["status"];
    if (typeof status === "object" && status !== null && (status as Record<string, unknown>)["type"] === "idle") {
      return { type: "session.idle", source_id: sourceId };
    }
    return null;
  }
  if (event.type === "session.deleted") return { type: "session.deleted", source_id: sourceId };
  return null;
}

/**
 * 显式 role 映射表：V2 消息种类 → 上传 role。
 * 未列出的未来种类按原 type 透传（长度合法时），保证不会静默丢弃历史。
 */
export const V2_ROLE_BY_TYPE: Record<string, string> = {
  "agent-switched": "agent-switched",
  "model-switched": "model-switched",
  "location-switched": "location-switched",
  user: "user",
  synthetic: "synthetic",
  system: "system",
  skill: "skill",
  shell: "shell",
  assistant: "assistant",
  compaction: "compaction",
  idle: "idle",
};

function v2Role(value: unknown): string {
  if (typeof value === "string") {
    const mapped = V2_ROLE_BY_TYPE[value];
    if (mapped !== undefined) return mapped;
    if (value.length >= 1 && value.length <= 64) return value;
  }
  return "unknown";
}

/**
 * V2 消息 → 源消息的无损映射。
 * - assistant 的原序 content[] 顶层进入 raw（含明文 reasoning，兼容现有 raw 索引扫描）。
 * - synthetic 正文标记 synthetic:true：不进入 text，但保留在 raw。
 * - 完整源消息以带版本标识的 envelope 附在 raw 末尾，任何种类都不被丢弃。
 */
export function mapV2Messages(messages: SessionMessageInfo[]): PluginSourceMessage[] {
  return messages.map((message) => {
    const parts: unknown[] = [];
    switch (message.type) {
      case "assistant":
        parts.push(...message.content);
        break;
      case "user":
      case "system":
      case "skill":
        parts.push({ type: "text", text: message.text });
        break;
      case "synthetic":
        parts.push({ type: "text", text: message.text, synthetic: true });
        break;
      case "shell":
        if (typeof message.output?.output === "string") {
          parts.push({ type: "text", text: message.output.output });
        }
        break;
      case "compaction":
        if ("summary" in message && typeof message.summary === "string") {
          parts.push({ type: "text", text: message.summary });
        }
        if ("recent" in message && typeof message.recent === "string") {
          parts.push({ type: "text", text: message.recent });
        }
        break;
      case "idle":
      case "agent-switched":
      case "model-switched":
      case "location-switched":
        break;
      default:
        break;
    }
    parts.push({ type: "opencode-v2-envelope", version: V2_VERSION, message });
    return { role: v2Role(message.type), time_created: message.time.created, parts };
  });
}

/**
 * 只读拉取同一实例的完整持久历史。
 * 首请求 asc + limit 200；后续只使用 cursor.next，直到空页结束；
 * 游标重复、非空页缺少 next、重复消息 ID 都视为分页异常并终止（不上传半份历史）。
 */
export async function readAllSessionMessages(
  client: {
    message: {
      list(input: {
        sessionID: string;
        limit?: number;
        order?: "asc" | "desc";
        cursor?: string;
      }): Promise<{ data: SessionMessageInfo[]; cursor: { next?: string | null } }>;
    };
  },
  sessionID: string,
): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  const seenCursors = new Set<string>();
  const seenIDs = new Set<string>();
  let page = await client.message.list({ sessionID, limit: 200, order: "asc" });
  while (page.data.length > 0) {
    for (const message of page.data) {
      if (typeof message.id === "string" && message.id.length > 0) {
        if (seenIDs.has(message.id)) throw new Error("OpenCode 消息分页出现重复消息 ID");
        seenIDs.add(message.id);
      }
      messages.push(message);
    }
    const next = page.cursor.next;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error("OpenCode 消息分页在读取到空页前结束");
    }
    if (seenCursors.has(next)) throw new Error("OpenCode 消息分页游标重复");
    seenCursors.add(next);
    page = await client.message.list({ sessionID, cursor: next });
  }
  return messages;
}

export interface StableSessionSnapshot {
  session: SessionInfo;
  messages: SessionMessageInfo[];
}

function sameSessionVersion(before: SessionInfo, after: SessionInfo): boolean {
  return (
    before.id === after.id &&
    before.parentID === after.parentID &&
    before.projectID === after.projectID &&
    before.title === after.title &&
    before.subpath === after.subpath &&
    before.location.directory === after.location.directory &&
    before.time.created === after.time.created &&
    before.time.updated === after.time.updated
  );
}

/**
 * 读取前后检查源会话版本；检测到变化时有限重读，仍不一致则终止同步（不覆盖完整镜像）。
 */
export async function readStableSessionSnapshot(
  client: {
    session: { get(input: { sessionID: string }): Promise<SessionInfo> };
    message: {
      list(input: {
        sessionID: string;
        limit?: number;
        order?: "asc" | "desc";
        cursor?: string;
      }): Promise<{ data: SessionMessageInfo[]; cursor: { next?: string | null } }>;
    };
  },
  sessionID: string,
): Promise<StableSessionSnapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await client.session.get({ sessionID });
    if (before.id !== sessionID) throw new Error("OpenCode 返回了不匹配的会话 ID");
    const messages = await readAllSessionMessages(client, sessionID);
    const after = await client.session.get({ sessionID });
    if (sameSessionVersion(before, after)) return { session: after, messages };
  }
  throw new Error("读取会话历史期间源会话发生变化，暂停本次同步");
}

export function sessionInfoFromV2(session: SessionInfo): PluginSourceSession {
  const created = typeof session.time?.created === "number" ? session.time.created : 0;
  const updated = typeof session.time?.updated === "number" ? session.time.updated : created;
  return {
    id: session.id,
    title: typeof session.title === "string" ? session.title : null,
    directory: typeof session.location?.directory === "string" ? session.location.directory : null,
    time_created: created,
    time_updated: updated,
  };
}

function v2TextLength(message: PluginSourceMessage): number {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record["type"] !== "text" || typeof record["text"] !== "string") continue;
    if (record["synthetic"] === true) continue;
    pieces.push(record["text"]);
  }
  return pieces.join("\n\n").length;
}

export type V2PayloadBuild = { payload: TransformedSession } | { overLimit: string };

/**
 * V2 快照 → 上传载荷。超限（消息数/单条文本/标题/cwd）时不截断、不上传，交由调用方告警并暂停该会话同步。
 */
export function buildV2Payload(snapshot: StableSessionSnapshot, machine: string): V2PayloadBuild {
  const { session, messages } = snapshot;
  if (messages.length > SESSION_LIMITS.messagesMax) return { overLimit: "messages" };
  const mapped = mapV2Messages(messages);
  for (const message of mapped) {
    if (v2TextLength(message) > SESSION_LIMITS.textMax) return { overLimit: "text" };
  }
  const title = typeof session.title === "string" ? session.title : null;
  if (title !== null && title.length > SESSION_LIMITS.titleMax) return { overLimit: "title" };
  const directory = typeof session.location?.directory === "string" ? session.location.directory : null;
  if (directory !== null && directory.length > SESSION_LIMITS.cwdMax) return { overLimit: "cwd" };
  return { payload: transformSession(sessionInfoFromV2(session), mapped, machine) };
}

export interface V2Connection {
  endpoint: string;
  username: string;
  password: string | null;
}

export type V2ConnectionParse = ({ ok: true } & V2Connection) | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1", "[0:0:0:0:0:0:0:1]"]);

/**
 * 解析 V2 显式连接配置（插件 options）。只允许 loopback http(s)，缺失或非法时明确报未就绪。
 */
export function parseV2Connection(options: Readonly<Record<string, unknown>> | undefined): V2ConnectionParse {
  const endpoint = options?.["endpoint"];
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { ok: false, reason: "缺少 OpenCode endpoint 连接配置" };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint 不是合法 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "endpoint 必须是 http(s) 地址" };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: "endpoint 必须指向 loopback 地址" };
  }
  const auth = options?.["auth"];
  let username = "opencode";
  let password: string | null = null;
  if (auth !== undefined) {
    if (typeof auth !== "object" || auth === null) return { ok: false, reason: "auth 必须是对象" };
    const record = auth as Record<string, unknown>;
    if (record["username"] !== undefined) {
      if (typeof record["username"] !== "string" || record["username"].length === 0) {
        return { ok: false, reason: "auth.username 无效" };
      }
      username = record["username"];
    }
    if (typeof record["password"] !== "string" || record["password"].length === 0) {
      return { ok: false, reason: "auth.password 无效" };
    }
    password = record["password"];
  }
  return { ok: true, endpoint: endpoint.replace(/\/+$/, ""), username, password };
}

function normalizePath(value: string, projectDirectory: string): string | null {
  try {
    const raw = value.startsWith("file:") ? fileURLToPath(value) : value;
    return isAbsolute(raw) ? resolve(raw) : resolve(projectDirectory, raw);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface V2CapabilityClient {
  server: { info(): PromiseLike<{ version?: unknown; pid?: unknown }> };
  plugin: { list(input: { location: { directory: string } }): PromiseLike<{ data?: unknown }> };
}

export interface VerifyV2Options {
  appVersion: string;
  locationDirectory: string;
  selfUrl?: string;
  hostPID?: number;
}

/**
 * 同实例能力校验：版本一致 + 所连实例 pid 等于宿主进程 + session-hub 处于 active；
 * 本地来源时还要求来源路径与本实例同一文件。任一不满足即拒绝上传。
 * 版本与插件路径可被另一进程伪装，PID 取 server.info 的实际返回值，是唯一进程级证据。
 */
export async function verifyV2Instance(client: V2CapabilityClient, options: VerifyV2Options): Promise<void> {
  const info = await client.server.info();
  if (typeof info?.version !== "string" || info.version !== options.appVersion) {
    throw new Error(`OpenCode 实例版本不匹配（宿主 ${options.appVersion}）`);
  }
  const hostPID = options.hostPID ?? process.pid;
  if (typeof info.pid !== "number" || info.pid !== hostPID) {
    throw new Error(`OpenCode 实例进程不匹配（PID ${String(info.pid)}）`);
  }
  const list = await client.plugin.list({ location: { directory: options.locationDirectory } });
  const entries = Array.isArray(list?.data) ? list.data : [];
  let entry: Record<string, unknown> | undefined;
  for (const item of entries) {
    if (typeof item === "object" && item !== null && (item as Record<string, unknown>)["id"] === "session-hub") {
      entry = item as Record<string, unknown>;
      break;
    }
  }
  if (!entry) throw new Error("所连 OpenCode 实例未加载 session-hub 插件");
  const state = entry["state"];
  if (typeof state !== "object" || state === null || (state as Record<string, unknown>)["status"] !== "active") {
    throw new Error("所连实例的 session-hub 插件状态异常");
  }
  const source = entry["source"];
  if (typeof source === "object" && source !== null) {
    const record = source as Record<string, unknown>;
    if (record["type"] === "local" && typeof record["path"] === "string" && options.selfUrl !== undefined) {
      const self = normalizePath(options.selfUrl, options.locationDirectory);
      const remote = normalizePath(record["path"], options.locationDirectory);
      if (self === null || remote === null || !samePath(self, remote)) {
        throw new Error("所连实例的 session-hub 插件来源与本实例不一致");
      }
    }
  }
}

type V2ReadClient = Pick<OpenCodeClient, "server" | "plugin" | "session" | "message">;
type V2Log = (level: "info" | "warn" | "error", message: string) => void;

export interface V2SetupDependencies {
  loadConfig: () => SessionHubConfig | null;
  makeClient: (options: Parameters<typeof OpenCode.make>[0]) => V2ReadClient;
  readSnapshot: (client: V2ReadClient, sessionID: string) => Promise<StableSessionSnapshot>;
  upload: (config: SessionHubConfig, payload: TransformedSession, signal?: AbortSignal) => Promise<UploadResult>;
  mirrorDelete: (config: SessionHubConfig, machine: string, sourceID: string, signal?: AbortSignal) => Promise<DeleteMirrorResult>;
  log: V2Log;
  debounceMs: number;
  machine: string;
  selfUrl: string;
  hostPID: number;
}

export function createSessionHubV2Setup(overrides: Partial<V2SetupDependencies> = {}): Plugin.Plugin["setup"] {
  const deps: V2SetupDependencies = {
    loadConfig,
    makeClient: OpenCode.make,
    readSnapshot: readStableSessionSnapshot,
    upload: uploadSession,
    mirrorDelete,
    log: (level, message) => console[level](message),
    debounceMs: 3000,
    machine: hostname(),
    selfUrl: import.meta.url,
    hostPID: process.pid,
    ...overrides,
  };
  return async (ctx) => {
    const config = deps.loadConfig();
    const connection = parseV2Connection(ctx.options);
    if (!config) {
      deps.log("warn", "session-hub: 未配置，插件已禁用");
      return;
    }
    if (!connection.ok) {
      deps.log("warn", `session-hub: 未就绪：${connection.reason}`);
      return;
    }
    const controller = new AbortController();
    const headers: Record<string, string> = {};
    if (connection.password !== null) {
      headers["authorization"] = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`;
    }
    const client = deps.makeClient({
      baseUrl: connection.endpoint,
      headers,
      fetch: (input, init) => {
        const signals = [controller.signal, AbortSignal.timeout(config.timeoutMs)];
        const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (requestSignal) signals.push(requestSignal);
        return globalThis.fetch(input, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
      },
    });
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const active = new Map<string, Promise<void>>();
    const rerun = new Set<string>();
    const tombstones = new Set<string>();
    const deletions = new Map<string, Promise<void>>();
    const deletedMirrors = new Set<string>();
    let verification: Promise<boolean> | undefined;
    const ensureVerified = (): Promise<boolean> => {
      if (verification !== undefined) return verification;
      verification = verifyV2Instance(client, {
        appVersion: ctx.app.version,
        locationDirectory: ctx.location.directory,
        selfUrl: deps.selfUrl,
        hostPID: deps.hostPID,
      }).then(() => true).catch(() => {
        if (!controller.signal.aborted) deps.log("error", "session-hub: 未就绪，实例版本/进程/来源校验失败");
        return false;
      }).finally(() => { verification = undefined; });
      return verification;
    };
    const sync = async (sourceID: string) => {
      if (!(await ensureVerified()) || controller.signal.aborted || tombstones.has(sourceID)) return;
      const requestOptions = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]) };
      const hostBefore = await ctx.session.get({ sessionID: sourceID }, requestOptions);
      if (controller.signal.aborted || tombstones.has(sourceID)) return;
      const snapshot = await deps.readSnapshot(client, sourceID);
      if (controller.signal.aborted || tombstones.has(sourceID)) return;
      const hostAfter = await ctx.session.get({ sessionID: sourceID }, requestOptions);
      if (hostBefore.id !== sourceID || !sameSessionVersion(hostBefore, snapshot.session) || !sameSessionVersion(snapshot.session, hostAfter)) {
        deps.log("error", "session-hub: 宿主源会话与 endpoint 快照不一致，暂停同步");
        return;
      }
      const result = buildV2Payload(snapshot, deps.machine);
      if ("overLimit" in result) {
        deps.log("warn", `session-hub: 超限，暂停同步 (${result.overLimit})`);
        return;
      }
      if (!controller.signal.aborted && !tombstones.has(sourceID)) {
        try {
          const upload = await deps.upload(config, result.payload, controller.signal);
          deps.log(upload.ok ? "info" : "error", `session-hub: upload status=${upload.status} messages=${result.payload.messages.length}`);
        } catch {
          if (!controller.signal.aborted) deps.log("error", "session-hub: upload failed");
        }
      }
    };
    const startSync = (sourceID: string) => {
      if (controller.signal.aborted || tombstones.has(sourceID)) return;
      if (active.has(sourceID)) {
        rerun.add(sourceID);
        return;
      }
      const work = sync(sourceID)
        .catch(() => deps.log("error", "session-hub: sync failed"))
        .finally(() => {
          active.delete(sourceID);
          if (rerun.delete(sourceID)) startSync(sourceID);
        });
      active.set(sourceID, work);
    };
    const stop = () => {
      controller.abort();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      rerun.clear();
    };
    const stream = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const classified = classifyV2Event(event);
        if (!classified) continue;
        const sourceID = classified.source_id;
        const timer = pending.get(sourceID);
        if (timer !== undefined) clearTimeout(timer);
        if (classified.type === "session.deleted") {
          pending.delete(sourceID);
          rerun.delete(sourceID);
          if (deletions.has(sourceID) || deletedMirrors.has(sourceID)) continue;
          tombstones.add(sourceID);
          const work = (async () => {
            await active.get(sourceID);
            if (controller.signal.aborted || !(await ensureVerified()) || controller.signal.aborted) return;
            const result = await deps.mirrorDelete(config, deps.machine, sourceID, controller.signal);
            if (result.found === result.deleted) deletedMirrors.add(sourceID);
            deps.log(result.found === result.deleted ? "info" : "warn", `session-hub: delete mirror found=${result.found} deleted=${result.deleted}`);
          })().catch(() => deps.log("error", "session-hub: delete mirror failed"))
            .finally(() => deletions.delete(sourceID));
          deletions.set(sourceID, work);
          continue;
        }
        if (tombstones.has(sourceID)) continue;
        rerun.delete(sourceID);
        pending.set(sourceID, setTimeout(() => {
          pending.delete(sourceID);
          startSync(sourceID);
        }, deps.debounceMs));
      }
      if (!controller.signal.aborted) deps.log("warn", "session-hub: event stream ended");
      stop();
    })().catch(() => {
      if (!controller.signal.aborted) deps.log("error", "session-hub: event stream failed");
      stop();
    });
    return async () => {
      stop();
      await stream;
      await Promise.all([...active.values(), ...deletions.values()]);
    };
  };
}
