<script lang="ts">
  // Live heartbeat countdown — ported from cyborg7-core's HeartbeatCountdown.tsx.
  // Ticks every second; colors/labels shift as the next heartbeat approaches.
  // `full` = profile page layout, `compact` = sidebar/panel preview.
  import { cn } from "$lib/utils.js";

  let {
    lastHeartbeatAt,
    heartbeatIntervalSeconds,
    variant = "full",
  }: {
    lastHeartbeatAt: string | null;
    heartbeatIntervalSeconds: number;
    variant?: "full" | "compact";
  } = $props();

  type State = "normal" | "soon" | "imminent" | "overdue" | "received";

  let now: number = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  // "Just received" flash — fires for 2s whenever lastHeartbeatAt advances.
  // Start null (not seeded from the reactive prop — state_referenced_locally,
  // #178); the `prevHeartbeat !== null` guard below still suppresses a flash on
  // the first observed heartbeat.
  let prevHeartbeat: string | null = null;
  let justReceived: boolean = $state(false);
  $effect(() => {
    if (lastHeartbeatAt && lastHeartbeatAt !== prevHeartbeat) {
      if (prevHeartbeat !== null) {
        justReceived = true;
        const t = setTimeout(() => (justReceived = false), 2000);
        prevHeartbeat = lastHeartbeatAt;
        return () => clearTimeout(t);
      }
      prevHeartbeat = lastHeartbeatAt;
    }
  });

  function deriveState(remainingMs: number): State {
    if (remainingMs < 0) return "overdue";
    if (remainingMs < 10_000) return "imminent";
    if (remainingMs < 60_000) return "soon";
    return "normal";
  }

  function formatCountdown(ms: number): string {
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatOverdue(ms: number): string {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `0:${secs.toString().padStart(2, "0")}`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const TONE: Record<State, { text: string; dot: string; glow: string }> = {
    normal: { text: "text-content-dim", dot: "bg-online", glow: "" },
    soon: { text: "text-[#818cf8]", dot: "bg-[#818cf8]", glow: "" },
    imminent: { text: "text-warning", dot: "bg-warning", glow: "shadow-[0_0_8px_color-mix(in_srgb,var(--warning)_55%,transparent)]" },
    overdue: { text: "text-error", dot: "bg-error", glow: "" },
    received: { text: "text-online", dot: "bg-online", glow: "" },
  };
  const PULSE_MS: Record<State, number> = {
    normal: 2000,
    soon: 1400,
    imminent: 800,
    overdue: 0,
    received: 2000,
  };

  const lastMs: number = $derived(lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : 0);
  const remainingMs: number = $derived(lastMs + heartbeatIntervalSeconds * 1000 - now);
  const hbState: State = $derived(justReceived ? "received" : deriveState(remainingMs));
  const tone = $derived(TONE[hbState]);
  const pulseMs: number = $derived(PULSE_MS[hbState]);
  const dotSize: number = $derived(variant === "compact" ? 8 : 10);

  const label: string = $derived.by(() => {
    if (hbState === "received") return "✓ Heartbeat received";
    if (hbState === "overdue") return `Heartbeat overdue — ${formatOverdue(-remainingMs)} ago`;
    return variant === "compact"
      ? `Next in ${formatCountdown(remainingMs)}`
      : `Next heartbeat in: ${formatCountdown(remainingMs)}`;
  });
</script>

{#if lastHeartbeatAt}
  {#if variant === "compact"}
    <div class="flex items-center gap-2">
      <span
        class={cn("inline-block shrink-0 rounded-full", tone.dot, tone.glow)}
        style="width: {dotSize}px; height: {dotSize}px; {pulseMs > 0 ? `animation: heartbeat-pulse ${pulseMs}ms ease-in-out infinite;` : ''}"
      ></span>
      <span class={cn("text-[11px] tabular-nums", tone.text)}>{label}</span>
    </div>
  {:else}
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span
          class={cn("inline-block shrink-0 rounded-full", tone.dot, tone.glow)}
          style="width: {dotSize}px; height: {dotSize}px; {pulseMs > 0 ? `animation: heartbeat-pulse ${pulseMs}ms ease-in-out infinite;` : ''}"
        ></span>
        <span class={cn("text-[13px]", tone.text)}>
          {hbState === "received" || hbState === "overdue" ? label : "Next heartbeat in:"}
        </span>
      </div>
      {#if hbState !== "received" && hbState !== "overdue"}
        <span class={cn("text-[13px] font-medium tabular-nums", tone.text)}>{formatCountdown(remainingMs)}</span>
      {/if}
    </div>
  {/if}
{/if}

<style>
  @keyframes heartbeat-pulse {
    0%, 100% { transform: scale(1); opacity: 0.85; }
    50% { transform: scale(1.25); opacity: 1; }
  }
</style>
