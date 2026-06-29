<script lang="ts">
  // Admin audit log (contract §5). Recent admin action entries. Consumes GET
  // /api/superadmin/audit.
  //
  // <table> is fine; the actor links are <button onclick={goto}>, loading is
  // skeleton rows (no bare "Loading…").
  import { goto } from "$app/navigation";
  import { listAudit, type AuditEntry } from "../api.js";
  import { fmtRelative } from "../format.js";

  let rows = $state<AuditEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    void load();
  });

  let loaded = false;
  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    loading = true;
    error = null;
    try {
      rows = await listAudit({ limit: 100 });
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load audit log";
    } finally {
      loading = false;
    }
  }

  // Human label for an action code.
  const ACTION_LABELS: Record<string, string> = {
    grant_superadmin: "Granted superadmin",
    revoke_superadmin: "Revoked superadmin",
    suspend_user: "Suspended user",
    unsuspend_user: "Unsuspended user",
    delete_user: "Deleted user",
    change_plan: "Changed plan",
    set_member_role: "Changed member role",
    impersonate: "Impersonated user",
  };

  function actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  // Per-action chip tone via theme tokens: grant/unsuspend read positive
  // (online), destructive (delete/suspend/revoke) read danger (error),
  // impersonation reads accent, everything else stays neutral.
  function actionChipClass(action: string): string {
    if (action === "delete_user" || action === "suspend_user" || action === "revoke_superadmin")
      return "bg-error/15 text-error";
    if (action === "impersonate") return "bg-accent/15 text-accent";
    if (action === "grant_superadmin" || action === "unsuspend_user")
      return "bg-online/15 text-online";
    return "bg-surface-alt text-content-muted";
  }

  // Compact one-line summary of the details jsonb, if present.
  function detailSummary(entry: AuditEntry): string {
    const parts: string[] = [];
    if (entry.targetType && entry.targetId) parts.push(`${entry.targetType}:${entry.targetId}`);
    else if (entry.targetId) parts.push(entry.targetId);
    if (entry.details && typeof entry.details === "object") {
      for (const [k, v] of Object.entries(entry.details)) {
        if (v !== null && v !== undefined && typeof v !== "object") parts.push(`${k}=${v}`);
      }
    }
    return parts.join(" · ");
  }
</script>

<div class="mx-auto max-w-4xl space-y-5 px-6 py-7">
  <div>
    <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">Audit log</h1>
    <p class="mt-1 text-sm text-content-muted">The most recent platform admin actions.</p>
  </div>

  {#if error}
    <div class="rounded-[14px] border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">{error}</div>
  {/if}

  <div
    class="overflow-hidden rounded-[14px]"
    style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
  >
    <table class="w-full text-sm">
      <thead class="text-left text-[11px] uppercase tracking-wide text-content-muted">
        <tr style="border-bottom: 0.5px solid var(--hairline);">
          <th class="px-4 py-2.5 font-medium">Action</th>
          <th class="px-4 py-2.5 font-medium">Actor</th>
          <th class="px-4 py-2.5 font-medium">Target / details</th>
          <th class="px-4 py-2.5 text-right font-medium">When</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          {#each Array(6) as _, i (i)}
            <tr style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}>
              <td class="px-4 py-3" colspan="4"><div class="skeleton h-5 w-full rounded"></div></td>
            </tr>
          {/each}
        {:else if rows.length === 0}
          <tr><td colspan="4" class="px-4 py-10 text-center text-content-muted">No audit entries.</td></tr>
        {:else}
          {#each rows as e, i (e.id)}
            <tr
              class="transition-colors hover:bg-surface-alt/60"
              style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}
            >
              <td class="px-4 py-2.5">
                <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium {actionChipClass(e.action)}">
                  {actionLabel(e.action)}
                </span>
              </td>
              <td class="px-4 py-2.5">
                <button
                  type="button"
                  onclick={() => goto(`/superadmin/users/${e.actorUserId}`)}
                  class="truncate text-left text-content-dim hover:text-accent"
                >
                  {e.actorEmail ?? e.actorUserId}
                </button>
              </td>
              <td class="px-4 py-2.5 text-[12px] text-content-muted">{detailSummary(e) || "—"}</td>
              <td class="px-4 py-2.5 text-right text-[12px] text-content-muted">{fmtRelative(e.createdAt)}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>
