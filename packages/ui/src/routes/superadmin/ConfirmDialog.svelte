<script lang="ts">
  // Destructive-action confirmation for the superadmin pages. Built on the
  // shadcn-svelte Dialog primitives. Two modes:
  //   • plain confirm — title + body + Confirm/Cancel.
  //   • typed confirm — caller passes `confirmText`; the Confirm button stays
  //     disabled until the user types it exactly (used for Delete, which the
  //     API also guards via confirmEmail).
  // `onConfirm` may be async; the button shows a pending state while it runs and
  // surfaces a thrown error inline instead of closing.
  //
  // Buttons use the app's native button styles (rounded-lg + token colors); the
  // destructive variant tints with the error token, matching the rest of the
  // superadmin rework. Cancel + Confirm keep their pending guards.
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";

  let {
    open = $bindable(false),
    title,
    description = "",
    confirmLabel = "Confirm",
    confirmVariant = "destructive",
    // When set, the user must type this exact string to enable Confirm.
    confirmText = null,
    confirmTextLabel = "Type to confirm",
    // Optional free-text reason field (e.g. suspend). Two-way bound to the caller.
    reason = $bindable<string | null>(null),
    reasonLabel = "Reason",
    reasonPlaceholder = "",
    onConfirm,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    confirmVariant?: "destructive" | "default";
    confirmText?: string | null;
    confirmTextLabel?: string;
    reason?: string | null;
    reasonLabel?: string;
    reasonPlaceholder?: string;
    onConfirm: () => void | Promise<void>;
  } = $props();

  let typed = $state("");
  let pending = $state(false);
  let error = $state<string | null>(null);

  // Reset the local typed/error state whenever the dialog (re)opens.
  $effect(() => {
    if (open) {
      typed = "";
      error = null;
      pending = false;
    }
  });

  // Trimmed + case-insensitive so an email confirm (e.g. delete-user) isn't
  // blocked by accidental casing or trailing whitespace — matches the server's
  // own case-insensitive confirmEmail check.
  const typedOk = $derived(
    confirmText === null || typed.trim().toLowerCase() === confirmText.trim().toLowerCase(),
  );

  async function handleConfirm() {
    if (!typedOk || pending) return;
    pending = true;
    error = null;
    try {
      await onConfirm();
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "Action failed";
    } finally {
      pending = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent
    class="sm:max-w-md"
    escapeKeydownBehavior={pending ? "ignore" : "close"}
    interactOutsideBehavior={pending ? "ignore" : "close"}
  >
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {#if description}
        <DialogDescription>{description}</DialogDescription>
      {/if}
    </DialogHeader>

    {#if reason !== null}
      <div class="space-y-1.5">
        <label for="reason-input" class="block text-[13px] font-medium text-content-dim">
          {reasonLabel}
        </label>
        <input
          id="reason-input"
          bind:value={reason}
          autocomplete="off"
          class="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm text-content outline-none placeholder:text-content-muted focus:border-edge-light"
          placeholder={reasonPlaceholder}
        />
      </div>
    {/if}

    {#if confirmText !== null}
      <div class="space-y-1.5">
        <label for="confirm-input" class="block text-[13px] font-medium text-content-dim">
          {confirmTextLabel}
        </label>
        <input
          id="confirm-input"
          bind:value={typed}
          autocomplete="off"
          spellcheck="false"
          class="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm text-content outline-none placeholder:text-content-muted focus:border-edge-light"
          placeholder={confirmText}
        />
      </div>
    {/if}

    {#if error}
      <p class="text-sm text-error">{error}</p>
    {/if}

    <DialogFooter>
      <button
        type="button"
        onclick={() => (open = false)}
        disabled={pending}
        class="rounded-lg border border-edge px-4 py-2 text-sm font-medium text-content-muted transition-colors hover:bg-surface-alt hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleConfirm}
        disabled={!typedOk || pending}
        class={[
          "rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          confirmVariant === "destructive"
            ? "bg-error/15 text-error hover:bg-error/25"
            : "bg-btn-primary-bg text-btn-primary-text hover:bg-btn-primary-hover",
        ].join(" ")}
      >
        {pending ? "Working…" : confirmLabel}
      </button>
    </DialogFooter>
  </DialogContent>
</Dialog>
