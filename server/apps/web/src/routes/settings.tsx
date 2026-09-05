import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DatabaseBackupIcon,
  PlugZapIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { api, normalizeBaseUrl, type ProviderItem, type ProviderSettingsInput } from "@/lib/api";
import { loadConnection, saveConnection } from "@/lib/settings";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  return (
    <Page className="mx-auto w-full max-w-3xl">
      <PageHeader title="设置" description="浏览器连接凭据与服务端系统设置" />
      <ConnectionCard />
      <ProvidersCard />
      <MaintenanceCard />
    </Page>
  );
}

type Feedback = { kind: "ok" | "fail"; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  const ok = feedback.kind === "ok";
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
        ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
      )}
    >
      {ok ? <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />}
      <span className="break-all">{feedback.text}</span>
    </p>
  );
}

function ConnectionCard() {
  const queryClient = useQueryClient();
  const current = loadConnection();
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [token, setToken] = useState(current.token);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "loading" | "ok" | "fail"; message?: string }>({ state: "idle" });

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(t);
  }, [saved]);

  async function handleTest(): Promise<void> {
    setTest({ state: "loading" });
    try {
      const health = await api.health();
      setTest({ state: "ok", message: `已连接 · journal_mode=${health.db.journal_mode} · 提供商 ${health.embedding.current ?? "无"}` });
    } catch (err) {
      setTest({ state: "fail", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PlugZapIcon className="size-4 text-muted-foreground" />
          <CardTitle>服务端连接</CardTitle>
        </div>
        <CardDescription>
          仅保存在本浏览器；服务地址留空表示同源部署，token 对应服务端环境变量 SH_AUTH_TOKEN
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">服务地址</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="留空 = 同源；例如 http://127.0.0.1:7428" />
          <span className="text-[11px] text-muted-foreground/70">必须带协议与端口；同源部署（本页面就是服务端托管的）留空即可</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Access Token</span>
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="SH_AUTH_TOKEN 的值" type="password" />
        </label>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              saveConnection({ baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() });
              void queryClient.invalidateQueries();
              setSaved(true);
            }}
          >
            保存
          </Button>
          <Button
            variant="outline"
            disabled={test.state === "loading"}
            onClick={() => {
              saveConnection({ baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() });
              void handleTest();
            }}
          >
            {test.state === "loading" ? "测试中…" : "保存并测试"}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <CheckCircle2Icon className="size-3.5" />
              已保存
            </span>
          ) : null}
        </div>
        <FeedbackLine feedback={test.state === "ok" ? { kind: "ok", text: test.message ?? "" } : test.state === "fail" ? { kind: "fail", text: test.message ?? "" } : null} />
      </CardContent>
    </Card>
  );
}

interface EditableProvider {
  rowKey: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  weight: string;
  timeoutMs: string;
  enabled: boolean;
  keyHint: string;
}

function toEditable(item: ProviderItem): EditableProvider {
  const keyHint =
    item.keySource === "inline"
      ? `已配置（尾号 ${item.keyMasked?.slice(4) ?? ""}）`
      : item.keySource === "env"
        ? `环境变量 ${item.apiKeyEnv ?? ""}`
        : "未配置";
  return {
    rowKey: `${item.name}`,
    name: item.name,
    baseUrl: item.baseUrl,
    model: item.model,
    apiKey: "",
    apiKeyEnv: item.apiKeyEnv ?? "",
    weight: String(item.weight),
    timeoutMs: String(item.timeoutMs),
    enabled: item.enabled,
    keyHint,
  };
}

function normalizeRows(rows: EditableProvider[]): string {
  return rows
    .map((r) => [r.name.trim(), r.baseUrl.trim(), r.model.trim(), r.apiKeyEnv.trim(), r.apiKey.trim(), r.weight.trim(), r.timeoutMs.trim(), String(r.enabled)].join("\u0001"))
    .join("\u0002");
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "已启用" : "已停用"}
      onClick={() => onChange(!enabled)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        enabled ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
          enabled && "translate-x-4",
        )}
      />
    </button>
  );
}

function ProvidersCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["provider-settings"], queryFn: () => api.getProviderSettings() });
  const data = settings.data;
  const serverRows = (data?.providers ?? []).map(toEditable);
  const [rows, setRows] = useState<EditableProvider[]>([]);
  const [tests, setTests] = useState<Record<string, { state: "loading" | "ok" | "fail"; text: string }>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saving, setSaving] = useState(false);
  const syncedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const snapshot = JSON.stringify(data.providers);
    if (syncedRef.current === snapshot) return;
    syncedRef.current = snapshot;
    setRows(data.providers.map(toEditable));
    setTests({});
  }, [data]);

  const dirty = normalizeRows(rows) !== normalizeRows(serverRows);

  function updateRow(rowKey: string, patch: Partial<EditableProvider>): void {
    setRows((prev) => prev.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));
  }

  function addRow(): void {
    const next: EditableProvider = {
      rowKey: `new-${Date.now()}`,
      name: `provider-${rows.length + 1}`,
      baseUrl: "http://127.0.0.1:9100/v1",
      model: "bge-m3",
      apiKey: "",
      apiKeyEnv: "",
      weight: "10",
      timeoutMs: "20000",
      enabled: true,
      keyHint: "未配置",
    };
    setRows((prev) => [...prev, next]);
  }

  function removeRow(rowKey: string): void {
    setRows((prev) => prev.filter((r) => r.rowKey !== rowKey));
  }

  function buildInput(): ProviderSettingsInput[] | string {
    const providers: ProviderSettingsInput[] = [];
    for (const r of rows) {
      const name = r.name.trim();
      const baseUrl = r.baseUrl.trim();
      const model = r.model.trim();
      const weight = Number(r.weight);
      const timeoutMs = Number(r.timeoutMs);
      if (!name) return "提供商名称不能为空";
      if (!baseUrl) return `「${name || "未命名"}」的 Base URL 不能为空`;
      if (!model) return `「${name || "未命名"}」的模型不能为空`;
      if (!Number.isInteger(weight) || weight < 0) return `「${name}」的 weight 必须是非负整数`;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return `「${name}」的超时必须在 1000–120000ms 之间`;
      providers.push({
        name,
        baseUrl,
        model,
        apiKey: r.apiKey.trim() || undefined,
        apiKeyEnv: r.apiKeyEnv.trim() || undefined,
        weight,
        enabled: r.enabled,
        timeoutMs,
      });
    }
    return providers;
  }

  async function handleSave(): Promise<void> {
    const providers = buildInput();
    if (typeof providers === "string") {
      setFeedback({ kind: "fail", text: providers });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.putProviderSettings(providers);
      syncedRef.current = null;
      await queryClient.invalidateQueries({ queryKey: ["provider-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
      setFeedback({ kind: "ok", text: `已保存 ${res.count} 个提供商并即时生效` });
    } catch (err) {
      setFeedback({ kind: "fail", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(rowKey: string, name: string): Promise<void> {
    if (!name.trim()) return;
    setTests((prev) => ({ ...prev, [rowKey]: { state: "loading", text: "测试中…" } }));
    try {
      const r = await api.testProvider(name.trim());
      setTests((prev) => ({
        ...prev,
        [rowKey]: r.ok
          ? { state: "ok", text: `探针通过 · ${r.model ?? "?"} · ${r.latencyMs}ms · ${r.dim} 维` }
          : { state: "fail", text: r.error ?? "未知错误" },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [rowKey]: { state: "fail", text: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings2Icon className="size-4 text-muted-foreground" />
          <CardTitle>向量提供商</CardTitle>
        </div>
        <CardDescription>
          模型按提供商配置；检索只使用最高优先级已启用提供商的模型空间，切换模型后需重新索引。weight
          越大越优先，失败自动降级并冷却恢复。配置持久化在服务端
          {data?.file ? <span className="font-mono text-[11px]"> {data.file}</span> : "，保存后即时生效"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {settings.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : settings.error || !data ? (
          <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <CircleAlertIcon className="size-4 shrink-0" />
            无法加载提供商配置：{settings.error instanceof Error ? settings.error.message : "未知错误"}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              {rows.length === 0 ? (
                <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>尚未配置任何向量提供商，索引与语义检索不可用；点击下方「添加提供商」接入 OpenAI 兼容服务（本地推理服务如 Ollama 也按此方式配置）</span>
                </p>
              ) : null}
              {rows.map((row) => {
                const test = tests[row.rowKey];
                return (
                  <div key={row.rowKey} className="flex flex-col gap-2.5 rounded-xl border border-border/70 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Toggle enabled={row.enabled} onChange={(v) => updateRow(row.rowKey, { enabled: v })} />
                      <Input
                        className="w-44 shrink-0"
                        placeholder="名称"
                        value={row.name}
                        onChange={(e) => updateRow(row.rowKey, { name: e.target.value })}
                      />
                      <Input
                        className="min-w-52 flex-1 font-mono text-xs"
                        placeholder="Base URL（OpenAI 兼容 /v1）"
                        value={row.baseUrl}
                        onChange={(e) => updateRow(row.rowKey, { baseUrl: e.target.value })}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => void handleTest(row.rowKey, row.name)}
                      >
                        {test?.state === "loading" ? <Spinner className="size-3.5" /> : null}
                        测试
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        onClick={() => removeRow(row.rowKey)}
                      >
                        <Trash2Icon className="size-3.5" />
                        删除
                      </Button>
                    </div>
                    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">API Key（留空保持不变）</span>
                        <Input
                          type="password"
                          className="text-xs"
                          placeholder={row.keyHint}
                          value={row.apiKey}
                          onChange={(e) => updateRow(row.rowKey, { apiKey: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">密钥环境变量（可选）</span>
                        <Input
                          className="font-mono text-xs"
                          placeholder="如 SH_EMBED_KEY_5070TI"
                          value={row.apiKeyEnv}
                          onChange={(e) => updateRow(row.rowKey, { apiKeyEnv: e.target.value })}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-muted-foreground">模型</span>
                        <Input
                          className="font-mono text-xs"
                          placeholder="如 bge-m3"
                          value={row.model}
                          onChange={(e) => updateRow(row.rowKey, { model: e.target.value })}
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2.5">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-muted-foreground">weight（越大越优先）</span>
                          <Input
                            type="number"
                            min={0}
                            className="text-xs"
                            value={row.weight}
                            onChange={(e) => updateRow(row.rowKey, { weight: e.target.value })}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-muted-foreground">超时（ms）</span>
                          <Input
                            type="number"
                            min={1000}
                            max={120000}
                            step={1000}
                            className="text-xs"
                            value={row.timeoutMs}
                            onChange={(e) => updateRow(row.rowKey, { timeoutMs: e.target.value })}
                          />
                        </label>
                      </div>
                    </div>
                    {test && test.state !== "loading" ? (
                      <p
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs",
                          test.state === "ok" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
                        )}
                      >
                        {test.state === "ok" ? <CheckCircle2Icon className="size-3.5 shrink-0" /> : <CircleAlertIcon className="size-3.5 shrink-0" />}
                        <span className="break-all">{test.text}</span>
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={addRow}>
                <PlusIcon className="size-4" />
                添加提供商
              </Button>
              <Button onClick={() => void handleSave()} disabled={saving || !dirty}>
                {saving ? <Spinner className="size-4" /> : <SaveIcon className="size-4" />}
                保存
              </Button>
              <Button
                variant="ghost"
                disabled={!dirty}
                onClick={() => {
                  syncedRef.current = null;
                  setRows(serverRows.map((r) => ({ ...r })));
                  setTests({});
                  setFeedback(null);
                }}
              >
                <RotateCcwIcon className="size-4" />
                重置
              </Button>
              {dirty ? <span className="text-xs text-warning">有未保存的修改</span> : null}
            </div>
            <FeedbackLine feedback={feedback} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MaintenanceCard() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const reindex = useMutation({
    mutationFn: () => api.reindex(),
    onSuccess: (data) => {
      setFeedback({
        kind: data.failed === 0 ? "ok" : "fail",
        text:
          data.failed === 0
            ? `补索引完成：本次 ${data.indexed}/${data.total} 条${data.remaining > 0 ? `，剩余 ${data.remaining} 条未索引（可再次点击）` : ""}`
            : `补索引完成但部分失败：成功 ${data.indexed}/${data.total}，失败 ${data.failed}（多因当前提供商不可用）`,
      });
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (err) => {
      setFeedback({ kind: "fail", text: err instanceof Error ? err.message : String(err) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <DatabaseBackupIcon className="size-4 text-muted-foreground" />
          <CardTitle>维护</CardTitle>
        </div>
        <CardDescription>
          服务端运行时会自动为未索引会话补建向量（默认每 30 秒一轮，保存提供商配置后立即提前触发）；此按钮为手动立即触发（每次最多 200 条）
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <div>
          <Button onClick={() => reindex.mutate()} disabled={reindex.isPending}>
            {reindex.isPending ? <Spinner className="size-4" /> : <DatabaseBackupIcon className="size-4" />}
            {reindex.isPending ? "索引中…" : "重建索引"}
          </Button>
        </div>
        <FeedbackLine feedback={feedback} />
      </CardContent>
    </Card>
  );
}
