<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import { Dialog, DialogContent, DialogTitle } from "$lib/components/ui/dialog/index.js";

  let {
    open = $bindable(false),
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();
</script>

{#if open && viewportState.isMobile}
  <!-- Mobile: iOS-style action sheet. Title 17 semibold, message 13 muted,
       stacked full-width ≥48pt buttons — destructive confirm reads red. Same
       props/flows as desktop; swipe-down / backdrop / ESC all map to cancel. -->
  <MobileSheet {open} ariaLabel={title} onclose={oncancel}>
    <div class="pb-1 text-center">
      <h3 class="text-[17px] font-semibold text-content">{title}</h3>
      {#if message}
        <p class="mx-auto mt-1.5 max-w-[30ch] text-[13px] leading-snug text-content-dim">{message}</p>
      {/if}
    </div>

    <div class="mt-3 flex flex-col gap-2">
      <button
        type="button"
        onclick={onconfirm}
        class={cn(
          "flex min-h-[48px] w-full items-center justify-center rounded-[12px] px-4 text-[16px] font-semibold transition-colors active:opacity-80",
          destructive
            ? "bg-error/10 text-error active:bg-error/20"
            : "bg-accent text-accent-foreground active:bg-accent-hover",
        )}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onclick={oncancel}
        class="flex min-h-[48px] w-full items-center justify-center rounded-[12px] bg-surface-alt px-4 text-[16px] font-medium text-content transition-colors active:bg-raised"
      >
        {cancelLabel}
      </button>
    </div>
  </MobileSheet>
{:else if !viewportState.isMobile}
  <!-- Desktop: centered card via bits-ui Dialog. The Dialog gives us role=dialog,
       aria-modal, aria-labelledby (DialogTitle), Escape-to-close, focus-trap and
       scroll-lock for free — replacing the old hand-rolled portal + backdrop. The
       parent owns `open` (a derived condition), so Escape / outside-click route
       through onOpenChange → oncancel, mirroring the old backdrop click. No default
       X close — the Cancel/Confirm buttons are the closes. -->
  <Dialog {open} onOpenChange={(o) => { if (!o) oncancel(); }}>
    <DialogContent
      class="mx-4 w-full max-w-sm gap-0 rounded-xl bg-raised p-5 shadow-xl ring-0"
      showCloseButton={false}
    >
      <DialogTitle class="text-base font-bold text-content">{title}</DialogTitle>
      {#if message}
        <p class="mt-2 text-sm text-content-dim">{message}</p>
      {/if}
      <div class="mt-4 flex gap-3">
        <button
          onclick={oncancel}
          class="flex-1 rounded-xl border border-edge px-4 py-2.5 text-sm font-medium text-content-dim hover:bg-surface-alt transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          onclick={onconfirm}
          class={cn(
            "flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-accent-foreground transition-colors",
            destructive ? "bg-error hover:bg-error/80" : "bg-accent hover:bg-accent-hover",
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogContent>
  </Dialog>
{/if}
