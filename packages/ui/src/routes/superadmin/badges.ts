// Shared Badge class mappings for the superadmin pages, kept local to the route
// group (like format.ts) so nothing in the shared component tree is touched.
// These layer token-based colors onto the shadcn Badge via its `class` prop —
// the same pattern the workspace members page uses for its role chips. All
// colors come from theme tokens (online/warning/error/accent), never hex.

// Daemon status chip: online = positive token, anything else = quiet.
export function daemonStatusClass(status: string | null): string {
  return status === "online" ? "bg-online/15 text-online" : "bg-surface-alt text-content-muted";
}

// Subscription status chip alongside a plan (active/trialing = positive,
// canceled/past_due = error, otherwise quiet).
export function subscriptionStatusClass(status: string | null): string {
  if (!status) return "bg-surface-alt text-content-muted";
  const s = status.toLowerCase();
  if (s === "active" || s === "trialing") return "bg-online/15 text-online";
  if (s === "canceled" || s === "cancelled" || s === "past_due" || s === "unpaid")
    return "bg-error/15 text-error";
  return "bg-surface-alt text-content-muted";
}

// Deployment-mode chip color: solo = self-hosted (warning), connected = cloud
// (accent), anything else = quiet/unknown. Mirrors the overview's solo/connected
// split (solo = SQLite-only, connected = uses the shared cloud).
export function deploymentModeClass(mode: string | null): string {
  if (mode === "solo") return "bg-warning/15 text-warning";
  if (mode === "connected") return "bg-accent/15 text-accent";
  return "bg-surface-alt text-content-muted";
}

// Human label for a deployment mode chip: solo → "self-hosted",
// connected → "cloud", anything else → "unknown".
export function deploymentModeLabel(mode: string | null): string {
  if (mode === "solo") return "self-hosted";
  if (mode === "connected") return "cloud";
  return mode ?? "unknown";
}

// Edition chip color (usage-metrics): saas = cloud (accent), selfhost =
// self-hosted (warning), opensource = positive (online), anything else
// (null/unknown) = quiet. Mirrors the deployment-mode palette.
export function editionClass(edition: string | null): string {
  if (edition === "saas") return "bg-accent/15 text-accent";
  if (edition === "selfhost") return "bg-warning/15 text-warning";
  if (edition === "opensource") return "bg-online/15 text-online";
  return "bg-surface-alt text-content-muted";
}

// Human label for an edition chip: null/empty → "unknown", otherwise the raw
// edition string (saas/selfhost/opensource) verbatim.
export function editionLabel(edition: string | null): string {
  return edition && edition !== "" ? edition : "unknown";
}
