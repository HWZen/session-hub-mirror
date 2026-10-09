import { describe, expect, it } from "vitest";
import { buildApp } from "./helpers.js";

interface HealthResponse {
  ok: boolean;
  version: string;
  warnings: string[];
  db: { journal_mode: string; size_bytes: number };
}

describe("health", () => {
  it("无需鉴权并暴露版本号与数据库状态", async () => {
    const { app } = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as HealthResponse;
    expect(data.ok).toBe(true);
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.db.journal_mode).toBe("truncate");
  });

  it("返回 SQLite 主数据库当前分配大小", async () => {
    const { app, db } = buildApp();
    const data = (await (await app.request("/health")).json()) as HealthResponse;
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const pageSize = Number(db.pragma("page_size", { simple: true }));

    expect(Number.isInteger(data.db.size_bytes)).toBe(true);
    expect(data.db.size_bytes).toBeGreaterThan(0);
    expect(data.db.size_bytes).toBe(pageCount * pageSize);
  });

  it("providers 非空时 warnings 为空数组", async () => {
    const { app } = buildApp();
    const data = (await (await app.request("/health")).json()) as HealthResponse;
    expect(data.warnings).toEqual([]);
  });

  it("providers 为空时 warnings 提示未配置提供商且 HTTP 仍 200", async () => {
    const { app } = buildApp(undefined, []);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as HealthResponse;
    expect(data.warnings).toEqual(["未配置任何向量提供商，索引与语义检索不可用"]);
  });
});
