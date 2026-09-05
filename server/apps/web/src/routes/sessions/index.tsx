import { createFileRoute } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SessionList } from "./-components/session-list";
import { SessionDetail } from "./-components/session-detail";

export const Route = createFileRoute("/sessions/")({
  validateSearch: (search: Record<string, unknown>): { s?: string } => {
    if (typeof search.s === "string" && search.s !== "") return { s: search.s };
    return {};
  },
  component: SessionsPage,
});

function SessionsPage() {
  const { s } = Route.useSearch();
  return (
    <div className="-mx-4 -my-6 flex h-[calc(100svh-3rem)] min-w-0 overflow-hidden md:-mx-6">
      <aside
        className={`flex h-full w-72 shrink-0 flex-col border-r border-border/70 bg-muted/20 max-md:w-full ${s ? "max-md:hidden" : ""}`}
      >
        <SessionList activeSessionId={s} />
      </aside>
      <section className="min-w-0 flex-1 bg-background max-md:flex max-md:flex-col">
        {s ? (
          <SessionDetail sessionId={s} />
        ) : (
          <EmptyState
            icon={CompassIcon}
            title="选择一个会话"
            description="从左侧列表选择会话查看全文与工具产出"
            className="max-md:hidden"
          />
        )}
      </section>
    </div>
  );
}
