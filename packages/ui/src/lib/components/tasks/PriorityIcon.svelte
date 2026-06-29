<script lang="ts">
  // Priority glyph for the Tasks surfaces — a 1:1 port of Plane's PriorityIcon
  // (plane/packages/propel/src/icons/priority-icon.tsx, withContainer=false: the
  // bare glyph, the bordered box is added by the call site via workPriorityBox).
  // Plane maps each priority to a lucide-react glyph; we render the IDENTICAL
  // @lucide/svelte glyph so the shapes match pixel-for-pixel:
  //   urgent → AlertCircle  (circle + bang)
  //   high   → SignalHigh   (3 stroked bars, ascending)
  //   medium → SignalMedium (2 stroked bars)
  //   low    → SignalLow    (1 stroked bar)
  //   none   → Ban          (no-entry circle)
  // The glyph is tinted with the matching --priority-* token (constants.ts
  // PRIORITY_META.token), never a raw color literal — the token resolves
  // per-theme in app.css and the lucide stroke draws in `currentColor`, so we set
  // `color` off the token on the wrapper.
  //
  // The lucide Signal glyphs are LEFT-anchored bar charts (absent bars are simply
  // not drawn), so Plane optically re-centers them inside the box with a small
  // per-priority translate (priority-icon.tsx:56-62): high +1px, medium +2px,
  // low +4px. urgent/none are symmetric and get no nudge. We reproduce that here.
  import { cn } from "$lib/utils.js";
  import { PRIORITIES } from "$lib/tasks/constants.js";
  import type { Priority } from "$lib/tasks/priority.js";
  import AlertCircleIcon from "@lucide/svelte/icons/alert-circle";
  import SignalHighIcon from "@lucide/svelte/icons/signal-high";
  import SignalMediumIcon from "@lucide/svelte/icons/signal-medium";
  import SignalLowIcon from "@lucide/svelte/icons/signal-low";
  import BanIcon from "@lucide/svelte/icons/ban";

  let {
    priority,
    size = 16,
    class: className = "",
  }: { priority: Priority; size?: number; class?: string } = $props();

  const meta = $derived(PRIORITIES.find((p) => p.key === priority) ?? PRIORITIES[PRIORITIES.length - 1]);

  // Plane's lucide glyph per priority (priority-icon.tsx:33-40).
  const ICONS = {
    "alert-circle": AlertCircleIcon,
    "signal-high": SignalHighIcon,
    "signal-medium": SignalMediumIcon,
    "signal-low": SignalLowIcon,
    ban: BanIcon,
  } as const;
  const Icon = $derived(ICONS[meta.iconKey]);

  // Plane's optical-centering nudge for the lopsided Signal bars
  // (priority-icon.tsx:56-62). Full class strings so Tailwind keeps the utilities.
  const NUDGE: Record<Priority, string> = {
    urgent: "",
    high: "translate-x-[0.0625rem]",
    medium: "translate-x-0.5",
    low: "translate-x-1",
    none: "",
  };
</script>

<span
  class={cn("inline-flex shrink-0", className)}
  style={`color:var(${meta.token})`}
  role="img"
  aria-label={meta.label}
  title={meta.label}
>
  <Icon {size} class={cn("shrink-0", NUDGE[priority])} />
</span>
