export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

export function formatRelative(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "—";
  const diff = now - ms;
  if (diff < 0) return formatTime(ms);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < day * 2) return "昨天";
  if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
  return formatTime(ms);
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("zh-CN");
}

export function formatDistance(d: number): string {
  return d.toFixed(3);
}
