<script lang="ts">
  // Organizations list (contract §5). Searchable, paginated table. Consumes GET
  // /api/superadmin/orgs?limit&offset&search.
  //
  // <table> is fine (only <a>/<ul>/<li> are cursed by app.css); any clickable
  // name is a <button onclick={goto}>, loading renders skeleton rows.
  import { goto } from "$app/navigation";
  import Avatar from "$lib/components/Avatar.svelte";
  import { listOrgs, type OrgListRow } from "../api.js";
  import { fmtNumber, fmtRelative } from "../format.js";
  import { subscriptionStatusClass } from "../badges.js";

  const PAGE_SIZE = 25;

  let search = $state("");
  // What `load()` actually queries on. Updated by the debounce timer so each
  // keystroke doesn't fire a request (the $effect transitively tracks whatever
  // load() reads, so it must read this and not `search`).
  let debouncedSearch = $state("");
  let offset = $state(0);
  let rows = $state<OrgListRow[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Debounce search so each keystroke doesn't fire a request.
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
      const resp = await listOrgs({ limit: PAGE_SIZE, offset, search: debouncedSearch.trim() || undefined });
      rows = resp.orgs;
      total = resp.total;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load organizations";
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
    <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">Organizations</h1>
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
        placeholder="Search by name or owner…"
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
          <th class="px-4 py-2.5 font-medium">Name</th>
          <th class="px-4 py-2.5 font-medium">Owner</th>
          <th class="px-4 py-2.5 text-right font-medium">Members</th>
          <th class="px-4 py-2.5 font-medium">Plan</th>
          <th class="px-4 py-2.5 text-right font-medium">Daemons</th>
          <th class="px-4 py-2.5 text-right font-medium">Created</th>
        </tr>
      </thead>
      <tbody>
        {#if loading}
          {#each Array(6) as _, i (i)}
            <tr style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}>
              <td class="px-4 py-3" colspan="6"><div class="skeleton h-5 w-full rounded"></div></td>
            </tr>
          {/each}
        {:else if rows.length === 0}
          <tr><td colspan="6" class="px-4 py-10 text-center text-content-muted">No organizations found.</td></tr>
        {:else}
          {#each rows as org, i (org.id)}
            <tr
              onclick={() => goto(`/superadmin/orgs/${org.id}`)}
              class="cursor-pointer transition-colors hover:bg-surface-alt/60"
              style={i > 0 ? "border-top: 0.5px solid var(--hairline);" : ""}
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2.5">
                  <Avatar name={org.name} image={org.avatarUrl} size="sm" />
                  <button
                    type="button"
                    onclick={(e) => { e.stopPropagation(); goto(`/superadmin/orgs/${org.id}`); }}
                    class="truncate text-left font-medium text-content hover:text-accent"
                  >
                    {org.name}
                  </button>
                  {#if org.disabledAt != null}
                    <span
                      class="inline-flex shrink-0 items-center rounded bg-error/15 px-1.5 py-0.5 text-[11px] font-medium text-error"
                    >
                      Disabled
                    </span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-2.5 text-content-dim">{org.ownerEmail ?? "—"}</td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(org.memberCount)}</td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1.5">
                  <span
                    class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {org.plan && org.plan !== 'free' ? 'bg-online/15 text-online' : 'bg-surface-alt text-content-muted'}"
                  >
                    {org.plan ?? "free"}
                  </span>
                  {#if org.status}
                    <span
                      class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {subscriptionStatusClass(org.status)}"
                    >
                      {org.status}
                    </span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-2.5 text-right text-content-dim">{fmtNumber(org.daemonCount)}</td>
              <td class="px-4 py-2.5 text-right text-[12px] text-content-muted">{fmtRelative(org.createdAt)}</td>
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
