<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    label,
    icon,
    active = false,
    badge = 0,
    onclick,
  }: {
    label: string;
    icon: string;
    active?: boolean;
    badge?: number;
    onclick?: () => void;
  } = $props();
</script>

<button
  type="button"
  {onclick}
  class="pressable-scale w-full group py-2 cursor-pointer flex flex-col gap-1 text-center text-[11px] leading-3 font-bold items-center justify-center focus-ring touch-target-row"
  title={label}
  aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
  aria-current={active ? "page" : undefined}
>
  <div
    class={cn(
      "relative w-9 h-9 flex items-center justify-center transition-[background] duration-[125ms] ease-[cubic-bezier(.17,.67,.55,1.09)] group-hover:bg-[var(--rail-hover)] rounded-lg",
      active ? "bg-[var(--rail-hover)]" : "bg-transparent",
    )}
  >
    <!-- Icon is decorative — the button already has an accessible name via
         aria-label/visible label, so hide the raw SVG from the a11y tree. -->
    <div class="h-5 w-5 transition-transform group-hover:scale-[1.2] [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
      {@html icon}
    </div>
    {#if badge > 0}
      <span class="absolute -top-1 -right-1 min-w-4 h-4 flex items-center justify-center rounded-full bg-error text-accent-foreground text-[10px] font-bold px-1 pointer-events-none" aria-hidden="true">
        {badge > 99 ? "99+" : badge}
      </span>
    {/if}
  </div>
  <div style="color: var(--rail-label);">{label}</div>
</button>
