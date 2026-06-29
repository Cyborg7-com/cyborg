<script lang="ts">
  // ─── Keyboard shortcuts help (Cmd/Ctrl-/) ─────────────────────────
  // A reference modal listing the app's keyboard shortcuts, grouped by category.
  // Opened by a global Cmd/Ctrl-/ and closed with Esc or the close button.
  // Mounted once in the workspace shell. Additive: it only reads the static
  // SHORTCUT_GROUPS registry and renders glyphs via formatShortcut().
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { SHORTCUT_GROUPS } from "./keyboard-shortcuts.js";
  import { formatShortcut } from "$lib/utils.js";

  let open = $state(false);

  // Global Cmd/Ctrl-/ toggles the modal. "/" lives on the same physical key as
  // "?" — matching on e.key === "/" covers both shifted and unshifted layouts
  // without conflicting with the browser's own find. Ignore Alt to avoid clobbering
  // other combos.
  function onGlobalKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "/") {
      e.preventDefault();
      open = !open;
    }
  }

  // Split the modifier glyphs from the final key so we can render each piece as
  // its own <kbd>. formatShortcut yields e.g. "⌘K" (mac, no separator) or
  // "Ctrl+K" (non-mac, "+"-separated).
  function renderKeys(combo: string): string[] {
    const formatted = formatShortcut(combo);
    if (formatted.includes("+")) return formatted.split("+");
    // macOS glyphs run together (⇧⌥↑); split into single display tokens.
    return Array.from(formatted);
  }
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<Dialog bind:open>
  <DialogContent class="sm:max-w-[520px] p-0 gap-0" showCloseButton={true}>
    <DialogHeader class="px-5 py-4 border-b border-edge">
      <DialogTitle class="text-lg font-semibold text-white">Keyboard shortcuts</DialogTitle>
    </DialogHeader>

    <ScrollArea class="max-h-[60vh]">
      <div class="px-5 py-4 flex flex-col gap-5">
        {#each SHORTCUT_GROUPS as group (group.category)}
          <div>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
              {group.category}
            </p>
            <div class="flex flex-col gap-1.5">
              {#each group.shortcuts as shortcut (shortcut.combo)}
                <div class="flex items-center justify-between gap-4">
                  <span class="text-[14px] text-content">{shortcut.description}</span>
                  <span class="flex shrink-0 items-center gap-1">
                    {#each renderKeys(shortcut.combo) as key (key)}
                      <kbd class="inline-flex min-w-[22px] items-center justify-center rounded border border-edge-dim bg-surface-alt px-1.5 py-0.5 text-[12px] font-medium text-content-dim">
                        {key}
                      </kbd>
                    {/each}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </ScrollArea>
  </DialogContent>
</Dialog>
