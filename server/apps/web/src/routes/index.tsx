import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import {
  AlertTriangleIcon,
  BoxesIcon,
  CpuIcon,
  DatabaseIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatNumber, formatRelative, formatTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/")({ component: OverviewPage });

export function OverviewPage() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api.stats() });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), refetchInterval: 30_000 });
  const recent = useQuery({
    queryKey: ["sessions", "recent"],
    queryFn: () => api.listSessions({ limit: 8 }),
  });

  const s = stats.data;
  return (
    <Page>
      <PageHeader title="总览" description="跨机器、跨 Agent 的会话档案库" />
      {s && s.unindexed > 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertTriangleIcon className="size-4 shrink-0" />
          <span>
            有 <b>{formatNumber(s.unindexed)}</b> 个会话尚未建立向量索引，检索将覆盖不到它们
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={BoxesIcon} label="会话" value={s ? formatNumber(s.sessions) : undefined} sub={s?.last_session_at ? `最近 ${formatRelative(s.last_session_at)}` : undefined} />
        <StatCard icon={MessageSquareIcon} label="消息" value={s ? formatNumber(s.messages) : undefined} sub={s ? `按会话均 ${s.sessions > 0 ? Math.round(s.messages / s.sessions) : 0} 条` : undefined} />
        <StatCard icon={ListChecksIcon} label="已索引" value={s ? formatNumber(s.indexed) : undefined} sub={s ? `未索引 ${formatNumber(s.unindexed)}` : undefined} />
        <StatCard icon={CpuIcon} label="向量提供商" value={health.data?.embedding.current ?? "—"} sub={health.data ? `模型 ${health.data.embedding.model}` : undefined} mono />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>最近会话</CardTitle>
              <CardDescription>按最后修改时间排序</CardDescription>
            </div>
            <Link to="/sessions" className="text-xs font-medium text-primary hover:underline">
              查看全部 →
            </Link>
          </CardHeader>
          <CardContent className="pt-0">
            {recent.isLoading ? (
              <div className="flex h-24 items-center justify-center">
                <Spinner />
              </div>
            ) : recent.data && recent.data.items.length > 0 ? (
              <ul className="divide-y divide-border/70">
                {recent.data.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to="/sessions"
                      search={{ s: item.id }}
                      className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/70"
                    >
                      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.title ?? item.source_id}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.agent} · {item.machine} · {formatRelative(item.updated_at)}
                        </p>
                      </div>
                      <Badge variant="muted">{item.message_count} 条</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={BoxesIcon} title="还没有会话" description="等待采集器上传第一批会话" className="h-40" />
            )}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>来源分布</CardTitle>
              <CardDescription>按 Agent 与机器统计</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-0">
              <Distribution label="Agent" entries={Object.entries(s?.by_agent ?? {})} />
              <Distribution label="机器" entries={Object.entries(s?.by_machine ?? {})} />
              {s?.first_session_at ? (
                <p className="text-xs text-muted-foreground">
                  时间跨度 {formatTime(s.first_session_at)} → {formatTime(s.last_session_at)}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>存储</CardTitle>
              <CardDescription>SQLite 数据库状态</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center gap-3 text-sm">
                <DatabaseIcon className="size-4 text-muted-foreground" />
                <span>journal_mode</span>
                <Badge variant={health.data?.db.journal_mode === "truncate" ? "success" : "warning"}>
                  {health.data?.db.journal_mode ?? "—"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  );
}

type ComponentTypeIcon = ComponentType<{ className?: string }>;

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  mono = false,
}: {
  icon: ComponentTypeIcon;
  label: string;
  value?: string | undefined;
  sub?: string | undefined;
  mono?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </div>
        <p className={`truncate text-2xl font-semibold tracking-tight ${mono ? "font-mono text-base pt-1" : ""}`}>
          {value ?? <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />}
        </p>
        {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function Distribution({ label, entries }: { label: string; entries: Array<[string, number]> }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">暂无数据</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([name, count]) => (
            <Badge key={name} variant="outline" className="gap-1.5 py-1">
              <span className="font-mono">{name}</span>
              <span className="text-muted-foreground">{count}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
