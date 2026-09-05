import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "default" | "outline" | "success" | "warning" | "destructive" | "muted";

const VARIANTS: Record<Variant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  outline: "border-border text-foreground",
  success: "border-transparent bg-success/15 text-success",
  warning: "border-transparent bg-warning/15 text-warning",
  destructive: "border-transparent bg-destructive/15 text-destructive",
  muted: "border-transparent bg-muted text-muted-foreground",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
