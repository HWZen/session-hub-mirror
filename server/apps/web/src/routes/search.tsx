import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, SearchIcon, SparklesIcon, TextSearchIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance, formatRelative } from "@/lib/format";
import { hasAnyFilter, toApiFilters, toSearchParams, type SearchFilterInput } from "@/lib/search-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

type SearchMode = "semantic" | "keyword";

interface SearchParams extends SearchFilterInput {
  q?: string;
  mode?: SearchMode;
  top_k?: number;
}

const FILTER_KEYS = ["agent", "machine", "title", "source_id", "created_from", "created_to", "updated_from", "updated_to"] as const;

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const out: SearchParams = {};
    if (typeof search.q === "string" && search.q !== "") out.q = search.q;
    if (search.mode === "keyword" || search.mode === "semantic") out.mode = search.mode;
    if (typeof search.top_k === "string" && /^\d+$/.test(search.top_k)) out.top_k = Number(search.top_k);
    for (const key of FILTER_KEYS) {
      const value = search[key];
      if (typeof value === "string" && value !== "") out[key] = value;
    }
    return out;
  },
  component: SearchPage,
});

interface NormalizedHit {
  session: { id: string; agent: string; machine: string; source_id: string; title: string | null; updated_at: number };
  distance: number | null;
  matched_by: string[];
  lines: Array<{ message_idx: number; role: string; text: string; source: "text" | "reasoning"; matched_by: string[] }>;
}

