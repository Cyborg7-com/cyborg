<script lang="ts">
  // Structured diff model + pure parser/LCS/split-row builder live in
  // $lib/diff-parser.ts (extracted #511). This component keeps only state
  // (collapsed/view toggle) + rendering.
  import {
    additionsOnly,
    basename,
    buildSplitRows,
    diffStrings,
    parseUnifiedDiff,
    type DiffFile,
  } from "$lib/diff-parser.js";

  let {
    unifiedDiff,
    oldString,
    newString,
    content,
    filePath,
    defaultView = "unified",
  }: {
    unifiedDiff?: string;
    oldString?: string;
    newString?: string;
    content?: string;
    filePath?: string;
    defaultView?: "unified" | "split";
  } = $props();

  const fallbackPath = $derived(filePath ?? "file");

  const files = $derived.by<DiffFile[]>(() => {
    if (unifiedDiff && unifiedDiff.trim().length > 0) {
      const parsed = parseUnifiedDiff(unifiedDiff, fallbackPath);
      if (parsed.length > 0) return parsed;
    }
    if (oldString != null || newString != null) {
      return [diffStrings(oldString ?? "", newString ?? "", fallbackPath)];
    }
    if (content != null) {
      return [additionsOnly(content, fallbackPath)];
    }
    return [];
  });

  // Initialize to a literal, then sync from the prop via an effect (don't read
  // the reactive prop in the $state initializer — state_referenced_locally, #178).
  // The effect re-runs only when defaultView changes, so user toggles persist.
  let view = $state<"unified" | "split">("unified");
  $effect(() => {
    view = defaultView;
  });

  // Per-file collapse override. When unset, a file with no changes starts
  // collapsed; everything else starts expanded.
  let collapsedOverride = $state<Record<number, boolean>>({});

  function isCollapsed(index: number, file: DiffFile): boolean {
    const override = collapsedOverride[index];
    if (override !== undefined) return override;
    return file.additions === 0 && file.deletions === 0;
  }

  function toggle(index: number, file: DiffFile) {
    collapsedOverride[index] = !isCollapsed(index, file);
  }
</script>

