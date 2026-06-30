<script lang="ts">
  // WS1 — the per-group inline quick-add (Plane's list-group "New work item"
  // footer, phone-native). Collapsed it is a single "+ New work item" row; tapping
  // it reveals a single-field composer that FILES on Enter via `onsubmit`
  // (= the page's onquickcreate, seeded with the group's value) and stays open for
  // the next item (Plane "create more"). The ⤢ button escalates to the FULL create
  // sheet via `onexpand` (= openCreateTask). When no inline filer is wired
  // (`canInline === false`) the row opens the full create sheet directly — the
  // CreateTaskSheet is the deliberate fallback when the device keyboard-lift is
  // unreliable.
  //
  // Keyboard lift: the Tauri iOS shell sizes the app root to --app-vh (the live
  // visualViewport height) and shrinks it when the keyboard opens, so a composer
  // near the bottom rises with it; we additionally scroll the focused field into
  // view on every keyboard-open transition (keyboard-state.ts) so the input never
  // hides behind the keyboard. If device QA shows the in-list lift is flaky, the ⤢
  // path (CreateTaskSheet, which owns its own keyboard-aware sizing) is the floor.
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state.js";
  import { listGroupAdd } from "$lib/tasks/ui.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import Maximize2Icon from "@lucide/svelte/icons/maximize-2";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { cn } from "$lib/utils.js";

  let {
    groupLabel,
    canInline = false,
    onsubmit,
    onexpand,
  }: {
    groupLabel: string;
    // True when the page wired an inline filer (onquickcreate). False → the row
    // opens the full create sheet on tap (the keyboard-lift fallback).
    canInline?: boolean;
    // File one work item; returns false on validation/RPC failure so the composer
    // keeps the typed title for a retry instead of clearing it.
    onsubmit?: (title: string) => Promise<boolean> | boolean;
    // Escalate to the full create sheet, seeded with this group's value.
    onexpand?: () => void;
  } = $props();

  let open = $state(false);
  let value = $state("");
  let busy = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let keyboardOpen = $state(false);
  $effect(() => subscribeKeyboard((v) => (keyboardOpen = v)));

  function openComposer(): void {
    if (!canInline) {
      onexpand?.();
      return;
    }
    open = true;
    // Focus after the input renders.
    queueMicrotask(() => inputEl?.focus());
  }

  function close(): void {
    open = false;
    value = "";
  }

  async function submit(): Promise<void> {
    const t = value.trim();
    if (busy) return;
    if (!t) {
      // Enter on an empty composer collapses it (Plane's empty-submit closes).
      close();
      return;
    }
    busy = true;
    try {
      const ok = await onsubmit?.(t);
      if (ok !== false) {
        // Create-more: clear + keep focus for the next item in this group.
        value = "";
        inputEl?.focus();
      }
    } finally {
      busy = false;
    }
  }

  function expand(): void {
    onexpand?.();
    close();
  }

  // Keep the focused composer above the keyboard whenever it opens.
  $effect(() => {
    if (open && keyboardOpen && inputEl) {
      inputEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
</script>

{#if !open}
  <button
    type="button"
    class={listGroupAdd}
    aria-label={`New work item in ${groupLabel}`}
    onclick={openComposer}
  >
    <PlusIcon class="size-3.5" />
    <span>New work item</span>
  </button>
{:else}
  <div class="flex items-center gap-2 border-b border-t border-edge bg-surface px-3 py-2">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={inputEl}
      bind:value
      type="text"
      autofocus
      placeholder="Work item title"
      aria-label={`New work item in ${groupLabel}`}
      class={cn(fieldInputClass, "flex-1")}
      disabled={busy}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    />
    <button
      type="button"
      onclick={expand}
      aria-label="Open full create form"
      title="More options"
      class="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
    >
      <Maximize2Icon class="size-4" />
    </button>
  </div>
{/if}
