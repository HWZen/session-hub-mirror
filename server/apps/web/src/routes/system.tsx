import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, CheckCircle2Icon, CircleAlertIcon, CpuIcon, DatabaseIcon, RotateCcwIcon } from "lucide-react";
import { api } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui/page";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/system")({ component: SystemPage });

function SystemPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), refetchInterval: 15_000 });
  const data = health.data;

  return (
    <Page>
      <PageHeader
        title="运行状态"
        description="服务存活、数据库与 embedding 提供商链"
        actions={
          <Button variant="outline" size="sm" onClick={() => void health.refetch()}>
            {health.isFetching ? <Spinner className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
            刷新
          </Button>
        }
      />
      {health.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : health.error || !data ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-center gap-3 py-4 text-sm text-destructive">
            <CircleAlertIcon className="size-4 shrink-0" />
            无法连接服务端：{health.error instanceof Error ? health.error.message : "未知错误"}
          </CardContent>
        </Card>
      ) : (
        <>
          {data.warnings.length > 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
              <CircleAlertIcon className="size-4 shrink-0" />
              <span>{data.warnings.join("；")}</span>
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <ActivityIcon className="size-4 text-muted-foreground" />
                  <CardTitle>服务</CardTitle>
                </div>
                <Badge variant={data.ok ? "success" : "destructive"}>{data.ok ? "正常" : "异常"}</Badge>
              </CardHeader>
              <CardContent className="pt-0">
                <dl className="flex flex-col gap-2 text-sm">
                  <Row label="版本" value={`v${data.version}`} mono />
                  <Row label="健康检查" value={data.ok ? "通过" : "失败"} />
                  <Row label="响应延迟" value={`${Math.max(0, Date.now() - data.now)}ms`} />
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <DatabaseIcon className="size-4 text-muted-foreground" />
                  <CardTitle>数据库</CardTitle>
                </div>
                <Badge variant={data.db.journal_mode === "truncate" ? "success" : "warning"}>{data.db.journal_mode}</Badge>
              </CardHeader>
              <CardContent className="pt-0">
                <dl className="flex flex-col gap-2 text-sm">
                  <Row label="journal_mode" value={data.db.journal_mode} mono />
                  <Row label="占用空间" value={formatBytes(data.db.size_bytes)} />
                  <Row label="WAL" value="已禁用（SMB 安全要求）" />
                  <Row label="状态" value={data.db.ok ? "正常" : "异常"} />
                </dl>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CpuIcon className="size-4 text-muted-foreground" />
                <CardTitle>Embedding 提供商链</CardTitle>
              </div>
              <CardDescription>
                活跃模型 {data.embedding.model || "未配置"} · 当前 {data.embedding.current ?? "未使用"} · 按 weight
                降序 failover，失败进入冷却后自动恢复
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="divide-y divide-border/70">
                {data.embedding.providers.map((p) => (
                  <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm first:pt-0">
                    <Badge variant={p.ready ? "success" : "destructive"}>
                      {p.ready ? <CheckCircle2Icon className="size-3" /> : <CircleAlertIcon className="size-3" />}
                      {p.ready ? "可用" : "冷却中"}
                    </Badge>
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="muted">{p.kind}</Badge>
                    <Badge variant="muted" className="font-mono">{p.model}</Badge>
                    {p.lastError ? <span className="text-xs text-destructive/90">{p.lastError}</span> : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </Page>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "text-sm"}>{value}</dd>
    </div>
  );
}
