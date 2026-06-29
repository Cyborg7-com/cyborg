<script lang="ts">
  // Users list (contract §5). Searchable, paginated table. Consumes GET
  // /api/superadmin/users?limit&offset&search.
  //
  // <table> is fine; clickable names are <button onclick={goto}>, loading is
  // skeleton rows (no bare "Loading…").
  import { goto } from "$app/navigation";
  import Avatar from "$lib/components/Avatar.svelte";
  import { listUsers, type UserListRow } from "../api.js";
  import { fmtNumber, fmtRelative } from "../format.js";

  const PAGE_SIZE = 25;

  let search = $state("");
  // What `load()` actually queries on. Updated by the debounce timer so each
  // keystroke doesn't fire a request (the $effect transitively tracks whatever
  // load() reads, so it must read this and not `search`).
  let debouncedSearch = $state("");
  let offset = $state(0);
  let rows = $state<UserListRow[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      offset = 0;
      debouncedSearch = search;
    }, 300);
  }

  $effect(() => {
    void load();
    return () => clearTimeout(searchTimer);
  });

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const resp = await listUsers({ limit: PAGE_SIZE, offset, search: debouncedSearch.trim() || undefined });
      rows = resp.users;
      total = resp.total;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load users";
    } finally {
      loading = false;
    }
  }

  function nextPage() {
    if (offset + PAGE_SIZE >= total) return;
    offset += PAGE_SIZE;
    void load();
  }
  function prevPage() {
    if (offset === 0) return;
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  }

  const rangeEnd = $derived(Math.min(offset + rows.length, total));
</script>

<div class="mx-auto max-w-5xl space-y-5 px-6 py-7">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">Users</h1>
    <div class="relative w-64">
      <svg
        class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        bind:value={search}
        oninput={onSearchInput}
        type="search"
        placeholder="Search by email or name…"
        class="h-9 w-full rounded-lg border border-edge bg-surface pl-9 pr-3 text-sm text-content outline-none transition-colors placeholder:text-content-muted focus:border-edge-light focus:ring-1 focus:ring-edge-light"
      />
    </div>
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
          <th class="px-4 py-2.5 font-medium">Status</th>
          <th class="px-4 py-2.5 text-right font-medium">Workspaces</th>
          <th class="px-4 py-2.5 text-right font-medium">Daemons</th>
          <th class="px-4 py-2.5 text-right font-medium">Active sess</th>
          <th class="px-4 py-2.5 text-right font-medium">Cybos</th>
          <th class="px-4 py-2.5 text-right font-medium">Joined</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          {#each Array(6) as _, i (i)}
            <tr style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}>
              <td class="px-4 py-3" colspan="7"><div class="skeleton h-6 w-full rounded"></div></td>
            </tr>
          {/each}
        {:else if rows.length === 0}
          <tr><td colspan="7" class="px-4 py-10 text-center text-content-muted">No users found.</td></tr>
        {:else}
          {#each rows as u, i (u.id)}
            <tr
              onclick={() => goto(`/superadmin/users/${u.id}`)}
              class="cursor-pointer transition-colors hover:bg-surface-alt/60"
              style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-3">
                  <Avatar name={u.name ?? u.email} image={u.imageUrl} size="sm" />
                  <div class="min-w-0">
                    <button
                      type="button"
                      onclick={(e) => { e.stopPropagation(); goto(`/superadmin/users/${u.id}`); }}
                      class="block max-w-full truncate text-left font-medium text-content hover:text-accent"
                    >
                      {u.name ?? u.email}
                    </button>
                    {#if u.name}<div class="truncate text-[12px] text-content-muted">{u.email}</div>{/if}
                  </div>
                </div>
              </td>
              <td class="px-4 py-2.5">
                <div class="flex flex-wrap gap-1.5">
                  {#if u.isSuperadmin}
                    <span class="inline-flex items-center rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">Superadmin</span>
                  {/if}
                  {#if u.deletedAt}
                    <span class="inline-flex items-center rounded bg-error/15 px-1.5 py-0.5 text-[11px] font-medium text-error">Deleted</span>
                  {:else if u.suspendedAt}
                    <span class="inline-flex items-center rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">Suspended</span>
                  {/if}
                  {#if !u.isSuperadmin && !u.deletedAt && !u.suspendedAt}
                    <span class="inline-flex items-center rounded bg-online/15 px-1.5 py-0.5 text-[11px] font-medium text-online">Active</span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(u.workspaceCount)}</td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(u.daemonCount)}</td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(u.activeSessions)}</td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(u.activeCybos)}</td>
              <td class="px-4 py-2.5 text-right text-[12px] text-content-muted">{fmtRelative(u.createdAt)}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if !loading && total > 0}
    <div class="flex items-center justify-between text-[13px] text-content-muted">
      <span>Showing {offset + 1}–{rangeEnd} of {fmtNumber(total)}</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevPage}
          disabled={offset === 0}
          class="rounded-lg border border-edge px-3 py-1.5 text-sm text-content-muted transition-colors hover:bg-surface-alt hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          onclick={nextPage}
          disabled={rangeEnd >= total}
          class="rounded-lg border border-edge px-3 py-1.5 text-sm text-content-muted transition-colors hover:bg-surface-alt hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  {/if}
</div>
