<script lang="ts">
  // Superadmins list (contract §5). Read-only list of current superadmins.
  // Consumes GET /api/superadmin/admins. Grant/revoke happens from a user's
  // detail page.
  //
  // <table> is fine; clickable names are <button onclick={goto}>, loading is
  // skeleton rows (no bare "Loading…").
  import { goto } from "$app/navigation";
  import Avatar from "$lib/components/Avatar.svelte";
  import { listAdmins, type SuperadminEntry } from "../api.js";
  import { fmtDate } from "../format.js";

  let rows = $state<SuperadminEntry[]>([]);
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
      rows = await listAdmins();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load superadmins";
    } finally {
      loading = false;
    }
  }
</script>

<div class="mx-auto max-w-3xl space-y-5 px-6 py-7">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">Superadmins</h1>
    <p class="text-[13px] text-content-muted">Grant or revoke from a user's detail page.</p>
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
          <th class="px-4 py-2.5 font-medium">User</th>
          <th class="px-4 py-2.5 font-medium">Granted by</th>
          <th class="px-4 py-2.5 text-right font-medium">Granted</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          {#each Array(4) as _, i (i)}
            <tr style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}>
              <td class="px-4 py-3" colspan="3"><div class="skeleton h-6 w-full rounded"></div></td>
            </tr>
          {/each}
        {:else if rows.length === 0}
          <tr><td colspan="3" class="px-4 py-10 text-center text-content-muted">No superadmins.</td></tr>
        {:else}
          {#each rows as a, i (a.userId)}
            <tr
              class="transition-colors hover:bg-surface-alt/60"
              style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-3">
                  <Avatar name={a.name ?? a.email} size="sm" />
                  <div class="min-w-0">
                    <button
                      type="button"
                      onclick={() => goto(`/superadmin/users/${a.userId}`)}
                      class="block max-w-full truncate text-left font-medium text-content hover:text-accent"
                    >
                      {a.name ?? a.email}
                    </button>
                    {#if a.name}<div class="truncate text-[12px] text-content-muted">{a.email}</div>{/if}
                  </div>
                </div>
              </td>
              <td class="px-4 py-2.5 text-content-dim">{a.grantedBy ?? "— (bootstrap)"}</td>
              <td class="px-4 py-2.5 text-right text-[12px] text-content-muted">{fmtDate(a.grantedAt)}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>
