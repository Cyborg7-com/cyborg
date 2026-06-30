<script lang="ts">
  import type { TaskSearchResult } from "$lib/core/types.js";

  let {
    results,
    query,
    workspaceId,
    loading = false,
    onselect,
  }: {
    results: TaskSearchResult[];
    query: string;
    workspaceId: string;
    loading?: boolean;
    onselect?: () => void;
  } = $props();

  // Build the human identifier key for a result: "ENG-12" when both the project
  // identifier and the sequence number are known, "#12" with only the sequence,
  // otherwise nothing (no empty chip).
  function identifierKey(r: TaskSearchResult): string | null {
    if (r.project?.identifier && r.sequenceId != null) {
      return `${r.project.identifier}-${r.sequenceId}`;
    }
    if (r.sequenceId != null) return `#${r.sequenceId}`;
    return null;
  }

  // Split a body into [before, match, after] around the first case-insensitive
  // hit so the matched run can be wrapped in a highlight <mark>. XSS-safe: the
  // three parts are rendered as plain text nodes, never as {@html}.
  function highlightParts(text: string, q: string): [string, string, string] {
    if (!q || q.length < 2) return [text, "", ""];
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return [text, "", ""];
    return [text.slice(0, idx), text.slice(idx, idx + q.length), text.slice(idx + q.length)];
  }

  // Build a short snippet of the description centered on the first match so we
  // never dump the full body. When the match is far in, slice a window (~40
  // chars before, ~120 after) and ellipsize the cut edges. When there is no
  // match (the query hit the title only), show the start of the description.
  function descriptionSnippet(desc: string, q: string): string {
    const idx = q && q.length >= 2 ? desc.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (idx === -1) {
      return desc.length > 160 ? `${desc.slice(0, 160)}…` : desc;
    }
    const start = Math.max(0, idx - 40);
    const end = Math.min(desc.length, idx + q.length + 120);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < desc.length ? "…" : "";
    return `${prefix}${desc.slice(start, end)}${suffix}`;
  }
</script>

{#if loading}
  <div class="px-4 py-3 text-[13px] text-content-dim">Searching…</div>
{:else if results.length === 0 && query.trim().length >= 2}
  <div class="px-4 py-3 text-[13px] text-content-dim">No tasks found for "{query.trim()}"</div>
{:else}
  {#each results as r (r.id)}
    {@const idKey = identifierKey(r)}
    {@const titleParts = highlightParts(r.title, query.trim())}
    <a
      href={`/workspace/${workspaceId}/tasks/item/${r.id}`}
      onclick={() => onselect?.()}
      class="block w-full border-b border-edge px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-raised"
    >
      <div class="mb-1 flex items-center gap-2">
        {#if r.project}
          <span class="flex items-center gap-1 text-[12px] text-content-dim">
            {#if r.project.color}
              <span
                class="size-2.5 shrink-0 rounded-full"
                style={`background-color:${r.project.color}`}
              ></span>
            {/if}
            {r.project.name}
          </span>
        {/if}
        {#if r.project && r.state}
          <span class="text-[11px] text-content-muted">·</span>
        {/if}
        {#if r.state}
          <span class="flex items-center gap-1 text-[12px] text-content-dim">
            <span
              class="size-2.5 shrink-0 rounded-full"
              style={`background-color:${r.state.color}`}
            ></span>
            {r.state.name}
          </span>
        {/if}
        {#if idKey && (r.project || r.state)}
          <span class="text-[11px] text-content-muted">·</span>
        {/if}
        {#if idKey}
          <span class="text-[12px] tabular-nums text-content-muted">{idKey}</span>
        {/if}
        {#if r.assignee?.name}
          <span class="ml-auto shrink-0 truncate text-[11px] text-content-muted">{r.assignee.name}</span>
        {/if}
      </div>

      <div class="line-clamp-2 text-[13px] text-content">
        {titleParts[0]}{#if titleParts[1]}<mark class="rounded-sm bg-warning/30 px-0.5 text-content">{titleParts[1]}</mark>{/if}{titleParts[2]}
      </div>

      {#if r.description && r.description.trim().length > 0}
        {@const snippet = descriptionSnippet(r.description, query.trim())}
        {@const descParts = highlightParts(snippet, query.trim())}
        <div class="mt-0.5 line-clamp-2 text-[13px] text-content-dim">
          {descParts[0]}{#if descParts[1]}<mark class="rounded-sm bg-warning/30 px-0.5 text-content">{descParts[1]}</mark>{/if}{descParts[2]}
        </div>
      {/if}
    </a>
  {/each}
{/if}
