import { useEffect, useState, type ComponentType } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  BoxesIcon,
  HomeIcon,
  MenuIcon,
  MoonIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { loadConnection } from "@/lib/settings";
import { useTheme } from "@/hooks/use-theme";

interface NavItem {
  to: string;
  icon: ComponentType<{ className?: string }>;
  title: string;
}

const SECTIONS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "工作台",
    items: [
      { to: "/", icon: HomeIcon, title: "总览" },
      { to: "/sessions", icon: BoxesIcon, title: "会话" },
      { to: "/search", icon: SearchIcon, title: "检索" },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/system", icon: ActivityIcon, title: "运行状态" },
      { to: "/settings", icon: SettingsIcon, title: "设置" },
    ],
  },
];

const SIDEBAR_KEY = "session-hub.sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "1");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-svh overflow-hidden bg-sidebar">
      <aside
        className={cn(
          "z-40 flex h-full shrink-0 flex-col border-r border-sidebar-border/70 bg-sidebar transition-[width] duration-200",
          collapsed ? "w-14" : "w-64",
          "max-md:fixed max-md:inset-y-0 max-md:left-0",
          !mobileOpen && "max-md:-translate-x-full max-md:w-64",
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border/70 px-2">
          <Link to="/" className={cn("flex min-w-0 flex-1 items-center gap-2", collapsed && "max-md:flex md:justify-center")}>
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BoxesIcon className="size-4" />
            </div>
            <span className={cn("truncate text-sm font-semibold tracking-tight", collapsed && "max-md:hidden md:hidden")}>
              Session Hub
            </span>
          </Link>
          <button
            type="button"
            aria-label="收起侧栏"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              "hidden size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:inline-flex",
              collapsed && "md:hidden",
            )}
          >
            <PanelLeftIcon className="size-4" />
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto py-2">
          {SECTIONS.map((section) => (
            <div key={section.label} className="mb-1 px-2 pb-1">
              <p
                className={cn(
                  "px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/45",
                  collapsed && "md:text-center md:tracking-normal",
                )}
              >
                {collapsed ? "·" : section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`);
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        title={item.title}
                        className={cn(
                          "flex h-9 items-center gap-2.5 rounded-lg px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                          collapsed && "md:justify-center md:px-0",
                        )}
                      >
                        <item.icon className={cn("size-4 shrink-0", active && "text-primary")} />
                        <span className={cn("truncate", collapsed && "max-md:inline md:hidden")}>{item.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <VersionFooter collapsed={collapsed} />
      </aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 backdrop-blur-md md:px-6">
          <button
            type="button"
            aria-label="打开侧栏"
            onClick={() => setMobileOpen(true)}
            className="flex size-9 items-center justify-center rounded-lg border border-border/80 bg-muted/60 text-muted-foreground shadow-xs hover:text-foreground md:hidden"
          >
            <MenuIcon className="size-5" />
          </button>
          <div className="flex items-center gap-3">
            <ConnectionBadge />
            <button
              type="button"
              aria-label="切换主题"
              onClick={toggle}
              className="relative flex size-10 items-center justify-center rounded-2xl border border-border/80 bg-muted/60 text-muted-foreground shadow-xs transition-colors hover:text-foreground"
            >
              <MoonIcon className="size-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <SunIcon className="absolute size-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full flex-col gap-6 px-4 py-6 md:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function VersionFooter({ collapsed }: { collapsed: boolean }) {
  const health = useQuery({ queryKey: ["health-badge"], queryFn: () => api.health(), retry: false });
  const version = health.data?.version;
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center border-t border-sidebar-border/70 px-3 text-[11px] text-sidebar-foreground/50",
        collapsed && "md:justify-center md:px-0",
      )}
    >
      {version ? <span className={cn("truncate", collapsed && "max-md:inline md:hidden")}>Session Hub v{version}</span> : null}
    </div>
  );
}

function ConnectionBadge() {
  const [hasToken, setHasToken] = useState(() => loadConnection().token !== "");
  useEffect(() => {
    const onStorage = (): void => setHasToken(loadConnection().token !== "");
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(onStorage, 2000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, []);
  const health = useQuery({
    queryKey: ["health-badge"],
    queryFn: () => api.health(),
    refetchInterval: hasToken ? 30_000 : false,
    retry: false,
  });
  const online = health.data?.ok === true;
  const dot = online ? "bg-success" : hasToken && health.isError ? "bg-destructive" : "bg-warning";
  const label = online ? "已连接" : hasToken ? "连接异常" : "未配置";
  return (
    <Link
      to="/settings"
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border/80 bg-muted/60 px-3 text-xs text-muted-foreground shadow-xs transition-colors hover:text-foreground"
    >
      <span className={cn("size-2 rounded-full", dot, !online && hasToken && health.isFetching && "animate-pulse")} />
      {label}
    </Link>
  );
}
