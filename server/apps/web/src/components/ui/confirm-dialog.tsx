import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  confirmVariant = "destructive",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: "primary" | "destructive";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className={cn("w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        {description ? <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant={confirmVariant} size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
