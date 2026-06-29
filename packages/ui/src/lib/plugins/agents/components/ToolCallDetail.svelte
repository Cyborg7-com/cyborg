<script lang="ts">
  import type { ToolCallDetail } from "$lib/types.js";
  import DiffView from "$lib/components/message/DiffView.svelte";
  import AnsiOutput from "./AnsiOutput.svelte";
  import FilePathLink from "./FilePathLink.svelte";

  let { detail, error }: { detail: ToolCallDetail; error?: unknown } = $props();

  // A read can carry an offset (1-based line) and optional limit, which is the
  // line range it actually read — surface it on the path so the copied location
  // points at the read window (mirrors Paseo opening the file at the range).
  function readPathWithRange(d: Extract<ToolCallDetail, { type: "read" }>): string {
    if (d.offset == null) return d.filePath;
    const start = d.offset;
    const end = d.limit != null ? d.offset + d.limit - 1 : undefined;
    return end != null && end !== start ? `${d.filePath}:${start}-${end}` : `${d.filePath}:${start}`;
  }
</script>

{#if detail.type === "shell"}
  <div class="space-y-1">
    <div class="flex items-center gap-2 text-xs">
      <span class="text-content-muted">$</span>
      <code class="text-content text-xs">{detail.command}</code>
      {#if detail.exitCode != null && detail.exitCode !== 0}
        <span class="text-error text-[10px]">exit {detail.exitCode}</span>
      {/if}
    </div>
    {#if detail.output}
      <AnsiOutput text={detail.output} />
    {/if}
  </div>

{:else if detail.type === "read"}
  <div class="space-y-1">
    <FilePathLink path={readPathWithRange(detail)} class="text-xs" />
    {#if detail.content}
      <AnsiOutput text={detail.content} />
    {/if}
  </div>

{:else if detail.type === "edit"}
  <div class="space-y-1">
    <FilePathLink path={detail.filePath} class="text-xs" />
    {#if detail.unifiedDiff || detail.oldString != null || detail.newString != null}
      <DiffView
        unifiedDiff={detail.unifiedDiff}
        oldString={detail.oldString}
        newString={detail.newString}
        filePath={detail.filePath}
      />
    {/if}
  </div>

{:else if detail.type === "write"}
  <div class="space-y-1">
    <FilePathLink path={detail.filePath} class="text-xs" />
    {#if detail.content}
      <DiffView content={detail.content} filePath={detail.filePath} />
    {/if}
  </div>

{:else if detail.type === "search"}
  <div class="space-y-1">
    <div class="text-xs text-content-muted">
      {detail.toolName ?? "search"}: {detail.query}
      {#if detail.numMatches != null}
        <span class="ml-1">({detail.numMatches} matches)</span>
      {/if}
    </div>
    {#if detail.filePaths && detail.filePaths.length > 0}
      <div class="text-[11px] max-h-32 overflow-y-auto">
        {#each detail.filePaths.slice(0, 20) as fp (fp)}
          <div><FilePathLink path={fp} class="text-[11px]" /></div>
        {/each}
        {#if detail.filePaths.length > 20}
          <div class="text-content-muted">...and {detail.filePaths.length - 20} more</div>
        {/if}
      </div>
    {/if}
    {#if detail.content}
      <AnsiOutput text={detail.content} />
    {/if}
  </div>

{:else if detail.type === "fetch"}
  <div class="space-y-1">
    <div class="text-xs text-content-muted">
      {detail.url}
      {#if detail.code}
        <span class="ml-1">({detail.code})</span>
      {/if}
    </div>
    {#if detail.result}
      <AnsiOutput text={detail.result} />
    {/if}
  </div>

{:else if detail.type === "sub_agent"}
  <div class="space-y-1">
    {#if detail.description}
      <div class="text-xs text-content-muted">{detail.description}</div>
    {/if}
    {#if detail.log}
      <AnsiOutput text={detail.log} />
    {/if}
  </div>

{:else if detail.type === "plain_text"}
  <div class="text-xs text-content-dim">
    {#if detail.label}<span class="text-content-muted">{detail.label}: </span>{/if}
    {detail.text ?? ""}
  </div>

{:else if detail.type === "plan"}
  <AnsiOutput text={detail.text} />

{:else}
  <div class="text-xs text-content-dim">Tool call completed</div>
{/if}

{#if error}
  <div class="mt-1 text-xs text-error">
    Error: {typeof error === "string" ? error : JSON.stringify(error)}
  </div>
{/if}
