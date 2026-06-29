<script lang="ts">
  import VoicePlayer from "../message/VoicePlayer.svelte";
  import type { Attachment } from "$lib/types.js";

  export interface PendingFile {
    id: string;
    file: File | null;
    preview?: string;
    uploading: boolean;
    error?: string;
    mimeType: string;
    fileName: string;
    // Live S3-upload progress 0–100 (#517). Set while `uploading`; undefined when
    // the platform can't report it (Tauri iOS) → the chip falls back to a spinner.
    progress?: number;
    // Set once the file has been uploaded eagerly (on paste/drop/pick). Send
    // reuses this instead of re-uploading; presence of it shows the ✓ chip.
    uploaded?: Attachment;
  }

  let {
    files = [],
    onRemove,
    onRetry,
  }: {
    files: PendingFile[];
    onRemove: (id: string) => void;
    onRetry?: (id: string) => void;
  } = $props();

  const audioFiles = $derived(files.filter((f) => f.mimeType.startsWith("audio/")));
  const nonAudioFiles = $derived(files.filter((f) => !f.mimeType.startsWith("audio/")));
</script>

{#if audioFiles.length > 0}
  {#each audioFiles as pf (pf.id)}
    <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 group">
      {#if pf.preview}
        <VoicePlayer src={pf.preview} type={pf.mimeType} />
      {:else}
        <div class="flex items-center gap-2 rounded-full border border-edge bg-raised/60 px-3 py-2 text-[12px] text-content-dim">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /></svg>
          Voice note
        </div>
      {/if}
      {#if pf.uploading}
        {#if typeof pf.progress === "number"}
          <!-- Live upload progress (#517): % + bar. Cancel via the × button. -->
          <div class="flex items-center gap-1.5 shrink-0" data-testid="attachment-progress">
            <div class="h-1 w-[40px] rounded-full bg-content-muted/25 overflow-hidden">
              <div
                class="h-full bg-content-muted transition-[width] duration-150"
                style="width: {pf.progress}%"
              ></div>
            </div>
            <span class="text-[11px] tabular-nums text-content-dim">{pf.progress}%</span>
          </div>
        {:else}
          <div class="w-5 h-5 border-2 border-content-muted/30 border-t-content-muted rounded-full animate-spin shrink-0"></div>
        {/if}
      {:else if pf.error && onRetry}
        <!-- Voice-note upload failure: inline error + retry (parity with the
             thumbnail strip's retry affordance). -->
        <button
          type="button"
          onclick={(e) => { e.stopPropagation(); onRetry(pf.id); }}
          title="Retry: {pf.error}"
          class="shrink-0 flex items-center gap-1 rounded-full bg-error/15 px-2 py-1 text-[11px] font-medium text-error cursor-pointer hover:bg-error/25 transition-colors"
          data-testid="attachment-error"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          Upload failed — retry
        </button>
      {/if}
      <button
        type="button"
        onclick={() => onRemove(pf.id)}
        aria-label={pf.uploading ? "Cancel upload" : "Remove voice note"}
        class="shrink-0 h-[24px] w-[24px] rounded-full bg-raised text-content ring-2 ring-surface-alt text-[13px] font-bold flex items-center justify-center cursor-pointer"
      >&times;</button>
    </div>
  {/each}
{/if}

{#if nonAudioFiles.length > 0}
  <div class="flex gap-2 px-3 pt-2 pb-1 overflow-x-auto">
    {#each nonAudioFiles as pf (pf.id)}
      <div class="relative shrink-0 group">
        {#if pf.mimeType.startsWith("image/") && pf.preview}
          <img src={pf.preview} alt={pf.fileName} class="h-[64px] w-[64px] object-cover rounded-[12px] border border-edge" />
        {:else if pf.mimeType.startsWith("video/")}
          <div class="h-[64px] w-[64px] rounded-[12px] border border-edge bg-raised flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-content-dim"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          </div>
        {:else}
          <div class="h-[64px] w-[64px] rounded-[12px] border border-edge bg-raised flex flex-col items-center justify-center px-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-content-dim"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            <span class="text-[8px] text-content-muted mt-0.5 truncate w-full text-center">{pf.fileName.split(".").pop()}</span>
          </div>
        {/if}

        {#if pf.uploading}
          <div class="absolute inset-0 rounded-[12px] bg-black/50 flex flex-col items-center justify-center gap-1 px-2">
            {#if typeof pf.progress === "number"}
              <!-- Live upload progress (#517): % + bar. The × button cancels. -->
              <span class="text-[11px] font-semibold tabular-nums text-accent-foreground" data-testid="attachment-progress">{pf.progress}%</span>
              <div class="h-1 w-[48px] rounded-full bg-accent-foreground/25 overflow-hidden">
                <div class="h-full bg-accent-foreground transition-[width] duration-150" style="width: {pf.progress}%"></div>
              </div>
            {:else}
              <div class="w-4 h-4 border-2 border-accent-foreground/30 border-t-accent-foreground rounded-full animate-spin"></div>
            {/if}
          </div>
        {/if}

        {#if pf.uploaded && !pf.uploading && !pf.error}
          <div class="absolute top-1 left-1 rounded-full bg-online/90 p-0.5" title="Ready to send">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-accent-foreground" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        {/if}

        {#if pf.error && !pf.uploading && onRetry}
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); onRetry(pf.id); }}
            title="Retry: {pf.error}"
            class="absolute inset-0 rounded-[12px] bg-red-900/70 flex flex-col items-center justify-center gap-0.5 cursor-pointer hover:bg-red-900/90 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-accent-foreground">
              <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            <span class="text-[8px] text-white font-semibold uppercase tracking-wider">Retry</span>
          </button>
        {/if}

        <!-- Remove: 24px, always visible (touch has no hover), punched out of the
             composer surface with a surface-alt ring (iMessage-style X). -->
        <button
          type="button"
          onclick={() => onRemove(pf.id)}
          aria-label={pf.uploading ? "Cancel upload" : "Remove attachment"}
          class="absolute -top-1.5 -right-1.5 h-[24px] w-[24px] rounded-full bg-raised text-content ring-2 ring-surface-alt text-[13px] font-bold flex items-center justify-center cursor-pointer tap-expand"
        >&times;</button>
        {#if pf.error && !pf.uploading}
          <!-- Visible per-file error caption (Item: per-file upload error UI).
               Previously the failure was only conveyed via the overlay's title
               tooltip; surface it inline so the user sees WHICH file failed and
               WHY without hovering. The caption text promises "tap to retry", so
               render it as a button wired to the same retry handler as the
               overlay — tapping the visible text actually retries. Falls back to
               a plain span when no onRetry is provided. -->
          {#if onRetry}
            <button
              type="button"
              onclick={(e) => { e.stopPropagation(); onRetry(pf.id); }}
              class="block text-[9px] text-error font-medium mt-0.5 w-[64px] text-center leading-tight line-clamp-2 cursor-pointer hover:underline"
              title="Retry: {pf.error}"
              data-testid="attachment-error"
            >
              Upload failed — tap to retry
            </button>
          {:else}
            <span class="block text-[9px] text-error font-medium mt-0.5 w-[64px] text-center leading-tight line-clamp-2" title={pf.error} data-testid="attachment-error">
              Upload failed
            </span>
          {/if}
        {:else}
          <span class="block text-[9px] text-content-muted mt-0.5 truncate w-[64px] text-center">{pf.fileName}</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
