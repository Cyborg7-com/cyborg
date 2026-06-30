<script lang="ts">
  // FROZEN picker sheet (WS0). Cycles & Modules are ASSIGNABLE PROPERTIES (not
  // browse sections — LOCKED DECISION), so they share one sheet wrapping the
  // CycleSelect (single) + ModuleSelect (multi) leaves (variant="inline" — the
  // option lists render directly, no trigger/popover). Cycle is single-select:
  // one tap picks + closes. Modules are multi-select: each tap toggles and the
  // sheet stays open; the host dismisses it.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import CycleSelect from "$lib/components/tasks/CycleSelect.svelte";
  import ModuleSelect from "$lib/components/tasks/ModuleSelect.svelte";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import type { Cycle, Module } from "$lib/core/types.js";

  let {
    open = $bindable(false),
    cycleValue = null,
    cycleOptions = [],
    moduleValue = [],
    moduleOptions = [],
    onCycleChange,
    onModulesChange,
    onclose,
    title = "Cycle & Modules",
  }: {
    open?: boolean;
    cycleValue?: string | null;
    cycleOptions?: Cycle[];
    moduleValue?: string[];
    moduleOptions?: Module[];
    onCycleChange: (next: string | null) => void;
    onModulesChange: (next: string[]) => void;
    onclose?: () => void;
    title?: string;
  } = $props();

  // Cycle is single-select: persist then close (one tap). Modules stay open.
  function pickCycle(next: string | null): void {
    onCycleChange(next);
    open = false;
    onclose?.();
  }
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Set cycle and modules">
  <div class="flex flex-col gap-4 pb-2">
    <div class="flex flex-col gap-1.5">
      <span class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-content-muted">
        <RefreshCwIcon class="size-3.5" /> Cycle
      </span>
      <CycleSelect
        value={cycleValue}
        options={cycleOptions}
        variant="inline"
        onChange={pickCycle}
        class="w-full"
      />
    </div>
    <div class="flex flex-col gap-1.5">
      <span class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-content-muted">
        <LayersIcon class="size-3.5" /> Modules
      </span>
      <ModuleSelect
        value={moduleValue}
        options={moduleOptions}
        variant="inline"
        onChange={onModulesChange}
        class="w-full"
      />
    </div>
  </div>
</MobileSheet>
