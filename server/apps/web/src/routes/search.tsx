import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDistance, formatRelative } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): { q?: string; top_k?: number; agent?: string; machine?: string } => {
    const out: { q?: string; top_k?: number; agent?: string; machine?: string } = {};
    if (typeof search.q === "string" && search.q !== "") out.q = search.q;
    if (typeof search.top_k === "string" && /^\d+$/.test(search.top_k)) out.top_k = Number(search.top_k);
    if (typeof search.agent === "string" && search.agent !== "") out.agent = search.agent;
    if (typeof search.machine === "string" && search.machine !== "") out.machine = search.machine;
    return out;
  },
  component: SearchPage,
});

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(search.q ?? "");
  const [topK, setTopK] = useState(String(search.top_k ?? 10));
  const [agent, setAgent] = useState(search.agent ?? "");
  const [machine, setMachine] = useState(search.machine ?? "");

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submitted = (search.q ?? "").trim() !== "";
  const topKNum = /^\d+$/.test(topK) ? Math.min(Math.max(Number(topK), 1), 50) : 10;
  const result = useQuery({
    queryKey: ["search", search.q ?? "", topKNum, search.agent ?? "", search.machine ?? ""],
    queryFn: () =>
      api.search({
        query: search.q ?? "",
        top_k: topKNum,
        filters: {
          agent: search.agent || undefined,
          machine: search.machine || undefined,
        },
      }),
    enabled: submitted,
    placeholderData: (prev) => prev,
  });

  function submit(): void {
    const q = input.trim();
    if (!q) return;
    void navigate({
      to: "/search",
      search: { q, top_k: topKNum, agent: agent || undefined, machine: machine || undefined },
    });
  }

  return (
    <Page className="mx-auto w-full max-w-3xl">
      <PageHeader title="语义检索" description="跨机器、跨 Agent 的对话内容向量检索" />
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
              placeholder="例如：SMB 上 SQLite 禁用 WAL 的方案…"
              className="h-11 rounded-xl pl-10 text-sm"
            />
          </div>
          <Button type="submit" className="h-11 rounded-xl px-5">
            检索
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
                void navigate({ to: "/search", search: { q: search.q, top_k: topKNum } });
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
                <SparklesIcon className="size-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">输入自然语言描述，按语义定位历史会话与消息片段</p>
            </CardContent>
          </Card>
        ) : result.isLoading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-5" />
            <span>向量检索中…</span>
          </div>
        ) : result.error ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-center gap-3 py-4 text-sm text-destructive">
              <CircleAlertIcon className="size-4 shrink-0" />
              {result.error instanceof ApiError ? result.error.message : "检索失败"}
            </CardContent>
          </Card>
        ) : (result.data?.results.length ?? 0) === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">没有命中的会话</CardContent>
          </Card>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              命中 {result.data!.results.length} 个会话 · 提供商 {result.data!.provider}
            </p>
            {result.data!.results.map((hit) => (
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
                    <Badge variant={hit.distance < 0.8 ? "success" : hit.distance < 1.1 ? "muted" : "outline"}>
                      距离 {formatDistance(hit.distance)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                      {hit.session.agent}
                    </Badge>
                    <span className="font-mono">{hit.session.machine}</span>
                    <span>{formatRelative(hit.session.updated_at)}</span>
                  </div>
                  <div className="flex flex-col gap-2 border-t border-border/70 pt-2.5">
                    {hit.snippets.map((sn, i) => (
                      <div key={`${sn.message_idx}-${i}`} className="flex gap-2.5 text-xs leading-5">
                        <span
                          className={cn(
                            "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            sn.role === "user" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {sn.role}
                        </span>
                        <p className="min-w-0 flex-1 break-words text-muted-foreground">{sn.text}</p>
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
