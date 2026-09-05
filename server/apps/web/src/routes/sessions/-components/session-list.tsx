import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowRightIcon, BoxesIcon, LoaderCircleIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { api, ApiError, type SessionListItem } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/cn";

const PAGE_SIZE = 50;

export function SessionList({ activeSessionId }: { activeSessionId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState("");
  const [machine, setMachine] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [page, setPage] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(null);

  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api.stats() });
  const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : undefined;
  const list = useQuery({
    queryKey: ["sessions", "page", agent, machine, fromMs ?? 0, page],
    queryFn: () =>
      api.listSessions({
        agent: agent || undefined,
        machine: machine || undefined,
        created_from: fromMs,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: (prev) => prev,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      setPendingDelete(null);
      if (activeSessionId === pendingDelete?.id) {
        void navigate({ to: "/sessions", search: {} });
      }
    },
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const hasPrev = page > 0;
  const hasNext = rangeEnd < total;

  function resetFilters(): void {
    setAgent("");
    setMachine("");
    setFromDate("");
    setPage(0);
  }

  return (
    <>
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">会话</h1>
          {!list.isLoading ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              共 {total.toLocaleString("zh-CN")} 个
              {list.isFetching && list.isPlaceholderData ? "（更新中…）" : ""}
            </p>
          ) : null}
        </div>
        <Button variant="outline" size="icon-sm" onClick={() => void list.refetch()} aria-label="刷新" title="刷新">
          {list.isFetching ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <RotateCcwIcon className="size-3.5" />}
        </Button>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-border/70 px-3 py-2.5">
        <Select
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            setPage(0);
          }}
          className="h-8 text-xs"
          aria-label="按 Agent 过滤"
        >
          <option value="">全部 Agent</option>
          {Object.keys(stats.data?.by_agent ?? {}).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          value={machine}
          onChange={(e) => {
            setMachine(e.target.value);
            setPage(0);
          }}
          className="h-8 text-xs"
          aria-label="按机器过滤"
        >
          <option value="">全部机器</option>
          {Object.keys(stats.data?.by_machine ?? {}).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => {
            setFromDate(e.target.value);
            setPage(0);
          }}
          className="h-8 text-xs"
          aria-label="按创建时间过滤"
        />
        <Button variant="outline" size="sm" onClick={resetFilters} className="h-8">
          <RotateCcwIcon className="size-3" />
          重置
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {list.isLoading ? (
          <div className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            <span>加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center px-6 text-center">
            <div className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <BoxesIcon className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-3 text-sm font-medium">没有匹配的会话</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {list.error instanceof ApiError ? list.error.message : "调整过滤条件试试"}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => (
              <SessionRow
                key={item.id}
                item={item}
                active={item.id === activeSessionId}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2.5 text-[11px] text-muted-foreground">
        <span>
          {total === 0 ? "0" : `${rangeStart}–${rangeEnd}`} / {total.toLocaleString("zh-CN")}
        </span>
        <div className="flex gap-1">
          <Button variant="outline" size="icon-sm" disabled={!hasPrev} onClick={() => setPage((p) => p - 1)} aria-label="上一页">
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)} aria-label="下一页">
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话"
        description={`确认删除「${pendingDelete?.title ?? pendingDelete?.source_id ?? ""}」？本地删除会同步为镜像语义。`}
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

function SessionRow({
  item,
  active,
  onDelete,
}: {
  item: SessionListItem;
  active: boolean;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group/row relative rounded-xl transition-colors",
        active ? "bg-accent shadow-sm ring-1 ring-border/60" : "hover:bg-muted/80",
      )}
    >
      <Link
        to="/sessions"
        search={{ s: item.id }}
        className="flex min-w-0 items-start gap-2.5 px-3 py-2.5 pr-9 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.title ?? item.source_id}</span>
          <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              {item.agent}
            </Badge>
            <span className="truncate">{item.machine}</span>
            <span>·</span>
            <span className="shrink-0">{formatRelative(item.updated_at)}</span>
          </span>
        </div>
      </Link>
      <span className="pointer-events-none absolute right-2 top-2.5 text-[10px] text-muted-foreground/70 transition-opacity group-hover/row:opacity-0">
        {item.message_count}
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDelete();
        }}
        className="absolute right-2 top-2.5 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color,background-color] hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
        aria-label={`删除 ${item.title ?? item.source_id}`}
        title="删除"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}
