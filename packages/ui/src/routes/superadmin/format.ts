// Small display helpers shared across the superadmin pages. Kept local to the
// route group so nothing in the shared component tree is touched.

// Accepts an epoch (ms or s) or an ISO string and renders a short local
// date-time. Returns an em-dash placeholder for null/empty so tables stay tidy.
export function fmtDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  let ms: number;
  if (typeof value === "number") {
    // Heuristic: treat 10-digit values as seconds, 13-digit as milliseconds.
    ms = value < 1e12 ? value * 1000 : value;
  } else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return "—";
    ms = parsed;
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "time ago" for compact columns (recent signups / audit). Falls back to the
// absolute date for anything older than ~30 days.
export function fmtRelative(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const ms =
    typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (Number.isNaN(ms)) return "—";
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return fmtDate(value);
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "0";
  return n.toLocaleString();
}

// ─── Daemon metadata formatters (org-detail "more info" grid) ────────────────

// CPU load as a whole-number percent, e.g. 12 → "12%". The daemon reports `cpu`
// as a 0–100 percentage already; round for display. null → em-dash.
export function fmtCpu(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "—";
  return `${Math.round(pct)}%`;
}

// Memory in MB, promoting to GB once it crosses 1024 MB. e.g. 512 → "512 MB",
// 2048 → "2.0 GB". null → em-dash.
export function fmtMem(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// Uptime in seconds → a compact "Xd Yh", "Xh Ym", "Xm Ys", or "Xs" string.
// e.g. 11520 → "3h 12m". null → em-dash.
export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Tri-state boolean for the metadata grid: true → "Yes", false → "No",
// null/undefined → em-dash (field absent).
export function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v ? "Yes" : "No";
}
