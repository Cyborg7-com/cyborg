<script lang="ts">
  // Divider shown at the boundary between already-read and unread messages.
  // Rendered once per channel-open at the first-unread position and frozen
  // there — it does NOT move as new messages arrive after open.
  // Ported from cyborg7-core's UnreadDivider.tsx; restyled in the iOS redesign
  // (P4a) to a thin accent line + right-aligned "NEW" label (iMessage-adjacent,
  // subtler than the old full-width red pill). Render conditions unchanged;
  // `data-unread-divider` is load-bearing (the "N new messages" toast jump
  // targets it via querySelector).
  // onCatchup (#597): when provided, render a "Summarize new messages" button on
  // the divider — the Mattermost "Ask AI → Summarize new messages" affordance at
  // the New-Messages cutoff. Omitted → divider stays a plain line (DMs, previews).
  let { label = "New", onCatchup }: { label?: string; onCatchup?: () => void } = $props();
</script>

<div data-unread-divider="true" class="my-3 flex select-none items-center gap-2">
  <div class="h-px flex-1 bg-accent/70"></div>
  {#if onCatchup}
    <button
      type="button"
      onclick={onCatchup}
      class="pressable inline-flex items-center gap-1 rounded-full border border-accent/40 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10"
      title="Summarize everything you missed since you last read this channel"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/></svg>
      Summarize new messages
    </button>
  {/if}
  <span class="text-[11px] font-bold uppercase tracking-wider text-accent">
    {label}
  </span>
</div>
