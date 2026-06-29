<script lang="ts">
  import { cn } from "$lib/utils.js";

  let { status }: { status: "available" | "not-installed" | "error" | "loading" } = $props();

  const config = $derived.by(() => {
    if (status === "available")
      return { dot: "bg-online", text: "Detected", pill: "bg-online/15 text-online" };
    if (status === "error")
      return { dot: "bg-error", text: "Error", pill: "bg-error/15 text-error" };
    if (status === "loading")
      return { dot: "bg-warning animate-pulse", text: "Loading...", pill: "bg-warning/15 text-warning" };
    return { dot: "bg-content-muted", text: "Not Installed", pill: "bg-content-muted/15 text-content-muted" };
  });
</script>

<span class={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium", config.pill)}>
  <span class={cn("h-1.5 w-1.5 rounded-full shrink-0", config.dot)}></span>
  {config.text}
</span>
