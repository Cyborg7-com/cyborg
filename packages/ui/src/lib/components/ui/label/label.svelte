<script lang="ts">
  import type { HTMLLabelAttributes } from "svelte/elements";
  import type { WithElementRef } from "$lib/utils.js";
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLLabelAttributes> = $props();
</script>

<label
  bind:this={ref}
  data-slot="label"
  class={cn(
    "flex items-center gap-2 text-sm font-medium text-content leading-none select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</label>
