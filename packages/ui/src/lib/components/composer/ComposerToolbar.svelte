<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    bold = false,
    italic = false,
    strike = false,
    orderedList = false,
    bulletList = false,
    blockquote = false,
    code = false,
    codeBlock = false,
    link = false,
    onToggleBold,
    onToggleItalic,
    onToggleStrike,
    onToggleOrderedList,
    onToggleBulletList,
    onToggleBlockquote,
    onToggleCode,
    onToggleCodeBlock,
    onLinkClick,
  }: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    orderedList?: boolean;
    bulletList?: boolean;
    blockquote?: boolean;
    code?: boolean;
    codeBlock?: boolean;
    link?: boolean;
    onToggleBold: () => void;
    onToggleItalic?: () => void;
    onToggleStrike?: () => void;
    onToggleOrderedList: () => void;
    onToggleBulletList: () => void;
    onToggleBlockquote: () => void;
    onToggleCode: () => void;
    onToggleCodeBlock: () => void;
    onLinkClick: () => void;
  } = $props();
</script>

<div class="flex items-center px-1.5 py-1 border-b border-edge gap-px rounded-t-lg" style="background-color: var(--bg-surface);">
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleBold(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] font-bold transition-colors", bold ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Bold (⌘B)"
  >B</button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleItalic?.(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] italic transition-colors", italic ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Italic (⌘I)"
  >i</button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleStrike?.(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] line-through transition-colors", strike ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Strikethrough (~~text~~)"
  >S</button>

  <div class="w-px h-4 bg-edge mx-1"></div>

  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onLinkClick(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] transition-colors", link ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Link (⌘K)"
  >
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
  </button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleOrderedList(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] transition-colors", orderedList ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Numbered list"
  >
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><text x="3" y="7" font-size="7" fill="currentColor" stroke="none" font-family="sans-serif">1</text><text x="3" y="13" font-size="7" fill="currentColor" stroke="none" font-family="sans-serif">2</text><text x="3" y="19" font-size="7" fill="currentColor" stroke="none" font-family="sans-serif">3</text></svg>
  </button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleBulletList(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] transition-colors", bulletList ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Bullet list"
  >
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none" /></svg>
  </button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleBlockquote(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[14px] transition-colors", blockquote ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Quote"
  >
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21" /><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3" /></svg>
  </button>

  <div class="w-px h-4 bg-edge mx-1"></div>

  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleCode(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[13px] font-mono transition-colors", code ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Inline code"
  >{'</>'}</button>
  <button
    type="button"
    onmousedown={(e) => { e.preventDefault(); onToggleCodeBlock(); }}
    class={cn("touch-target w-7 h-7 flex items-center justify-center rounded cursor-pointer text-[11px] font-mono transition-colors", codeBlock ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge hover:text-content") + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
    title="Code block"
  >{'{}'}</button>
</div>
