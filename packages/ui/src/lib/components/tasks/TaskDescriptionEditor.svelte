<script lang="ts">
  // The task detail card's ENRICHED description — Plane-style. Two modes:
  //   • VIEW: the stored markdown rendered as formatted rich text (bullets,
  //     numbered lists, bold/italic/code, links) via the SAME <MessageRenderer>
  //     the chat uses, so a description reads identically to a chat message.
  //   • EDIT: a markdown <textarea> plus the SAME <ComposerToolbar> as the chat
  //     composer, wired through the SAME pure applyMarkdown() transform, so the
  //     B/i/S, list, quote, and code buttons behave exactly as in the composer.
  //
  // The description is a plain markdown STRING end to end (no schema change) — the
  // host card owns persistence (optimistic client.updateTask). This component is
  // presentation only: it edits a bound draft and reports save / cancel intents.
  import { applyMarkdown } from "$lib/composer-markdown.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import ComposerToolbar from "$lib/components/composer/ComposerToolbar.svelte";
  import MessageRenderer from "$lib/components/message/MessageRenderer.svelte";
  import { cn } from "$lib/utils.js";

  let {
    value = $bindable(""),
    editing = $bindable(false),
    placeholder = "Add more detail…",
    onsave,
  }: {
    // The markdown draft (two-way bound; the host snapshots task.description in).
    value?: string;
    // Whether the editor is in EDIT mode (two-way bound so the host can react).
    editing?: boolean;
    placeholder?: string;
    // Commit the current draft. The host runs the optimistic RPC; a no-op diff is
    // its concern (it already early-returns when nothing changed).
    onsave: () => void;
  } = $props();

  let textarea = $state<HTMLTextAreaElement | null>(null);

  // The trimmed-empty check decides VIEW rendering vs. the muted placeholder.
  const hasContent = $derived(value.trim().length > 0);

  function startEditing(): void {
    editing = true;
  }

  // Enter edit mode on a click in the rendered description — but NOT when the
  // click lands on a link / mention / channel ref inside the markdown, so those
  // stay interactive in VIEW mode (a button can't legally wrap them anyway).
  function onViewClick(e: MouseEvent): void {
    const el = e.target as HTMLElement | null;
    if (el?.closest("a, [data-mention], [data-channel-mention]")) return;
    startEditing();
  }

  function onViewKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      startEditing();
    }
  }

  // Run a pure markdown transform over the textarea's live selection, then write
  // the result back + restore the caret — the exact desktop/web path the chat
  // composer uses (see MessageInput.wrapSelection / insertLinePrefix). No native
  // composer here: the detail card is desktop/web only.
  function wrapSelection(before: string, after: string): void {
    if (!textarea) return;
    const r = applyMarkdown(value, textarea.selectionStart, textarea.selectionEnd, {
      kind: "wrap",
      before,
      after,
      trimSelection: false,
    });
    value = r.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = r.selStart;
      textarea.selectionEnd = r.selEnd;
      textarea.focus();
    });
  }

  function insertLinePrefix(prefix: string): void {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const r = applyMarkdown(value, start, start, { kind: "linePrefix", prefix });
    value = r.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = r.selEnd;
      textarea.selectionEnd = r.selEnd;
      textarea.focus();
    });
  }

  // Link: the chat composer opens a modal, but a description is a lighter surface,
  // so we insert a [text](url) skeleton at the caret and select the "url" so the
  // user types straight over it (renders as a real link in VIEW mode).
  function insertLink(): void {
    if (!textarea) return;
    const r = applyMarkdown(value, textarea.selectionStart, textarea.selectionEnd, {
      kind: "insert",
      content: "[text](url)",
    });
    value = r.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      // Land the selection on the literal "url" so it's typed over directly.
      textarea.selectionStart = r.selEnd - 4;
      textarea.selectionEnd = r.selEnd - 1;
      textarea.focus();
    });
  }

  // Same markdown markers + glyphs the composer toolbar uses, so a description and
  // a chat message format identically (Slack-parity: *bold*, _italic_, "• " bullet).
  function toggleBold(): void {
    wrapSelection("*", "*");
  }
  function toggleItalic(): void {
    wrapSelection("_", "_");
  }
  function toggleStrike(): void {
    wrapSelection("~~", "~~");
  }
  function toggleCode(): void {
    wrapSelection("`", "`");
  }
  function toggleCodeBlock(): void {
    wrapSelection("```\n", "\n```");
  }
  function toggleOrderedList(): void {
    insertLinePrefix("1. ");
  }
  function toggleBulletList(): void {
    insertLinePrefix("• ");
  }
  function toggleBlockquote(): void {
    insertLinePrefix("> ");
  }
</script>

{#if editing}
  <div class="overflow-hidden rounded-lg border border-edge focus-within:border-edge-light">
    <ComposerToolbar
      onToggleBold={toggleBold}
      onToggleItalic={toggleItalic}
      onToggleStrike={toggleStrike}
      onToggleOrderedList={toggleOrderedList}
      onToggleBulletList={toggleBulletList}
      onToggleBlockquote={toggleBlockquote}
      onToggleCode={toggleCode}
      onToggleCodeBlock={toggleCodeBlock}
      onLinkClick={insertLink}
    />
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      bind:this={textarea}
      bind:value
      rows="5"
      autofocus
      {placeholder}
      onblur={() => {
        editing = false;
        onsave();
      }}
      onkeydown={(e) => {
        // ⌘/Ctrl+B / I mirror the composer's inline-format shortcuts; Escape
        // blurs to route through the single onblur save path (no double save).
        if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
          e.preventDefault();
          toggleBold();
        } else if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
          e.preventDefault();
          toggleItalic();
        } else if (e.key === "Escape") {
          e.currentTarget.blur();
        }
      }}
      class={cn(
        fieldInputClass,
        "h-auto resize-none rounded-none border-0 py-2 focus:ring-0",
      )}
    ></textarea>
  </div>
{:else if hasContent}
  <!-- A div (not a button) so rendered links/mentions stay interactive — block
       markdown can't live inside a <button>. role=button + keydown keep it
       keyboard-accessible; onViewClick ignores clicks on inner links. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="button"
    tabindex="0"
    onclick={onViewClick}
    onkeydown={onViewKeydown}
    title="Click to edit description"
    class="-mx-1 cursor-text rounded-md px-1 py-1 text-left transition-colors hover:bg-hover-gray focus-ring"
  >
    <MessageRenderer text={value} class="text-sm text-content" />
  </div>
{:else}
  <button
    type="button"
    onclick={startEditing}
    class="-mx-1 rounded-md px-1 py-1.5 text-left text-sm text-content-muted transition-colors hover:bg-hover-gray focus-ring"
  >
    {placeholder}
  </button>
{/if}