interface NormalizedResult {
  kind: SearchMode;
  provider: string;
  total: number;
  items: NormalizedHit[];
}

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(search.q ?? "");
  const [topK, setTopK] = useState(String(search.top_k ?? 10));
  const [agent, setAgent] = useState(search.agent ?? "");
  const [machine, setMachine] = useState(search.machine ?? "");
  const [title, setTitle] = useState(search.title ?? "");
  const [sourceId, setSourceId] = useState(search.source_id ?? "");
  const [createdFrom, setCreatedFrom] = useState(search.created_from ?? "");
  const [createdTo, setCreatedTo] = useState(search.created_to ?? "");
  const [updatedFrom, setUpdatedFrom] = useState(search.updated_from ?? "");
  const [updatedTo, setUpdatedTo] = useState(search.updated_to ?? "");
  const mode: SearchMode = search.mode ?? "semantic";
  const keyword = mode === "keyword";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api.stats() });

  const submitted = (search.q ?? "").trim() !== "";
  const topKNum = /^\d+$/.test(topK) ? Math.min(Math.max(Number(topK), 1), 50) : 10;

  const urlFilters: SearchFilterInput = {
    agent: search.agent,
    machine: search.machine,
    title: search.title,
    source_id: search.source_id,
    created_from: search.created_from,
    created_to: search.created_to,
    updated_from: search.updated_from,
    updated_to: search.updated_to,
  };
  const formFilters: SearchFilterInput = {
    agent,
    machine,
    title,
    source_id: sourceId,
    created_from: createdFrom,
    created_to: createdTo,
    updated_from: updatedFrom,
    updated_to: updatedTo,
  };
  const filterActive = hasAnyFilter(urlFilters);

  const result = useQuery({
    queryKey: [
      "search",
      mode,
      search.q ?? "",
      topKNum,
      search.agent ?? "",
      search.machine ?? "",
      search.title ?? "",
      search.source_id ?? "",
      search.created_from ?? "",
      search.created_to ?? "",
      search.updated_from ?? "",
      search.updated_to ?? "",
    ],
    queryFn: async (): Promise<NormalizedResult> => {
      if (keyword) {
        const res = await api.grep({
          q: search.q ?? "",
          limit: topKNum,
          ...toApiFilters(urlFilters),
        });
        return {
          kind: "keyword",
          provider: "",
          total: res.total,
          items: res.items.map((hit) => ({
            session: hit.session,
            distance: null,
            matched_by: [],
            lines: hit.hits.map((h) => ({
              message_idx: h.message_idx,
              role: h.role,
              text: h.snippet,
              source: "text" as const,
              matched_by: [],
            })),
          })),
        };
      }
      const res = await api.search({
        query: search.q ?? "",
        top_k: topKNum,
        filters: toApiFilters(urlFilters),
      });
      return {
        kind: "semantic",
        provider: res.provider,
        total: res.results.length,
        items: res.results.map((hit) => ({
          session: hit.session,
          distance: hit.distance,
          matched_by: hit.matched_by,
          lines: hit.snippets.map((sn) => ({
            message_idx: sn.message_idx,
            role: sn.role,
            text: sn.text,
            source: sn.source,
            matched_by: sn.matched_by,
          })),
        })),
      };
    },
    enabled: submitted,
    placeholderData: (prev) => prev,
  });
  const data = result.data?.kind === mode ? result.data : undefined;

  function navigateWith(searchOverride: Partial<SearchParams>): void {
    void navigate({
      to: "/search",
      search: { mode: mode !== "semantic" ? mode : undefined, q: search.q, top_k: topKNum, ...searchOverride },
    });
  }

  function submit(): void {
    const q = input.trim();
    if (!q) return;
    navigateWith({ q, top_k: topKNum, ...toSearchParams(formFilters) });
  }

  function applyImmediate(next: SearchFilterInput): void {
    if (!submitted) return;
    navigateWith({ q: search.q, top_k: topKNum, ...toSearchParams(next) });
  }

  function switchMode(next: SearchMode): void {
    if (next === mode) return;
    void navigate({
      to: "/search",
      search: {
        mode: next !== "semantic" ? next : undefined,
        q: search.q,
        top_k: topKNum,
        ...toSearchParams(urlFilters),
      },
    });
  }

  function clearFilters(): void {
    setAgent("");
    setMachine("");
    setTitle("");
    setSourceId("");
    setCreatedFrom("");
    setCreatedTo("");
    setUpdatedFrom("");
    setUpdatedTo("");
    navigateWith({ q: search.q, top_k: topKNum });
  }

  const agents = Object.keys(stats.data?.by_agent ?? {});
  const machines = Object.keys(stats.data?.by_machine ?? {});

  return (
    <Page className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={keyword ? "关键词检索" : "混合检索"}
        description={keyword ? "对话内容字面子串匹配（LIKE 扫描，不依赖 embedding）" : "语义向量 + 词法 BM25 双通道，Session 级 RRF 融合"}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={keyword ? "例如：E_ROLLBACK、bge-m3、frpc 配置…" : "例如：SMB 上 SQLite 禁用 WAL 的方案…"}
              className="h-11 rounded-xl pl-10 text-sm"
            />
          </div>
          <Button type="submit" className="h-11 rounded-xl px-5">
            检索
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <div className="flex overflow-hidden rounded-lg border border-border">
            <button
              type="button"
              onClick={() => switchMode("semantic")}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 transition-colors",
                !keyword ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
              )}
              aria-pressed={!keyword}
            >
              <SparklesIcon className="size-3.5" />
              混合
            </button>
            <button
              type="button"
              onClick={() => switchMode("keyword")}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 transition-colors",
                keyword ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
              )}
              aria-pressed={keyword}
            >
              <TextSearchIcon className="size-3.5" />
              关键词
            </button>
          </div>
          <span>Top</span>
          <div className="w-16">
            <Input
              value={topK}
              onChange={(e) => setTopK(e.target.value)}
              className="h-8 text-center text-xs"
              inputMode="numeric"
            />
          </div>
          <div className="w-32">
            <Select
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                applyImmediate({ ...formFilters, agent: e.target.value });
              }}
              className="h-8 text-xs"
              aria-label="Agent 过滤"
            >
              <option value="">全部 Agent</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              {agent && !agents.includes(agent) ? <option value={agent}>{agent}</option> : null}
            </Select>
          </div>
          <div className="w-40">
            <Select
              value={machine}
              onChange={(e) => {
                setMachine(e.target.value);
                applyImmediate({ ...formFilters, machine: e.target.value });
              }}
              className="h-8 text-xs"
              aria-label="机器过滤"
            >
              <option value="">全部机器</option>
              {machines.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {machine && !machines.includes(machine) ? <option value={machine}>{machine}</option> : null}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <div className="w-44">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 text-xs"
              placeholder="标题包含…"
              aria-label="标题过滤"
            />
          </div>
          <div className="w-44">
            <Input
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="h-8 text-xs"
              placeholder="来源会话 ID"
              aria-label="来源会话 ID 过滤"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>创建</span>
            <div className="w-36">
              <Input
                type="date"
                value={createdFrom}
                onChange={(e) => {
                  setCreatedFrom(e.target.value);
                  applyImmediate({ ...formFilters, created_from: e.target.value });
                }}
                className="h-8 text-xs"
                aria-label="创建时间起点"
              />
            </div>
            <span>–</span>
            <div className="w-36">
              <Input
                type="date"
                value={createdTo}
                onChange={(e) => {
                  setCreatedTo(e.target.value);
                  applyImmediate({ ...formFilters, created_to: e.target.value });
                }}
                className="h-8 text-xs"
                aria-label="创建时间终点"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span>更新</span>
            <div className="w-36">
              <Input
                type="date"
                value={updatedFrom}
                onChange={(e) => {
                  setUpdatedFrom(e.target.value);
                  applyImmediate({ ...formFilters, updated_from: e.target.value });
                }}
                className="h-8 text-xs"
                aria-label="更新时间起点"
              />
            </div>
            <span>–</span>
            <div className="w-36">
              <Input
                type="date"
                value={updatedTo}
                onChange={(e) => {
                  setUpdatedTo(e.target.value);
                  applyImmediate({ ...formFilters, updated_to: e.target.value });
                }}
                className="h-8 text-xs"
                aria-label="更新时间终点"
              />
            </div>
          </div>
          {filterActive ? (
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
      </form>
      <div className="flex flex-col gap-3">
        {!submitted ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                {keyword ? (
                  <TextSearchIcon className="size-6 text-muted-foreground" />
                ) : (
                  <SparklesIcon className="size-6 text-muted-foreground" />
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {keyword ? "输入关键词，按字面子串匹配消息正文（错误码、函数名、路径）" : "自然语言 + 标识符混合描述，语义与字面双通道定位历史会话"}
              </p>
            </CardContent>
          </Card>
        ) : result.error ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-center gap-3 py-4 text-sm text-destructive">
              <CircleAlertIcon className="size-4 shrink-0" />
              {result.error instanceof ApiError ? result.error.message : "检索失败"}
            </CardContent>
          </Card>
        ) : result.isLoading || !data ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            <span>{keyword ? "关键词扫描中…" : "混合检索中…"}</span>
          </div>
        ) : data.items.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">没有命中的会话</CardContent>
          </Card>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {keyword
                ? `命中 ${data.items.length} 个会话 · ${data.total} 条命中消息`
                : `命中 ${data.items.length} 个会话 · 提供商 ${data.provider}`}
            </p>
            {data.items.map((hit) => (
              <Card key={hit.session.id} className="transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2.5 p-4">
                  <div className="flex items-start gap-3">
                    <Link
                      to="/sessions"
                      search={{ s: hit.session.id }}
                      className="min-w-0 flex-1 text-sm font-medium hover:text-primary hover:underline"
                    >
                      {hit.session.title ?? hit.session.source_id}
                    </Link>
                    {hit.matched_by.length > 0 || hit.distance !== null ? (
                      <div className="ml-auto flex shrink-0 items-start gap-1.5">
                        {hit.matched_by.length > 0 ? (
                          <Badge
                            variant={hit.matched_by.length === 2 ? "success" : "muted"}
                            className="shrink-0 whitespace-nowrap"
                          >
                            {hit.matched_by.map((ch) => (ch === "dense" ? "语义" : "词法")).join(" + ")}
                          </Badge>
                        ) : null}
                        {hit.distance !== null ? (
                          <Badge
                            variant="outline"
                            className="shrink-0 whitespace-nowrap"
                            title="dense 通道最佳距离，仅供参考"
                          >
                            距离 {formatDistance(hit.distance)}
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                      {hit.session.agent}
                    </Badge>
                    <span className="font-mono">{hit.session.machine}</span>
                    <span>{formatRelative(hit.session.updated_at)}</span>
                  </div>
                  <div className="flex flex-col gap-2 border-t border-border/70 pt-2.5">
                    {hit.lines.map((line, i) => (
                      <div key={`${line.message_idx}-${i}`} className="flex gap-2.5 text-xs leading-5">
                        <div className="mt-0.5 flex shrink-0 flex-col items-start gap-1">
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                              line.role === "user" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                            )}
                          >
                            {line.role}
                          </span>
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                              line.source === "reasoning"
                                ? "bg-warning/15 text-warning"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {line.source === "reasoning" ? "思考" : "正文"}
                          </span>
                          {line.matched_by.includes("lexical") ? (
                            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {line.matched_by.length === 2 ? "双路" : "词法"}
                            </span>
                          ) : null}
                        </div>
                        <p className="min-w-0 flex-1 break-words text-muted-foreground">{line.text}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </>
        )}
      </div>
    </Page>
  );
}
