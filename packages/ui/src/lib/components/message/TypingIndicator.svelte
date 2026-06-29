<script lang="ts">
  import { cn } from "$lib/utils.js";

  let {
    names = [],
    verb = "typing",
    size = "md",
    text = undefined,
    class: className = "",
  }: {
    names?: string[];
    verb?: "typing" | "thinking";
    size?: "sm" | "md";
    // Full phrase override (without trailing ellipsis) — used for non-typing
    // indicators that reuse this dot animation, e.g. slash-command progress.
    text?: string;
    class?: string;
  } = $props();

  const computed = $derived.by(() => {
    if (names.length === 0) return "";
    if (names.length === 1) return `${names[0]} is ${verb}`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are ${verb}`;
    return `Several people are ${verb}`;
  });
  const label = $derived(text ?? computed);

  const dotSize = $derived(size === "sm" ? "w-[4px] h-[4px]" : "w-[5px] h-[5px]");
</script>

{#if names.length > 0 || text}
  <div
    class={cn(
      "flex items-center gap-2 select-none",
      size === "sm" ? "text-[11px] text-content-dim" : "px-5 py-1.5 text-[13px] text-content-dim",
      className,
    )}
  >
    <span class="flex items-center gap-[3px]">
      <span
        class={cn("bg-content-dim rounded-full animate-typing-dot", dotSize)}
        style="--dot-delay: 0ms;"
      ></span>
      <span
        class={cn("bg-content-dim rounded-full animate-typing-dot", dotSize)}
        style="--dot-delay: 200ms;"
      ></span>
      <span
        class={cn("bg-content-dim rounded-full animate-typing-dot", dotSize)}
        style="--dot-delay: 400ms;"
      ></span>
    </span>
    <span>{label}...</span>
  </div>
{/if}
