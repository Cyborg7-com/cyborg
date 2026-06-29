<script lang="ts">
  // A tool call's target file path as an OPENABLE affordance (issue #614). In
  // Paseo this opens the file in a pane with its line range; Cyborg7 has no IDE
  // pane (cloud-relay client, no browser-side file-read), so the minimum-viable
  // "open" is copy-path — the path (with its `:line` range) goes to the
  // clipboard so it can be pasted into a terminal/editor. read/edit/write
  // details already show the content/diff inline below this, so the link's job
  // is to make the path itself selectable, copyable, and visually a link.
  import { toast } from "svelte-sonner";
  import { cn } from "$lib/utils.js";
  import {
    parseFilePathToken,
    formatFileLocation,
    type ParsedFilePath,
  } from "../tool-call-file-path.js";

  let {
    // The raw path token from the tool detail (may carry a `:line` suffix).
    path,
    class: className = "",
  }: { path: string; class?: string } = $props();

  // Parsed once per path. When the token doesn't look like a path we render it
  // as plain text (the fallback), so a non-path string never becomes a link.
  const parsed = $derived<ParsedFilePath | null>(parseFilePathToken(path));
  // Canonical copy string (path + line range), so the range travels on paste.
  const location = $derived(parsed ? formatFileLocation(parsed) : path);

  async function copyPath() {
    // In a non-secure (HTTP) context or older browser `navigator.clipboard`
    // may be undefined, so reading `.writeText` off it would throw a
    // TypeError. Guard first and fail gracefully instead of pretending success.
    if (!navigator.clipboard?.writeText) {
      toast.error("Couldn't copy path");
      return;
    }
    try {
      await navigator.clipboard.writeText(location);
      toast.success("Path copied");
    } catch {
      // A denied/unavailable clipboard write shouldn't look like success.
      toast.error("Couldn't copy path");
    }
  }
</script>

{#if parsed}
  <button
    type="button"
    onclick={copyPath}
    title="Copy path"
    class={cn(
      "max-w-full truncate text-left font-mono text-accent hover:underline focus-visible:underline focus-visible:outline-none",
      className,
    )}
  >{location}</button>
{:else}
  <span class={cn("font-mono", className)}>{path}</span>
{/if}
