<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import type { WithElementRef } from "$lib/utils.js";
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    value = $bindable(),
    class: className,
    ...restProps
  }: WithElementRef<HTMLTextareaAttributes> = $props();
</script>

<textarea
  bind:this={ref}
  bind:value
  data-slot="textarea"
  class={cn(
    "flex min-h-16 w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content shadow-xs transition-shadow outline-none placeholder:text-content-muted focus:border-edge-light focus:ring-[3px] focus:ring-edge/30 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  {...restProps}
></textarea>
