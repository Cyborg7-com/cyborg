<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import type { WithElementRef } from "$lib/utils.js";
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    value = $bindable(),
    class: className,
    ...restProps
  }: WithElementRef<HTMLInputAttributes> = $props();
</script>

<input
  bind:this={ref}
  bind:value
  data-slot="input"
  class={cn(
    "flex h-9 w-full min-w-0 rounded-md border border-edge bg-surface px-3 py-1 text-sm text-content shadow-xs transition-shadow outline-none placeholder:text-content-muted focus:border-edge-light focus:ring-[3px] focus:ring-edge/30 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...restProps}
/>
