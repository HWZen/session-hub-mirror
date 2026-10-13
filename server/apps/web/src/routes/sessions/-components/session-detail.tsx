import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import {
  BotIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  FolderIcon,
  ListChecksIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { filterConversationMessages } from "@/lib/conversation";
import { formatTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const detail = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
    retry: false,
  });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() });

  if (detail.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return <EmptyState icon={CircleAlertIcon} title="会话不存在或已删除" />;
  }
  if (detail.error) {
    return (
      <EmptyState
        icon={CircleAlertIcon}
        title="加载失败"
        description={detail.error instanceof Error ? detail.error.message : String(detail.error)}
      />
    );
  }
  const s = detail.data!;
  const messages = filterConversationMessages(s.messages);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b border-border/70 px-4 py-3.5 md:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 max-md:hidden">
              <h2 className="truncate text-base font-semibold">{s.title ?? s.source_id}</h2>
            </div>
            <Link to="/sessions" search={{}} className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground md:hidden">
              <ChevronLeftIcon className="size-3.5" />
              返回列表
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="default">{s.agent}</Badge>
              <Badge variant="outline" className="font-mono">
                {s.machine}
              </Badge>
              <IndexBadge
                indexedAt={s.indexed_at}
                indexedModel={s.indexed_model}
                activeModel={health.data?.embedding.model ?? null}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>创建 {formatTime(s.created_at)}</span>
              <span>更新 {formatTime(s.updated_at)}</span>
              <span className="font-mono">source_id {s.source_id}</span>
              {s.cwd ? (
                <span className="inline-flex items-center gap-1">
                  <FolderIcon className="size-3" />
                  <span className="font-mono">{s.cwd}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.map((m) => (
            <MessageBubble key={m.idx} idx={m.idx} role={m.role} text={m.text} ts={m.ts} raw={m.raw} />
          ))}
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">此会话没有消息</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function IndexBadge({
  indexedAt,
  indexedModel,
  activeModel,
}: {
  indexedAt: number | null;
  indexedModel: string | null;
  activeModel: string | null;
}) {
  if (indexedAt === null) {
    return <Badge variant="warning">未索引</Badge>;
  }
  const model = indexedModel ?? "";
  if (activeModel === null || activeModel === "") {
    return (
      <Badge variant="warning" title="活跃模型未知（提供商未配置或健康信息未加载），无法确认检索是否覆盖当前模型空间">
        <ListChecksIcon className="size-3" />
        已索引{model ? ` · ${model}` : ""}
      </Badge>
    );
  }
  if (indexedModel === activeModel) {
    return (
      <Badge variant="success">
        <ListChecksIcon className="size-3" />
        已索引{model ? ` · ${model}` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="warning" title="当前模型空间未索引，检索覆盖不到，等待后台补索引或手动重建">
      <ListChecksIcon className="size-3" />
      已索引(旧模型 {model || "未知"})
    </Badge>
  );
}

function MessageBubble({
  idx,
  role,
  text,
  ts,
  raw,
}: {
  idx: number;
  role: string;
  text: string;
  ts: number | null;
  raw: unknown;
}) {
  const kind = role === "user" ? "user" : role === "assistant" ? "assistant" : "tool";
  const Icon: ComponentType<{ className?: string }> = kind === "user" ? UserIcon : kind === "assistant" ? BotIcon : WrenchIcon;
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border",
          kind === "user" && "border-primary/25 bg-primary/10 text-primary",
          kind === "assistant" && "border-border bg-muted text-foreground",
          kind === "tool" && "border-border bg-muted/60 text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{role}</span>
          <span>#{idx}</span>
          {ts !== null ? <span>{formatTime(ts)}</span> : null}
        </div>
        <div
          className={cn(
            "rounded-xl border px-4 py-3 text-sm leading-6",
            kind === "user" && "border-primary/20 bg-primary/5",
            kind === "assistant" && "border-border bg-card",
            kind === "tool" && "border-border bg-muted/40",
          )}
        >
          {text ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            <p className="text-xs italic text-muted-foreground">（无文本内容）</p>
          )}
          {raw !== null && raw !== undefined ? (
            <details className="mt-2 group">
              <summary className="cursor-pointer select-none text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                原始 JSON
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap">
                {safeStringify(raw)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
