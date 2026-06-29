<script lang="ts">
  // Searchable single-provider model picker (combobox). Extracted from
  // ProviderModelSelector so the Settings → AI tab, the cybo create/edit form,
  // and the new-session dialog all share ONE searchable model combobox instead of
  // a long, unfilterable <select>.
  //
  // For Pi the model id is "backend/model" (e.g. "opencode-go/glm-5.1") — shown
  // WHOLE so the backend (opencode vs opencode-go) stays visible. Other providers
  // use the short server label (or the trailing id segment).
  //
  // The repo has no shadcn Popover/Command primitive, so this is a small
  // self-contained popover + filter (the established pattern in ui/).
  import type { ProviderInfo } from "$lib/plugins/agents/types.js";

  type ModelItem = ProviderInfo["models"][number];

  let {
    models = [],
    value = null,
    providerId = null,
    disabled = false,
    placeholder = "Model",
    align = "left",
    triggerClass = "",
    onSelect,
  }: {
    models: ModelItem[];
    /** Currently selected model id (null = none / default). */
    value?: string | null;
    /** The provider id — only used to special-case Pi's backend/model label. */
    providerId?: string | null;
    disabled?: boolean;
    placeholder?: string;
    /** Which edge the dropdown aligns to (right for tight, right-aligned rows). */
    align?: "left" | "right";
    /** Extra classes for the trigger button (e.g. full-width in a form). */
    triggerClass?: string;
    onSelect: (modelId: string) => void | Promise<void>;
  } = $props();

  const isPi = $derived(providerId === "pi");
  function label(m: { id: string; label?: string }): string {
    // Pi: full backend/model id (a short server label would hide the backend).
    if (isPi) return m.id;
    return m.label ?? m.id.split("/").pop() ?? m.id;
  }

  let open = $state(false);
  let query = $state("");
  const filtered = $derived(
    query.trim()
      ? models.filter((m) => {
          const q = query.toLowerCase();
          return m.id.toLowerCase().includes(q) || (m.label?.toLowerCase().includes(q) ?? false);
        })
      : models,
  );
  const currentLabel = $derived(
    value ? label(models.find((m) => m.id === value) ?? { id: value }) : placeholder,
  );
  function pick(id: string): void {
    void onSelect(id);
    open = false;
    query = "";
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === "Escape") open = false;
  }}
/>

<div class="relative">
  <button
    type="button"
    disabled={disabled || models.length === 0}
    onclick={() => {
      open = !open;
      query = "";
    }}
    class={[
      "flex h-8 min-w-[170px] items-center justify-between gap-2 rounded-md border border-edge bg-transparent px-3 text-[12px] text-content transition-colors hover:border-edge-light disabled:cursor-not-allowed disabled:opacity-50",
      triggerClass,
    ]}
  >
    <span class="truncate {isPi && value ? 'font-mono' : ''}">{currentLabel}</span>
    <svg
      class="h-3 w-3 shrink-0 text-content-muted"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg
    >
  </button>
  {#if open}
    <button
      type="button"
      aria-label="Close model list"
      class="fixed inset-0 z-40 cursor-default"
      onclick={() => (open = false)}
    ></button>
    <div
      class="absolute z-50 mt-1 w-[280px] max-w-[80vw] rounded-md border border-edge bg-surface shadow-md {align ===
      'right'
        ? 'right-0'
        : ''}"
    >
      <div class="border-b border-edge-dim p-1.5">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={query}
          aria-label="Search models"
          placeholder="Search models…"
          class="w-full rounded bg-transparent px-2 py-1 text-[12px] text-content outline-none placeholder:text-content-muted"
        />
      </div>
      <div class="max-h-[240px] overflow-y-auto py-1">
        {#if filtered.length === 0}
          <div class="px-3 py-2 text-[12px] text-content-muted">No matching models</div>
        {:else}
          {#each filtered as m (m.id)}
            <button
              type="button"
              onclick={() => pick(m.id)}
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-raised {m.id ===
              value
                ? 'text-content'
                : 'text-content-dim'}"
            >
              <span class="flex-1 truncate {isPi ? 'font-mono' : ''}">{label(m)}</span>
              {#if m.isDefault}<span class="text-[10px] text-content-muted">default</span>{/if}
              {#if m.id === value}<span class="text-accent">✓</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
