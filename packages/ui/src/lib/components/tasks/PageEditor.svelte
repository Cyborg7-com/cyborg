<!--
  PageEditor — the rich-text editor for a project Page (Plane/Notion-style). Built
  on TipTap (StarterKit + Underline + Link + Placeholder + Image + Table +
  TextAlign + a slash-command menu). An icon/emoji affordance + a public/private
  access toggle above the title, a formatting toolbar (block type, B/I/U/S, lists,
  quote, code, link, divider, alignment, image, table), a big "Untitled" title,
  and the document body. Title + content + icon + access autosave via
  client.updatePage. Tokens only; dark + light both resolve.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { Editor, type Content } from "@tiptap/core";
  import type { Node as ProseNode } from "@tiptap/pm/model";
  import StarterKit from "@tiptap/starter-kit";
  import Placeholder from "@tiptap/extension-placeholder";
  import Underline from "@tiptap/extension-underline";
  import Link from "@tiptap/extension-link";
  import { TableKit } from "@tiptap/extension-table";
  import TextAlign from "@tiptap/extension-text-align";
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import { fileToAttachment, readAsDataUrl } from "$lib/media/attachment-upload.js";
  import { PageImage } from "./page-image.js";
  import { createPageDragHandle } from "./page-drag-handle.js";
  import type { Page } from "$lib/core/types.js";
  import EmojiPicker from "$lib/components/composer/EmojiPicker.svelte";
  import Emoji from "$lib/components/Emoji.svelte";
  import {
    createPageSlash,
    type SlashItem,
    type SlashRenderState,
    type SlashController,
  } from "./page-slash.js";
  import SmilePlusIcon from "@lucide/svelte/icons/smile-plus";
  import GlobeIcon from "@lucide/svelte/icons/globe";
  import LockIcon from "@lucide/svelte/icons/lock";
  import XIcon from "@lucide/svelte/icons/x";
  import FilePlusIcon from "@lucide/svelte/icons/file-plus";
  import AlignLeftIcon from "@lucide/svelte/icons/align-left";
  import AlignCenterIcon from "@lucide/svelte/icons/align-center";
  import AlignRightIcon from "@lucide/svelte/icons/align-right";
  import ImageIcon from "@lucide/svelte/icons/image";
  import TableIcon from "@lucide/svelte/icons/table";
  import TypeIcon from "@lucide/svelte/icons/type";
  import Heading1Icon from "@lucide/svelte/icons/heading-1";
  import Heading2Icon from "@lucide/svelte/icons/heading-2";
  import Heading3Icon from "@lucide/svelte/icons/heading-3";
  import ListIcon from "@lucide/svelte/icons/list";
  import ListOrderedIcon from "@lucide/svelte/icons/list-ordered";
  import TextQuoteIcon from "@lucide/svelte/icons/text-quote";
  import CodeIcon from "@lucide/svelte/icons/code";
  import MinusIcon from "@lucide/svelte/icons/minus";
  import BetweenVerticalStartIcon from "@lucide/svelte/icons/between-vertical-start";
  import BetweenVerticalEndIcon from "@lucide/svelte/icons/between-vertical-end";
  import BetweenHorizontalStartIcon from "@lucide/svelte/icons/between-horizontal-start";
  import BetweenHorizontalEndIcon from "@lucide/svelte/icons/between-horizontal-end";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { Component } from "svelte";

  let { wsId, projectId, pageId }: { wsId: string; projectId: string; pageId: string } =
    $props();

  let editorEl = $state<HTMLDivElement>();
  // $state.raw: never proxy the TipTap Editor — Svelte's deep proxy would wrap
  // its internal ProseMirror state and break it. We only swap the reference.
  let editor = $state.raw<Editor | null>(null);
  let title = $state("");
  let icon = $state<string | null>(null);
  let visibility = $state<"private" | "public">("private");
  let showIconPicker = $state(false);
  let imageInputEl = $state<HTMLInputElement>();
  let loaded = $state(false);
  let notFound = $state(false);
  let saveState = $state<"idle" | "saving" | "saved">("idle");
  // Bumped on every editor transaction so toolbar active-states recompute.
  let selVersion = $state(0);

  // Slash-command menu state (driven by the page-slash controller below).
  let slashOpen = $state(false);
  let slashItems = $state.raw<SlashItem[]>([]);
  let slashIndex = $state(0);
  let slashTop = $state(0);
  let slashLeft = $state(0);
  // The suggestion's `command` callback for the open menu (runs the picked item).
  let slashSelect: ((item: SlashItem) => void) | null = null;

  const SLASH_ICONS: Record<string, Component> = {
    text: TypeIcon,
    h1: Heading1Icon,
    h2: Heading2Icon,
    h3: Heading3Icon,
    bullet: ListIcon,
    ordered: ListOrderedIcon,
    quote: TextQuoteIcon,
    code: CodeIcon,
    image: ImageIcon,
    table: TableIcon,
    divider: MinusIcon,
  };

  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let titleTimer: ReturnType<typeof setTimeout> | null = null;

  function parseDoc(s: string | undefined): Content {
    if (!s) return "";
    try {
      return JSON.parse(s) as Content;
    } catch {
      // intentional: legacy/plain content — fall back to treating it as text.
      return s;
    }
  }

  function scheduleContentSave(): void {
    saveState = "saving";
    if (contentTimer) clearTimeout(contentTimer);
    contentTimer = setTimeout(() => {
      const json = editor?.getJSON();
      if (!json) return;
      void client
        .updatePage(pageId, { content: JSON.stringify(json) })
        .then(() => {
          saveState = "saved";
          return undefined;
        })
        // intentional: best-effort autosave; the next keystroke reschedules it.
        .catch(() => {
          saveState = "idle";
        });
    }, 600);
  }

  function onTitleInput(): void {
    saveState = "saving";
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      void client
        .updatePage(pageId, { title })
        .then(() => {
          saveState = "saved";
          return undefined;
        })
        // intentional: best-effort title autosave; reschedules on the next edit.
        .catch(() => {
          saveState = "idle";
        });
    }, 600);
  }

  // Immediately persist any pending (debounced) title/content edits — called on
  // navigate-away, title blur, and unmount so a fast back-click can't drop them.
  async function flushSaves(): Promise<void> {
    const ops: Promise<unknown>[] = [];
    if (titleTimer) {
      clearTimeout(titleTimer);
      titleTimer = null;
      // intentional: best-effort flush; a failed save resolves so Promise.all won't reject.
      ops.push(client.updatePage(pageId, { title }).catch(() => undefined));
    }
    if (contentTimer) {
      clearTimeout(contentTimer);
      contentTimer = null;
      const json = editor?.getJSON();
      if (json) {
        ops.push(
          // intentional: best-effort flush; a failed save resolves so Promise.all won't reject.
          client.updatePage(pageId, { content: JSON.stringify(json) }).catch(() => undefined),
        );
      }
    }
    if (ops.length === 0) return;
    saveState = "saving";
    await Promise.all(ops);
    saveState = "saved";
  }

  async function backToPages(): Promise<void> {
    await flushSaves();
    goto(`/workspace/${wsId}/tasks/${projectId}/pages`);
  }

  // Create a new page nested under THIS page and open it. The server persists
  // parent_id directly; the {#key pageId} route wrapper remounts the editor on
  // the new id, loading the fresh child.
  async function addSubpage(): Promise<void> {
    try {
      const created = await client.createPage(projectId, { parentId: pageId });
      goto(`/workspace/${wsId}/tasks/${projectId}/pages/${created.id}`);
    } catch (err) {
      console.error("[page] addSubpage failed", err);
      toast.error(err instanceof Error ? err.message : "Couldn't add subpage.");
    }
  }

  // Persist the page icon (an emoji glyph) or clear it (null). Optimistic: the UI
  // updates first; a failed save reverts so the header + pages list stay honest.
  async function setIcon(next: string | null): Promise<void> {
    const prev = icon;
    icon = next;
    showIconPicker = false;
    saveState = "saving";
    try {
      await client.updatePage(pageId, { icon: next });
      saveState = "saved";
    } catch (e) {
      icon = prev;
      saveState = "idle";
      console.error("[page] setIcon failed", e);
    }
  }

  // Toggle the page between public and private. Optimistic with revert-on-error.
  async function toggleAccess(): Promise<void> {
    const prev = visibility;
    const next = visibility === "public" ? "private" : "public";
    visibility = next;
    saveState = "saving";
    try {
      await client.updatePage(pageId, { visibility: next });
      saveState = "saved";
    } catch (e) {
      visibility = prev;
      saveState = "idle";
      console.error("[page] toggleAccess failed", e);
    }
  }

  // ─── Slash menu plumbing ────────────────────────────────────────────────
  function positionSlash(rect: (() => DOMRect | null) | null): void {
    const r = rect?.();
    if (!r) return;
    slashTop = r.bottom + 6;
    slashLeft = r.left;
  }

  function runSlash(item: SlashItem): void {
    slashSelect?.(item);
    slashOpen = false;
  }

  const slashController: SlashController = {
    onStart: (s: SlashRenderState) => {
      slashItems = s.items;
      slashSelect = s.select;
      slashIndex = 0;
      positionSlash(s.rect);
      slashOpen = s.items.length > 0;
    },
    onUpdate: (s: SlashRenderState) => {
      slashItems = s.items;
      slashSelect = s.select;
      if (slashIndex >= s.items.length) slashIndex = Math.max(0, s.items.length - 1);
      positionSlash(s.rect);
      slashOpen = s.items.length > 0;
    },
    onKeyDown: (e: KeyboardEvent): boolean => {
      if (!slashOpen || slashItems.length === 0) return false;
      if (e.key === "ArrowDown") {
        slashIndex = (slashIndex + 1) % slashItems.length;
        return true;
      }
      if (e.key === "ArrowUp") {
        slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length;
        return true;
      }
      if (e.key === "Enter") {
        const it = slashItems[slashIndex];
        if (it) runSlash(it);
        return true;
      }
      if (e.key === "Escape") {
        // Menu is open (guarded above): consume Escape so it closes the menu and
        // never bubbles to a parent modal/dialog. TipTap's suggestion plugin
        // preventDefaults Escape but does NOT stopPropagation, so we do it here.
        e.preventDefault();
        e.stopPropagation();
        slashOpen = false;
        return true;
      }
      return false;
    },
    onExit: () => {
      slashOpen = false;
    },
  };

  // ─── Image insert (reuses the SHARED chat/DM upload pipeline) ────────────
  // Same flow Plane uses: drop a placeholder image (local preview) immediately,
  // run the real upload in the background, then swap the src in once it resolves.
  function pickImage(): void {
    imageInputEl?.click();
  }

  // Locate an image node by its transient uploadId and patch its attributes.
  function patchImageNode(uploadId: string, attrs: Record<string, unknown>): void {
    const e = editor;
    if (!e) return;
    const { state, view } = e;
    let pos = -1;
    let node: ProseNode | null = null;
    state.doc.descendants((n, p) => {
      if (n.type.name === "image" && n.attrs.uploadId === uploadId) {
        pos = p;
        node = n;
        return false;
      }
      return true;
    });
    if (pos < 0 || !node) return;
    view.dispatch(
      state.tr.setNodeMarkup(pos, undefined, { ...(node as ProseNode).attrs, ...attrs }),
    );
  }

  async function onImageChosen(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file || !editor) return;

    const uploadId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    saveState = "saving";
    // Instant local preview (Plane's blob-preview-while-uploading). In local/dev
    // mode this data URL is also what the upload fallback returns, so the image
    // stays embedded even with S3 off.
    let preview: string;
    try {
      preview = await readAsDataUrl(file);
    } catch (err) {
      saveState = "idle";
      console.error("[page] image read failed", err);
      toast.error("Couldn't read that image.");
      return;
    }
    if (!editor) return; // editor may have been torn down during the async read
    // insertContent (not setImage) so our custom uploadId/uploading attrs pass
    // through — the typed setImage command only accepts src/alt/title.
    editor
      .chain()
      .focus()
      .insertContent({ type: "image", attrs: { src: preview, uploadId, uploading: true } })
      .run();

    try {
      // The chat/DM composer pipeline: S3 presign + PUT in cloud, graceful
      // data-URL fallback when presign 503s (S3 off) — never silently fails.
      const att = await fileToAttachment(file);
      patchImageNode(uploadId, { src: att.url, uploading: false });
      saveState = "saved";
    } catch (err) {
      // Upload genuinely failed (e.g. file too large for local mode). Keep the
      // local preview but clear the spinner and surface the error.
      patchImageNode(uploadId, { uploading: false });
      saveState = "idle";
      console.error("[page] image upload failed", err);
      toast.error(err instanceof Error ? err.message : "Image upload failed.");
    }
  }

  onMount(() => {
    let destroyed = false;
    void (async () => {
      // intentional: a failed/absent page load falls through to the notFound state below.
      const p: Page | null = await client.fetchPage(pageId).catch(() => null);
      if (destroyed) return;
      if (!p) {
        notFound = true;
        loaded = true;
        return;
      }
      title = p.title;
      icon = p.icon;
      visibility = p.visibility;
      const el = editorEl;
      if (!el) return;
      editor = new Editor({
        element: el,
        extensions: [
          // StarterKit v3 bundles link + underline; disable its copies so our
          // configured copies register ONCE (kills the "Duplicate extension
          // names found: link, underline" TipTap warning).
          StarterKit.configure({ link: false, underline: false }),
          Underline,
          Link.configure({ openOnClick: false, autolink: true }),
          PageImage,
          TableKit.configure({ table: { resizable: true } }),
          TextAlign.configure({ types: ["heading", "paragraph"] }),
          Placeholder.configure({ placeholder: "Press '/' for commands…" }),
          createPageSlash({ controller: slashController, onPickImage: pickImage }),
          createPageDragHandle(),
        ],
        content: parseDoc(p.content),
        onUpdate: () => scheduleContentSave(),
        onTransaction: () => {
          selVersion++;
        },
        editorProps: {
          attributes: {
            class: "tiptap-doc focus:outline-none",
          },
        },
      });
      loaded = true;
    })();
    return () => {
      destroyed = true;
      void flushSaves();
      editor?.destroy();
      editor = null;
    };
  });

  // Toolbar active-state map; references selVersion so it recomputes per transaction.
  const active = $derived.by(() => {
    void selVersion;
    const e = editor;
    return {
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      underline: e?.isActive("underline") ?? false,
      strike: e?.isActive("strike") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      quote: e?.isActive("blockquote") ?? false,
      code: e?.isActive("codeBlock") ?? false,
      link: e?.isActive("link") ?? false,
      h1: e?.isActive("heading", { level: 1 }) ?? false,
      h2: e?.isActive("heading", { level: 2 }) ?? false,
      h3: e?.isActive("heading", { level: 3 }) ?? false,
      alignLeft: e?.isActive({ textAlign: "left" }) ?? false,
      alignCenter: e?.isActive({ textAlign: "center" }) ?? false,
      alignRight: e?.isActive({ textAlign: "right" }) ?? false,
    };
  });

  const blockLabel = $derived(
    active.h1 ? "Heading 1" : active.h2 ? "Heading 2" : active.h3 ? "Heading 3" : "Text",
  );

  function setBlock(kind: "p" | "h1" | "h2" | "h3"): void {
    const c = editor?.chain().focus();
    if (!c) return;
    if (kind === "p") c.setParagraph().run();
    else c.toggleHeading({ level: kind === "h1" ? 1 : kind === "h2" ? 2 : 3 }).run();
  }

  function setLink(): void {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  function insertTable(): void {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }

  function setAlign(dir: "left" | "center" | "right"): void {
    editor?.chain().focus().setTextAlign(dir).run();
  }

  // ─── Table controls (floating toolbar shown when the caret is in a table) ──
  // Mirrors Plane's table row/column controls: add column before/after, delete
  // column, add row before/after, delete row, delete table. Surfaced as a small
  // floating toolbar above the active table (TableKit supplies all the commands).
  let inTable = $state(false);
  let tableTop = $state(0);
  let tableLeft = $state(0);

  $effect(() => {
    void selVersion;
    const e = editor;
    if (!e || !e.isActive("table")) {
      inTable = false;
      return;
    }
    const at = e.view.domAtPos(e.state.selection.from)?.node;
    const el = at instanceof Element ? at : (at?.parentElement ?? null);
    const tableEl = el?.closest("table");
    if (!tableEl) {
      inTable = false;
      return;
    }
    const r = tableEl.getBoundingClientRect();
    tableTop = r.top;
    tableLeft = r.left;
    inTable = true;
  });

  function addColumnBefore(): void {
    editor?.chain().focus().addColumnBefore().run();
  }
  function addColumnAfter(): void {
    editor?.chain().focus().addColumnAfter().run();
  }
  function deleteColumn(): void {
    editor?.chain().focus().deleteColumn().run();
  }
  function addRowBefore(): void {
    editor?.chain().focus().addRowBefore().run();
  }
  function addRowAfter(): void {
    editor?.chain().focus().addRowAfter().run();
  }
  function deleteRow(): void {
    editor?.chain().focus().deleteRow().run();
  }
  function deleteTable(): void {
    editor?.chain().focus().deleteTable().run();
  }

  const toolBtn =
    "grid size-8 place-items-center rounded-md text-content-dim transition-colors hover:bg-hover-gray hover:text-content";
  const toolBtnActive = "bg-dropdown-selected text-content";
  const tableBtn =
    "grid size-7 place-items-center rounded text-content-dim transition-colors hover:bg-hover-gray hover:text-content";
</script>

<div class="flex h-full w-full flex-col overflow-hidden bg-surface">
  <!-- Toolbar -->
  <div class="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-edge px-3">
    <button
      type="button"
      onclick={backToPages}
      class="mr-1 grid size-8 shrink-0 place-items-center rounded-md text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
      aria-label="Back to Pages"
      title="Back to Pages"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>

    {#if editor}
      <!-- Block type -->
      <div class="relative shrink-0">
        <select
          class="h-8 cursor-pointer rounded-md border border-edge bg-surface-alt pl-2 pr-6 text-[13px] text-content focus:outline-none"
          value={blockLabel}
          onchange={(e) => {
            const v = e.currentTarget.value;
            setBlock(v === "Heading 1" ? "h1" : v === "Heading 2" ? "h2" : v === "Heading 3" ? "h3" : "p");
          }}
        >
          <option>Text</option>
          <option>Heading 1</option>
          <option>Heading 2</option>
          <option>Heading 3</option>
        </select>
      </div>

      <span class="mx-1 h-5 w-px shrink-0 bg-edge"></span>

      <button type="button" class={cn(toolBtn, active.bold && toolBtnActive)} onclick={() => editor?.chain().focus().toggleBold().run()} aria-label="Bold" title="Bold">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.italic && toolBtnActive)} onclick={() => editor?.chain().focus().toggleItalic().run()} aria-label="Italic" title="Italic">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.underline && toolBtnActive)} onclick={() => editor?.chain().focus().toggleUnderline().run()} aria-label="Underline" title="Underline">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.strike && toolBtnActive)} onclick={() => editor?.chain().focus().toggleStrike().run()} aria-label="Strikethrough" title="Strikethrough">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/></svg>
      </button>

      <span class="mx-1 h-5 w-px shrink-0 bg-edge"></span>

      <button type="button" class={cn(toolBtn, active.bullet && toolBtnActive)} onclick={() => editor?.chain().focus().toggleBulletList().run()} aria-label="Bullet list" title="Bullet list">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.ordered && toolBtnActive)} onclick={() => editor?.chain().focus().toggleOrderedList().run()} aria-label="Numbered list" title="Numbered list">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.quote && toolBtnActive)} onclick={() => editor?.chain().focus().toggleBlockquote().run()} aria-label="Quote" title="Quote">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5H3v8c0 1 0 3-3 3"/><path d="M14 21c3 0 7-1 7-8V5h-7v8c0 1 0 3-3 3"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.code && toolBtnActive)} onclick={() => editor?.chain().focus().toggleCodeBlock().run()} aria-label="Code block" title="Code block">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </button>
      <button type="button" class={cn(toolBtn, active.link && toolBtnActive)} onclick={setLink} aria-label="Link" title="Link">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      </button>
      <button type="button" class={toolBtn} onclick={() => editor?.chain().focus().setHorizontalRule().run()} aria-label="Divider" title="Divider">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/></svg>
      </button>

      <span class="mx-1 h-5 w-px shrink-0 bg-edge"></span>

      <!-- Alignment -->
      <button type="button" class={cn(toolBtn, active.alignLeft && toolBtnActive)} onclick={() => setAlign("left")} aria-label="Align left" title="Align left">
        <AlignLeftIcon size={15} />
      </button>
      <button type="button" class={cn(toolBtn, active.alignCenter && toolBtnActive)} onclick={() => setAlign("center")} aria-label="Align center" title="Align center">
        <AlignCenterIcon size={15} />
      </button>
      <button type="button" class={cn(toolBtn, active.alignRight && toolBtnActive)} onclick={() => setAlign("right")} aria-label="Align right" title="Align right">
        <AlignRightIcon size={15} />
      </button>

      <span class="mx-1 h-5 w-px shrink-0 bg-edge"></span>

      <!-- Insert: image + table -->
      <button type="button" class={toolBtn} onclick={pickImage} aria-label="Insert image" title="Insert image">
        <ImageIcon size={15} />
      </button>
      <button type="button" class={toolBtn} onclick={insertTable} aria-label="Insert table" title="Insert table">
        <TableIcon size={15} />
      </button>
    {/if}

    <span class="ml-auto shrink-0 pr-1 text-[12px] text-content-muted">
      {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
    </span>
  </div>

  <!-- Document -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if notFound}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p class="text-[14px] font-semibold text-content">Page not found</p>
        <button
          type="button"
          onclick={() => goto(`/workspace/${wsId}/tasks/${projectId}/pages`)}
          class="text-[13px] font-medium text-accent hover:underline">Back to Pages</button
        >
      </div>
    {/if}
    <div class={cn("mx-auto w-full max-w-[820px] px-6 py-10", notFound && "hidden")}>
      <!-- Icon + access affordances above the title (Plane parity) -->
      <div class="relative mb-3 flex items-center gap-2">
        {#if icon}
          <button
            type="button"
            onclick={() => (showIconPicker = !showIconPicker)}
            class="group/icon grid size-12 place-items-center rounded-lg transition-colors hover:bg-hover-gray"
            aria-label="Change page icon"
            title="Change icon"
          >
            <Emoji emoji={icon} size={40} />
          </button>
          <button
            type="button"
            onclick={() => void setIcon(null)}
            class="grid size-6 place-items-center rounded text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
            aria-label="Remove icon"
            title="Remove icon"
          >
            <XIcon size={14} />
          </button>
        {:else}
          <button
            type="button"
            onclick={() => (showIconPicker = !showIconPicker)}
            class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
            aria-label="Add page icon"
          >
            <SmilePlusIcon size={16} />
            Add icon
          </button>
        {/if}

        <button
          type="button"
          onclick={() => void toggleAccess()}
          class="inline-flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[13px] font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
          title={visibility === "public" ? "Public — click to make private" : "Private — click to make public"}
        >
          {#if visibility === "public"}
            <GlobeIcon size={14} />
            Public
          {:else}
            <LockIcon size={14} />
            Private
          {/if}
        </button>

        <button
          type="button"
          onclick={() => void addSubpage()}
          class="inline-flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[13px] font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
          title="Add a subpage under this page"
        >
          <FilePlusIcon size={14} />
          Add subpage
        </button>

        {#if showIconPicker}
          <div class="absolute left-0 top-full z-50 mt-1">
            <EmojiPicker onSelect={(em) => void setIcon(em)} onClose={() => (showIconPicker = false)} />
          </div>
        {/if}
      </div>

      <input
        type="text"
        bind:value={title}
        oninput={onTitleInput}
        onblur={() => void flushSaves()}
        placeholder="Untitled"
        class="mb-3 w-full bg-transparent text-[34px] font-bold leading-tight text-content placeholder:text-content-muted/50 focus:outline-none"
      />
      <!-- TipTap mounts here -->
      <div bind:this={editorEl} class="page-editor-body"></div>
      {#if !loaded}
        <div class="mt-2 h-4 w-2/3 animate-pulse rounded bg-deeper"></div>
      {/if}
    </div>
  </div>
</div>

<!-- Hidden file input for image inserts (toolbar + slash command). -->
<input
  bind:this={imageInputEl}
  type="file"
  accept="image/*"
  class="hidden"
  onchange={(e) => void onImageChosen(e)}
/>

<!-- Slash-command menu (positioned at the "/" caret; tokens only). -->
{#if slashOpen && slashItems.length > 0}
  <div
    class="fixed z-50 max-h-[320px] w-64 overflow-y-auto rounded-lg border border-edge bg-surface-alt p-1 shadow-lg"
    style="top: {slashTop}px; left: {slashLeft}px;"
    role="listbox"
    aria-label="Slash commands"
  >
    {#each slashItems as item, i (item.key)}
      {@const Icon = SLASH_ICONS[item.iconKey]}
      <!-- role="option" must be a non-interactive container (not a <button>);
           selection is driven by the editor's keydown handler, not focus.
           tabindex=-1 keeps it out of the tab order, and onmousedown's
           preventDefault keeps focus in the editor so arrow keys keep working. -->
      <div
        role="option"
        tabindex={-1}
        aria-selected={i === slashIndex}
        onmousedown={(e) => {
          e.preventDefault();
          runSlash(item);
        }}
        onmouseenter={() => (slashIndex = i)}
        class={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
          i === slashIndex ? "bg-dropdown-selected text-content" : "text-content-dim",
        )}
      >
        <span class="grid size-7 shrink-0 place-items-center rounded-md border border-edge bg-surface text-content-dim">
          <Icon size={15} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] font-medium text-content">{item.title}</span>
          <span class="block truncate text-[11px] text-content-muted">{item.description}</span>
        </span>
      </div>
    {/each}
  </div>
{/if}

<!-- Floating table controls (shown when the caret is inside a table; tokens only). -->
{#if inTable}
  <div
    class="fixed z-40 flex items-center gap-0.5 rounded-md border border-edge bg-surface-alt p-0.5 shadow-lg"
    style="top: {tableTop}px; left: {tableLeft}px; transform: translateY(calc(-100% - 6px));"
    role="toolbar"
    aria-label="Table controls"
  >
    <button type="button" class={tableBtn} onclick={addColumnBefore} aria-label="Insert column before" title="Insert column before">
      <BetweenVerticalStartIcon size={15} />
    </button>
    <button type="button" class={tableBtn} onclick={addColumnAfter} aria-label="Insert column after" title="Insert column after">
      <BetweenVerticalEndIcon size={15} />
    </button>
    <button type="button" class={tableBtn} onclick={deleteColumn} aria-label="Delete column" title="Delete column">
      <XIcon size={15} />
    </button>
    <span class="mx-0.5 h-4 w-px bg-edge"></span>
    <button type="button" class={tableBtn} onclick={addRowBefore} aria-label="Insert row above" title="Insert row above">
      <BetweenHorizontalStartIcon size={15} />
    </button>
    <button type="button" class={tableBtn} onclick={addRowAfter} aria-label="Insert row below" title="Insert row below">
      <BetweenHorizontalEndIcon size={15} />
    </button>
    <button type="button" class={tableBtn} onclick={deleteRow} aria-label="Delete row" title="Delete row">
      <XIcon size={15} />
    </button>
    <span class="mx-0.5 h-4 w-px bg-edge"></span>
    <button type="button" class={tableBtn} onclick={deleteTable} aria-label="Delete table" title="Delete table">
      <Trash2Icon size={15} />
    </button>
  </div>
{/if}

<style>
  /* Document prose styling — theme tokens via CSS vars (dark + light resolve). */
  .page-editor-body :global(.tiptap-doc) {
    min-height: 50vh;
    font-size: 16px;
    line-height: 1.7;
    color: var(--text-primary);
  }
  .page-editor-body :global(.tiptap-doc > * + *) {
    margin-top: 0.6em;
  }
  .page-editor-body :global(h1) {
    font-size: 1.6em;
    font-weight: 700;
    line-height: 1.25;
    margin-top: 1em;
  }
  .page-editor-body :global(h2) {
    font-size: 1.3em;
    font-weight: 700;
    line-height: 1.3;
    margin-top: 1em;
  }
  .page-editor-body :global(h3) {
    font-size: 1.1em;
    font-weight: 600;
    margin-top: 0.8em;
  }
  .page-editor-body :global(ul),
  .page-editor-body :global(ol) {
    padding-left: 1.4em;
  }
  .page-editor-body :global(ul) {
    list-style: disc;
  }
  .page-editor-body :global(ol) {
    list-style: decimal;
  }
  .page-editor-body :global(li) {
    margin: 0.2em 0;
  }
  .page-editor-body :global(blockquote) {
    border-left: 3px solid var(--border-light);
    padding-left: 1em;
    color: var(--text-secondary);
  }
  .page-editor-body :global(code) {
    background: var(--bg-deeper);
    border-radius: 4px;
    padding: 0.1em 0.3em;
    font-size: 0.9em;
  }
  .page-editor-body :global(pre) {
    background: var(--bg-deeper);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.8em 1em;
    overflow-x: auto;
  }
  .page-editor-body :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .page-editor-body :global(a) {
    color: var(--c7-accent);
    text-decoration: underline;
  }
  .page-editor-body :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.2em 0;
  }
  .page-editor-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    transition: opacity 200ms ease;
  }
  /* Tables (TipTap TableKit) — token-based borders + header band. */
  .page-editor-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    overflow: hidden;
  }
  .page-editor-body :global(th),
  .page-editor-body :global(td) {
    border: 1px solid var(--border);
    padding: 0.4em 0.6em;
    vertical-align: top;
  }
  .page-editor-body :global(th) {
    background: var(--bg-deeper);
    font-weight: 600;
    text-align: left;
  }
  .page-editor-body :global(.selectedCell::after) {
    background: var(--dropdown-selected);
    content: "";
    inset: 0;
    pointer-events: none;
    position: absolute;
    z-index: 2;
  }
  .page-editor-body :global(table .column-resize-handle) {
    background: var(--c7-accent);
    bottom: 0;
    pointer-events: none;
    position: absolute;
    right: -1px;
    top: 0;
    width: 2px;
  }
  /* Placeholder (Press '/' for commands…) on the empty first line. */
  .page-editor-body :global(.tiptap-doc p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    color: var(--text-muted);
    float: left;
    height: 0;
    pointer-events: none;
  }

  /* ─── Block side menu: drag handle (6-dot grip) + "+" insert affordance ─── */
  /* The plugin appends #editor-side-menu to this element, so it must anchor. */
  .page-editor-body {
    position: relative;
  }
  .page-editor-body :global(#editor-side-menu) {
    position: absolute;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 1px;
    transition: opacity 150ms ease;
  }
  .page-editor-body :global(#editor-side-menu.side-menu-hidden) {
    opacity: 0;
    pointer-events: none;
  }
  .page-editor-body :global(#page-insert-handle),
  .page-editor-body :global(#drag-handle) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-muted);
    background: transparent;
    outline: none;
    transition:
      background-color 150ms ease,
      color 150ms ease,
      opacity 150ms ease;
  }
  .page-editor-body :global(#page-insert-handle) {
    cursor: pointer;
  }
  .page-editor-body :global(#drag-handle) {
    cursor: grab;
  }
  .page-editor-body :global(#drag-handle:active) {
    cursor: grabbing;
  }
  .page-editor-body :global(#page-insert-handle:hover),
  .page-editor-body :global(#drag-handle:hover) {
    background: var(--hover-gray);
    color: var(--text-primary);
  }
  .page-editor-body :global(#drag-handle.drag-handle-hidden) {
    opacity: 0;
    pointer-events: none;
  }
  .page-editor-body :global(#drag-handle .drag-grip) {
    display: inline-flex;
    pointer-events: none;
  }
  .page-editor-body :global(#drag-handle .drag-grip-2) {
    margin-left: -10px;
  }
  .page-editor-body :global(.tiptap-doc.dragging) {
    cursor: grabbing;
  }
  .page-editor-body :global(.tiptap-doc .ProseMirror-selectednode) {
    outline: 2px solid var(--c7-accent);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* Image upload loading state — Plane's pulse skeleton while the upload runs,
     plus a soft fade-in once the real src swaps in. */
  .page-editor-body :global(img[data-uploading="true"]) {
    opacity: 0.55;
    animation: page-img-pulse 1.2s ease-in-out infinite;
  }
  @keyframes page-img-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 0.85;
    }
  }
</style>
