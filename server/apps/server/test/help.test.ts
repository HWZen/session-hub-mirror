import { describe, expect, it } from "vitest";
import { searchRequestSchema, sessionUpsertSchema } from "@session-hub/shared";
import { endpoints, findEndpoint } from "../src/routes/help.js";
import { FakeEmbedProvider, TEST_TOKEN, buildApp } from "./helpers.js";

function request(
  app: ReturnType<typeof buildApp>["app"],
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  token: string | null = TEST_TOKEN,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("help L0", () => {
  it("GET /v1/help 返回全量端点索引", async () => {
    const { app } = buildApp();
    const res = await request(app, "GET", "/v1/help");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      total: number;
      endpoints: Array<{ method: string; path: string; summary: string }>;
      hint: string;
    };
    expect(data.total).toBe(endpoints.length);
    expect(data.endpoints.length).toBe(data.total);
    const paths = data.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain("PUT /v1/sessions");
    expect(paths).toContain("POST /v1/search");
    expect(paths).toContain("GET /v1/help");
    expect(paths).toContain("GET /v1/sessions/:id");
    expect(paths).toContain("GET /v1/sessions/:id/full");
    expect(paths).toContain("GET /v1/sessions/:id/full_length");
    expect(data.hint).toContain("?help=1");
    for (const e of data.endpoints) {
      expect(Object.keys(e).sort()).toEqual(["method", "path", "summary"]);
    }
  });

  it("未认证访问 /v1/help 返回 401", async () => {
    const { app } = buildApp();
    const res = await request(app, "GET", "/v1/help", null);
    expect(res.status).toBe(401);
  });
});

describe("help L1 (?help=1)", () => {
  it("返回端点详情且不执行业务逻辑（不写库）", async () => {
    const { app, repo } = buildApp();
    const res = await request(app, "PUT", "/v1/sessions?help=1");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      method: string;
      path: string;
      summary: string;
      description: string;
      params: Array<{ name: string }>;
      errors: Array<{ status: number }>;
    };
    expect(doc.method).toBe("PUT");
    expect(doc.path).toBe("/v1/sessions");
    expect(doc.description.trim().length).toBeGreaterThan(0);
    expect(doc.params.map((p) => p.name)).toEqual(Object.keys(sessionUpsertSchema.shape));
    expect(doc.errors.some((e) => e.status === 400)).toBe(true);
    expect(repo.list({}, { limit: 10, offset: 0 }).total).toBe(0);
  });

  it("POST /v1/search?help=1 不触发 embedding 调用", async () => {
    const provider = new FakeEmbedProvider("fake");
    const { app } = buildApp(TEST_TOKEN, [provider]);
    const res = await request(app, "POST", "/v1/search?help=1");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { params: Array<{ name: string }> };
    expect(doc.params.map((p) => p.name)).toEqual(Object.keys(searchRequestSchema.shape));
    expect(provider.calls).toBe(0);
  });

  it("路径参数端点可命中（:id 模式匹配）", async () => {
    const { app } = buildApp();
    const res = await request(app, "GET", "/v1/sessions/abc123?help=1");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { path: string; params: Array<{ name: string; in: string }> };
    expect(doc.path).toBe("/v1/sessions/:id");
    expect(doc.params[0]).toMatchObject({ name: "id", in: "path" });
  });

  it("detail 拆分端点（/full、/full_length）可命中且不与 :id 误匹配", async () => {
    const { app } = buildApp();
    const fullRes = await request(app, "GET", "/v1/sessions/abc123/full?help=1");
    expect(fullRes.status).toBe(200);
    const fullDoc = (await fullRes.json()) as { path: string; summary: string };
    expect(fullDoc.path).toBe("/v1/sessions/:id/full");
    expect(fullDoc.summary).toContain("全量详情");

    const lenRes = await request(app, "GET", "/v1/sessions/abc123/full_length?help=1");
    expect(lenRes.status).toBe(200);
    const lenDoc = (await lenRes.json()) as { path: string; returns: Array<{ name: string }> };
    expect(lenDoc.path).toBe("/v1/sessions/:id/full_length");
    expect(lenDoc.returns.map((r) => r.name)).toContain("full_length");

    const baseRes = await request(app, "GET", "/v1/sessions/abc123?help=1");
    const baseDoc = (await baseRes.json()) as { path: string; summary: string };
    expect(baseDoc.path).toBe("/v1/sessions/:id");
    expect(baseDoc.summary).toContain("idx/role/text/ts");
  });

  it("未认证 ?help=1 仍返回 401", async () => {
    const { app } = buildApp();
    const res = await request(app, "PUT", "/v1/sessions?help=1", null);
    expect(res.status).toBe(401);
  });

  it("未收录端点返回 404", async () => {
    const { app } = buildApp();
    const res = await request(app, "GET", "/v1/nonexistent?help=1");
    expect(res.status).toBe(404);
  });

  it("无 ?help=1 时正常放行业务路由", async () => {
    const { app } = buildApp();
    const res = await request(app, "GET", "/v1/help");
    expect(res.status).toBe(200);
    expect((await res.json()) as { total: number }).toHaveProperty("total");
  });
});

describe("help 注册表一致性", () => {
  it("所有端点 description 非空", () => {
    for (const e of endpoints) {
      expect(e.description.trim().length, `${e.method} ${e.path} description 为空`).toBeGreaterThan(0);
    }
  });

  it("所有端点 path 全局唯一（method + path）", () => {
    const keys = endpoints.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("findEndpoint 支持 :id 模式与字面路径", () => {
    expect(findEndpoint("GET", "/v1/sessions/xyz")?.path).toBe("/v1/sessions/:id");
    expect(findEndpoint("GET", "/v1/sessions/xyz/full")?.path).toBe("/v1/sessions/:id/full");
    expect(findEndpoint("GET", "/v1/sessions/xyz/full_length")?.path).toBe("/v1/sessions/:id/full_length");
    expect(findEndpoint("GET", "/v1/sessions")?.path).toBe("/v1/sessions");
    expect(findEndpoint("GET", "/v1/sessions/")).toBeUndefined();
    expect(findEndpoint("PATCH", "/v1/sessions")).toBeUndefined();
  });
});
