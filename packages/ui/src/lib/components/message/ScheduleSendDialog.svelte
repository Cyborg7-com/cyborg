<script lang="ts">
  // #607 — "Schedule send" modal. Takes the composer's current text + mentions
  // and the active target (a channel or a DM peer), lets the user pick a future
  // time with a native <input type="datetime-local">, and creates a scheduled
  // message via scheduleMessage(). On success it calls onScheduled() so the
  // composer clears exactly like a normal send. No new deps — the date picker is
  // the platform control (there's no shadcn Calendar installed).
  import { scheduleMessage } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import { cn } from "$lib/utils.js";
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
    // EXACTLY ONE of these identifies the send target (mirrors the contract).
    channelId = null,
    toId = null,
    // Human label for the target ("#general" / a DM peer name) — display only.
    targetLabel,
    // The composer's current draft, captured when the dialog opens.
    text,
    mentions,
    // Called after a successful schedule so the composer can clear its draft.
    onScheduled,
  }: {
    open?: boolean;
    channelId?: string | null;
    toId?: string | null;
    targetLabel: string;
    text: string;
    mentions?: string[];
    onScheduled: () => void;
  } = $props();

  // Local wall-clock string for the <input type="datetime-local"> (YYYY-MM-DDTHH:mm).
  let when = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  // Format an epoch-ms instant as the local datetime-local value the input wants.
  // (toISOString would shift to UTC; we want the user's wall clock.)
  function toLocalInput(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // `min` for the input + the floor for the past-time guard. Recomputed when the
  // dialog opens so it never offers a moment that's already passed.
  let minWhen = $state("");

  // Seed a sensible default (one hour out, rounded to the minute) each time the
  // dialog opens, and refresh the min. Reset transient state too.
  $effect(() => {
    if (!open) return;
    const now = Date.now();
    minWhen = toLocalInput(now + 60_000); // earliest selectable: one minute out
    when = toLocalInput(now + 60 * 60_000);
    error = null;
    submitting = false;
  });

  // Parse the local input back to epoch ms. `new Date("YYYY-MM-DDTHH:mm")` is
  // interpreted in LOCAL time (what the picker shows), which is what we want.
  const sendAt = $derived.by(() => {
    if (!when) return Number.NaN;
    const ms = new Date(when).getTime();
    return Number.isFinite(ms) ? ms : Number.NaN;
  });

  const isPast = $derived(!Number.isNaN(sendAt) && sendAt <= Date.now());
  const hasValidTime = $derived(!Number.isNaN(sendAt) && !isPast);

  // Friendly preview of the chosen moment ("Mon, Jun 16, 2:30 PM").
  const whenLabel = $derived.by(() => {
    if (Number.isNaN(sendAt)) return "";
    return new Date(sendAt).toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  });

  async function confirm(): Promise<void> {
    if (!hasValidTime || submitting) return;
    const target = channelId ? { channelId } : toId ? { toId } : null;
    if (!target) {
      error = "No target channel or conversation.";
      return;
    }
    submitting = true;
    error = null;
    const res = await scheduleMessage(target, text, sendAt, mentions);
    submitting = false;
    if (res.ok) {
      open = false;
      onScheduled();
    } else {
      error = res.error ?? "Couldn't schedule the message.";
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[440px]">
    <DialogHeader>
      <DialogTitle>Schedule send</DialogTitle>
      <DialogDescription>
        Pick when to send this message to {targetLabel}. It'll go out automatically at that time.
      </DialogDescription>
    </DialogHeader>

    <div class="flex flex-col gap-3">
      <!-- Message preview so the user confirms WHAT they're scheduling. -->
      <div
        class="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-surface px-3 py-2 text-[13px] leading-snug text-content-muted"
      >
        {text}
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="schedule-when" class="text-[13px] font-medium text-content">
          Send at
        </label>
        <input
          id="schedule-when"
          type="datetime-local"
          bind:value={when}
          min={minWhen}
          class={cn(fieldInputClass, "[color-scheme:light] dark:[color-scheme:dark]")}
        />
        {#if isPast}
          <p class="text-xs text-warning">Pick a time in the future.</p>
        {:else if whenLabel}
          <p class="text-xs text-content-muted">Sends {whenLabel}.</p>
        {/if}
      </div>

      {#if error}
        <p class="text-xs text-error" role="alert">{error}</p>
      {/if}
    </div>

    <DialogFooter class="gap-2">
      <Button variant="ghost" onclick={() => { open = false; }}>Cancel</Button>
      <Button onclick={confirm} disabled={!hasValidTime || submitting}>
        {submitting ? "Scheduling…" : "Schedule"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