{#if files.length > 0}
  <div class="diffview">
    <div class="diffview__toolbar">
      <div class="diffview__viewtoggle" role="group" aria-label="Diff view mode">
        <button
          type="button"
          class="diffview__viewbtn"
          class:diffview__viewbtn--active={view === "unified"}
          aria-pressed={view === "unified"}
          onclick={() => (view = "unified")}
        >
          Unified
        </button>
        <button
          type="button"
          class="diffview__viewbtn"
          class:diffview__viewbtn--active={view === "split"}
          aria-pressed={view === "split"}
          onclick={() => (view = "split")}
        >
          Split
        </button>
      </div>
    </div>

    {#each files as file, fi (file.path + "::" + fi)}
      {@const collapsed = isCollapsed(fi, file)}
      <div class="diffview__file">
        <button
          type="button"
          class="diffview__filehead"
          aria-expanded={!collapsed}
          onclick={() => toggle(fi, file)}
        >
          <svg
            class="diffview__chevron"
            class:diffview__chevron--open={!collapsed}
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span class="diffview__filepath" title={file.path}>{basename(file.path)}</span>
          <span class="diffview__stat">
            {#if file.additions > 0}<span class="diffview__stat-add">+{file.additions}</span>{/if}
            {#if file.deletions > 0}<span class="diffview__stat-del">−{file.deletions}</span>{/if}
            {#if file.additions === 0 && file.deletions === 0}<span class="diffview__stat-none">no changes</span>{/if}
          </span>
        </button>

        {#if !collapsed}
          <div class="diffview__body">
            {#if view === "unified"}
              {#each file.lines as line, li (li)}
                {#if line.kind === "header"}
                  <div class="diffview__row diffview__row--header">
                    <span class="diffview__gutter"></span>
                    <span class="diffview__gutter"></span>
                    <span class="diffview__code">{line.text}</span>
                  </div>
                {:else}
                  <div class="diffview__row diffview__row--{line.kind}">
                    <span class="diffview__gutter">{line.oldNo ?? ""}</span>
                    <span class="diffview__gutter">{line.newNo ?? ""}</span>
                    <span class="diffview__sign"
                      >{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span
                    >
                    <span class="diffview__code">{line.text}</span>
                  </div>
                {/if}
              {/each}
            {:else}
              {#each buildSplitRows(file) as row, ri (ri)}
                {#if row.header !== undefined}
                  <div class="diffview__srow diffview__row--header">
                    <span class="diffview__scode diffview__scode--full">{row.header}</span>
                  </div>
                {:else}
                  <div class="diffview__srow">
                    <span class="diffview__gutter">{row.left?.oldNo ?? ""}</span>
                    <span
                      class="diffview__scode"
                      class:diffview__scode--remove={row.left?.kind === "remove"}
                      >{row.left ? row.left.text : ""}</span
                    >
                    <span class="diffview__gutter">{row.right?.newNo ?? ""}</span>
                    <span
                      class="diffview__scode"
                      class:diffview__scode--add={row.right?.kind === "add"}
                      >{row.right ? row.right.text : ""}</span
                    >
                  </div>
                {/if}
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .diffview {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg-surface);
    font-family: ui-monospace, "SF Mono", Monaco, monospace;
    font-size: 11px;
    line-height: 1.55;
  }

  .diffview__toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .diffview__viewtoggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }

  .diffview__viewbtn {
    padding: 2px 8px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .diffview__viewbtn:hover {
    color: var(--text-secondary);
  }

  .diffview__viewbtn--active {
    color: var(--btn-primary-text, #fff);
    background: var(--btn-primary-bg);
  }

  .diffview__file:not(:last-child) {
    border-bottom: 1px solid var(--border-subtle);
  }

  .diffview__filehead {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--text-secondary);
  }

  .diffview__filehead:hover {
    background: var(--hover-gray, var(--border-subtle));
  }

  .diffview__chevron {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform 0.12s ease;
  }

  .diffview__chevron--open {
    transform: rotate(90deg);
  }

  .diffview__filepath {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diffview__stat {
    margin-left: auto;
    display: inline-flex;
    gap: 6px;
    font-size: 10px;
    font-weight: 700;
  }

  .diffview__stat-add {
    color: var(--color-online);
  }

  .diffview__stat-del {
    color: var(--color-error);
  }

  .diffview__stat-none {
    color: var(--text-muted);
    font-weight: 500;
  }

  .diffview__body {
    max-height: 26rem;
    overflow: auto;
  }

  .diffview__row {
    display: grid;
    grid-template-columns: 2.6em 2.6em 1.1em minmax(0, 1fr);
    white-space: pre;
  }

  .diffview__srow {
    display: grid;
    grid-template-columns: 2.6em minmax(0, 1fr) 2.6em minmax(0, 1fr);
    white-space: pre;
  }

  .diffview__gutter {
    padding: 0 6px;
    text-align: right;
    color: var(--text-muted);
    background: var(--border-subtle);
    user-select: none;
    -webkit-user-select: none;
  }

  .diffview__sign {
    text-align: center;
    color: var(--text-muted);
    user-select: none;
    -webkit-user-select: none;
  }

  .diffview__code,
  .diffview__scode {
    padding: 0 8px;
    color: var(--text-primary);
    overflow-x: auto;
  }

  .diffview__row--add {
    background: color-mix(in srgb, var(--color-online) 13%, transparent);
  }

  .diffview__row--add .diffview__sign {
    color: var(--color-online);
  }

  .diffview__row--remove {
    background: color-mix(in srgb, var(--color-error) 13%, transparent);
  }

  .diffview__row--remove .diffview__sign {
    color: var(--color-error);
  }

  .diffview__row--header,
  .diffview__row--header .diffview__code,
  .diffview__scode--full {
    color: var(--text-muted);
    background: var(--border-subtle);
  }

  .diffview__scode--add {
    background: color-mix(in srgb, var(--color-online) 13%, transparent);
  }

  .diffview__scode--remove {
    background: color-mix(in srgb, var(--color-error) 13%, transparent);
  }

  .diffview__scode--full {
    grid-column: 1 / -1;
    padding: 0 8px;
  }
</style>
