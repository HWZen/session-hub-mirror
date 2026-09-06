import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, SearchIcon, SparklesIcon, TextSearchIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance, formatRelative } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

type SearchMode = "semantic" | "keyword";

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): { q?: string; mode?: SearchMode; top_k?: number; agent?: string; machine?: string } => {
    const out: { q?: string; mode?: SearchMode; top_k?: number; agent?: string; machine?: string } = {};
    if (typeof search.q === "string" && search.q !== "") out.q = search.q;
    if (search.mode === "keyword" || search.mode === "semantic") out.mode = search.mode;
    if (typeof search.top_k === "string" && /^\d+$/.test(search.top_k)) out.top_k = Number(search.top_k);
    if (typeof search.agent === "string" && search.agent !== "") out.agent = search.agent;
    if (typeof search.machine === "string" && search.machine !== "") out.machine = search.machine;
    return out;
  },
  component: SearchPage,
});

interface NormalizedHit {
  session: { id: string; agent: string; machine: string; source_id: string; title: string | null; updated_at: number };
  distance: number | null;
  lines: Array<{ message_idx: number; role: string; text: string }>;
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
  const mode: SearchMode = search.mode ?? "semantic";
  const keyword = mode === "keyword";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submitted = (search.q ?? "").trim() !== "";
  const topKNum = /^\d+$/.test(topK) ? Math.min(Math.max(Number(topK), 1), 50) : 10;
  const result = useQuery({
    queryKey: ["search", mode, search.q ?? "", topKNum, search.agent ?? "", search.machine ?? ""],
    queryFn: async (): Promise<NormalizedResult> => {
      if (keyword) {
        const res = await api.grep({
          q: search.q ?? "",
          limit: topKNum,
          agent: search.agent || undefined,
          machine: search.machine || undefined,
        });
        return {
          kind: "keyword",
          provider: "",
          total: res.total,
          items: res.items.map((hit) => ({
            session: hit.session,
            distance: null,
            lines: hit.hits.map((h) => ({ message_idx: h.message_idx, role: h.role, text: h.snippet })),
          })),
        };
      }
      const res = await api.search({
        query: search.q ?? "",
        top_k: topKNum,
        filters: {
          agent: search.agent || undefined,
          machine: search.machine || undefined,
        },
      });
      return {
        kind: "semantic",
        provider: res.provider,
        total: res.results.length,
        items: res.results.map((hit) => ({
          session: hit.session,
          distance: hit.distance,
          lines: hit.snippets.map((sn) => ({ message_idx: sn.message_idx, role: sn.role, text: sn.text })),
        })),
      };
    },
    enabled: submitted,
    placeholderData: (prev) => prev,
  });
  const data = result.data?.kind === mode ? result.data : undefined;

  function navigateWith(searchOverride: Record<string, string | number | undefined>): void {
    void navigate({
      to: "/search",
      search: { mode: mode !== "semantic" ? mode : undefined, ...searchOverride },
    });
  }

  function submit(): void {
    const q = input.trim();
    if (!q) return;
    navigateWith({ q, top_k: topKNum, agent: agent || undefined, machine: machine || undefined });
  }

  function switchMode(next: SearchMode): void {
    if (next === mode) return;
    const nextMode: SearchMode = next;
    void navigate({
      to: "/search",
      search: {
        mode: nextMode !== "semantic" ? nextMode : undefined,
        q: search.q,
        top_k: topKNum,
        agent: search.agent || undefined,
        machine: search.machine || undefined,
      },
    });
  }

  return (
    <Page className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={keyword ? "关键词检索" : "语义检索"}
        description={keyword ? "对话内容字面子串匹配（LIKE 扫描，不依赖 embedding）" : "跨机器、跨 Agent 的对话内容向量检索"}
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
              语义
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
              onChange={(e) => setAgent(e.target.value)}
              className="h-8 text-xs"
              aria-label="Agent 过滤"
            >
              <option value="">全部 Agent</option>
              <option value="opencode">opencode</option>
              <option value="workbuddy">workbuddy</option>
              <option value="doubao">doubao</option>
            </Select>
          </div>
          <div className="w-40">
            <Select
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              className="h-8 text-xs"
              aria-label="机器过滤"
            >
              <option value="">全部机器</option>
              {machine ? <option value={machine}>{machine}</option> : null}
            </Select>
          </div>
          {submitted ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAgent("");
                setMachine("");
                navigateWith({ q: search.q, top_k: topKNum });
              }}
            >
              清除过滤
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
                {keyword ? "输入关键词，按字面子串匹配消息正文（错误码、函数名、路径）" : "输入自然语言描述，按语义定位历史会话与消息片段"}
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
            <span>{keyword ? "关键词扫描中…" : "向量检索中…"}</span>
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
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      to="/sessions"
                      search={{ s: hit.session.id }}
                      className="min-w-0 text-sm font-medium hover:text-primary hover:underline"
                    >
                      {hit.session.title ?? hit.session.source_id}
                    </Link>
                    {hit.distance !== null ? (
                      <Badge variant={hit.distance < 0.8 ? "success" : hit.distance < 1.1 ? "muted" : "outline"}>
                        距离 {formatDistance(hit.distance)}
                      </Badge>
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
                        <span
                          className={cn(
                            "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            line.role === "user" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {line.role}
                        </span>
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
