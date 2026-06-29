<script lang="ts">
  // The ONE shared property chip row for a work item, used by BOTH the board card
  // AND the detail panel. Given a task's plain field VALUES + a display map, it
  // renders — each chip gated by the map — in Plane's all-properties.tsx order:
  // the state pill, the priority icon, the due chip, the assignee avatar stack,
  // the module + cycle chips, the sub-item / attachment / link counts, and finally
  // the label color dots. It takes plain value props (NO full Task type, which is
  // mid-flight in P1b) so it can render the same way no matter which surface or
  // data source feeds it.
  //
  // Two modes:
  //   - read-only (default): a compact, non-interactive chip strip. This is what
  //     the board card and a peek summary line use.
  //   - editable (`editable` + the relevant `on*` handlers): each property becomes
  //     its A/B-batch editor (State/Priority/DateRange/Assignee/Label/Cycle/Module)
  //     so the SAME row drives the detail panel's inline edits. An editor only
  //     renders when its handler is supplied AND its options/pools are present;
  //     otherwise that property falls back to its read-only chip.
  //
  // Variant:
  //   - "chip": the board-card strip — a wrapping, muted row of small chips.
  //   - "row":  a property row inside the detail panel — slightly larger glyphs,
  //     left-aligned, no wrap pressure.
  //
  // Token-only throughout: state via StateGroupIcon, priority via PriorityIcon,
  // due via the ui.ts dueChip + due.ts dueChipClass, labels via the --label-*
  // palette dots, assignees via AssigneeAvatar, counts via the shared count chip.
  // Zero raw color literals.
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import StateDropdown, { type TaskState } from "$lib/components/tasks/StateDropdown.svelte";
  import PriorityDropdown from "$lib/components/tasks/PriorityDropdown.svelte";
  import AssigneeDropdown from "$lib/components/tasks/AssigneeDropdown.svelte";
  import DateRangeDropdown, { type DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
  import LabelDropdown, { type TaskLabel } from "$lib/components/tasks/LabelDropdown.svelte";
  import CycleSelect, { type TaskCycle } from "$lib/components/tasks/CycleSelect.svelte";
  import ModuleSelect, { type TaskModule } from "$lib/components/tasks/ModuleSelect.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { formatDue, dueChipClass } from "$lib/tasks/due.js";
  import { cronToLabel } from "$lib/schedule/recurrence.js";
  import type { Priority } from "$lib/tasks/priority.js";
  import {
    cardPropsRow,
    dueChip,
    workChipPill,
    workPriorityBox,
    workCountChip,
    workLabelChip,
    workLabelDot,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // Which properties this row shows. Each key defaults to ON when absent (Plane
  // shows every property by default; the user opts OUT), matching view.ts
  // isDisplayed semantics. A SUPERSET of view.ts DisplayKey on purpose: this row
  // also gates labels / cycle / module / sub-items / links / attachments, which
  // the toolbar's narrower toggle set does not — so we take a local optional-bool
  // map instead of widening the toolbar union.
  export interface DisplayMap {
    status?: boolean;
    priority?: boolean;
    assignee?: boolean;
    dueAt?: boolean;
    scheduled?: boolean;
    labels?: boolean;
    cycle?: boolean;
    module?: boolean;
    subItemCount?: boolean;
    linkCount?: boolean;
    attachmentCount?: boolean;
  }

  let {
    // ── values (plain; NO full Task type) ────────────────────────────────────
    stateId = null,
    priority = "none",
    assigneeId = null,
    startDate = null,
    dueAt = null,
    schedule = null,
    labelIds = [],
    cycleId = null,
    moduleIds = [],
    subItemCount = 0,
    linkCount = 0,
    attachmentCount = 0,
    isDone = false,
    // ── option / display maps (so chips resolve names + colors) ───────────────
    states = [],
    labels = [],
    cycles = [],
    modules = [],
    pools,
    display = {},
    // ── layout ────────────────────────────────────────────────────────────────
    variant = "chip",
    class: className,
    // ── editing (opt-in; an editor renders only with its handler) ─────────────
    editable = false,
    onStateChange,
    onPriorityChange,
    onAssigneeChange,
    onDatesChange,
    onLabelsChange,
    onLabelCreate,
    onCycleChange,
    onModulesChange,
    onScheduleClick,
  }: {
    stateId?: string | null;
    priority?: Priority;
    assigneeId?: string | null;
    startDate?: string | null;
    dueAt?: string | null;
    // READ-ONLY per-task schedule summary (denormalized onto the wire Task). The
    // chip shows its cadence (cronToLabel) and greys/strikes through when disabled.
    // Editing happens elsewhere (the schedule dialog), opened via onScheduleClick.
    schedule?: {
      cronExpr: string;
      timezone: string | null;
      enabled: boolean;
      nextRunAt: number | null;
    } | null;
    labelIds?: string[];
    cycleId?: string | null;
    moduleIds?: string[];
    subItemCount?: number;
    linkCount?: number;
    attachmentCount?: number;
    // When true, the due chip never shows overdue-red (a finished task can't be
    // late). Mirrors DateRangeDropdown's "parent suppresses overdue" contract.
    isDone?: boolean;
    states?: TaskState[];
    labels?: TaskLabel[];
    cycles?: TaskCycle[];
    modules?: TaskModule[];
    // Required for the assignee chip/editor to resolve a face + name.
    pools?: AssigneePools;
    display?: DisplayMap;
    variant?: "chip" | "row";
    class?: string;
    editable?: boolean;
    onStateChange?: (id: string) => void;
    onPriorityChange?: (p: Priority) => void;
    onAssigneeChange?: (id: string | null) => void;
    onDatesChange?: (range: DateRange) => void;
    onLabelsChange?: (ids: string[]) => void;
    onLabelCreate?: (name: string) => void;
    onCycleChange?: (id: string | null) => void;
    onModulesChange?: (ids: string[]) => void;
    // Opens the per-task schedule editor when the cadence chip is clicked. Absent =
    // a plain, non-interactive chip (e.g. the read-only board card).
    onScheduleClick?: () => void;
  } = $props();

  // A display key is ON unless explicitly set false (default-on, like view.ts).
  function shown(key: keyof DisplayMap): boolean {
    return display[key] !== false;
  }

  // ── resolved values for the read-only chips ────────────────────────────────
  const state = $derived(states.find((s) => s.id === stateId) ?? null);
  const assignee = $derived(pools ? resolveAssignee(assigneeId, pools) : null);
  const pickedLabels = $derived(labels.filter((l) => labelIds.includes(l.id)));

  // Due is carried as an ISO string here (the P1b/editor date shape); the due.ts
  // helpers speak ms-epoch, so convert at this boundary. A done task suppresses
  // the overdue tint by formatting against its own due (never < now visually):
  // we pass a class override instead of mutating the timestamp.
  const dueMs = $derived.by(() => {
    if (!dueAt) return null;
    const t = new Date(dueAt).getTime();
    return Number.isNaN(t) ? null : t;
  });
  const dueLabel = $derived(dueMs == null ? "" : formatDue(dueMs));
  // For a done task keep the chip quiet (no red/amber) — it's informational only.
  const dueClass = $derived(
    dueMs == null ? "" : isDone ? "bg-surface-alt text-content-muted" : dueChipClass(dueMs),
  );

  // The per-task schedule chip's cadence text ("Every day 9:00"), derived from the
  // read-only summary's cron + timezone. Empty when no schedule is bound.
  const scheduleLabel = $derived(
    schedule ? cronToLabel(schedule.cronExpr, schedule.timezone) : "",
  );

  const iconSize = $derived(variant === "row" ? 16 : 14);

  // Label palette resolver (matches LabelDropdown): degrade an unknown color to
  // the neutral "grey" dot fill rather than emitting a missing class.
  const PALETTE = ["indigo", "emerald", "grey", "crimson", "yellow", "orange", "pink", "purple"];
  function dotFill(color: string): string {
    const c = PALETTE.includes(color) ? color : "grey";
    return `bg-label-${c}-text`;
  }

  // Plane renders one bordered chip per label up to `LABEL_MAX_RENDER` (3), then
  // collapses to a single "{n} Labels" summary chip. Static full class strings so
  // Tailwind's scan keeps the border-priority-* utilities (no dynamic interpolation).
  const LABEL_MAX_RENDER = 3;
  const labelSummary = $derived(
    pickedLabels.length > LABEL_MAX_RENDER ? `${pickedLabels.length} Labels` : "",
  );

  // The PRIORITY box border is priority-KEYED (Plane border-priority-{urgent|…},
  // border-strong for none). Map each priority to its full border-color class so
  // Tailwind statically picks it up; "none" falls back to the default hairline.
  const PRIORITY_BORDER: Record<Priority, string> = {
    urgent: "border-priority-urgent",
    high: "border-priority-high",
    medium: "border-priority-medium",
    low: "border-priority-low",
    none: "border-edge",
  };

  // The editable variant for a property is active only when editing is on AND its
  // handler is supplied (and, where needed, its data is present).
  const editState = $derived(editable && Boolean(onStateChange) && states.length > 0);
  const editPriority = $derived(editable && Boolean(onPriorityChange));
  const editAssignee = $derived(editable && Boolean(onAssigneeChange) && Boolean(pools));
  const editDates = $derived(editable && Boolean(onDatesChange));
  const editLabels = $derived(editable && Boolean(onLabelsChange));
  const editCycle = $derived(editable && Boolean(onCycleChange));
  const editModules = $derived(editable && Boolean(onModulesChange));

  // The board CARD (variant="chip") is Plane's CLEAN minimal block: it shows the
  // state pill, the priority icon (only when set), the assignee avatar (only when
  // assigned), and ONLY-WHEN-PRESENT the due chip + label dots. It must NOT render
  // the empty-field editor placeholders (no minus/calendar/Labels/refresh/box
  // stubs) — those optional properties are edited from the detail peek, not the
  // card. The detail panel keeps variant="row", where every editor renders
  // unconditionally so each property row is always present and settable.
  // `compact` flips the card into this hide-when-empty mode; "row" is unaffected.
  const compact = $derived(variant === "chip");
  // Each optional property is present when it carries a value. Used to suppress its
  // empty placeholder on the compact card while still showing it once set. (State,
  // priority and assignee are NOT in this list — Plane always renders those, see
  // their blocks below.)
  const hasDates = $derived(Boolean(startDate) || Boolean(dueAt));
  const hasSchedule = $derived(Boolean(schedule));
  const hasLabels = $derived(pickedLabels.length > 0);
  const hasCycle = $derived(Boolean(cycleId));
  const hasModules = $derived(moduleIds.length > 0);
  const hasAssignee = $derived(Boolean(assigneeId));

  // ── count chips (sub-items / links / attachments) ──────────────────────────
  // Plane's bordered count chip (h-5, border-strong, rounded-sm, icon + N). The
  // shell comes from ui.ts workCountChip; hidden when its count is 0 even if shown.
</script>

{#snippet countPill(label: string, count: number)}
  <span class={workCountChip} title={`${count} ${label}`} aria-label={`${count} ${label}`}>
    {#if label === "sub-items"}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" />
      </svg>
    {:else if label === "links"}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
      </svg>
    {:else}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21.44 11.05 12.7 19.8a5 5 0 0 1-7.07-7.07l8.49-8.49a3 3 0 0 1 4.24 4.24l-8.49 8.49a1 1 0 0 1-1.41-1.41l7.78-7.78" />
      </svg>
    {/if}
    <span>{count}</span>
  </span>
{/snippet}

<div
  class={cn(
    variant === "chip" ? cardPropsRow : "flex flex-wrap items-center gap-1.5 text-content-muted",
    className,
  )}
>
  <!-- STATE — always rendered: the card's state pill (icon + name) and the detail
       row's editor. Plane's state is a BORDERED pill (border-strong, rounded-sm,
       gap-1.5, 16px group icon + state name). The read-only chip wraps the icon +
       name in workChipPill so it reads as Plane's pill; the detail row (variant
       "row") drops the border so the editor owns the hover. State always carries
       a value, so it never reads as an empty placeholder. -->
  {#if shown("status")}
    {#if editState}
      <StateDropdown value={stateId} options={states} variant="chip" showLabel={compact} onChange={(id) => onStateChange?.(id)} />
    {:else if state}
      <span class={compact ? workChipPill : "inline-flex items-center gap-1.5"}>
        <StateGroupIcon group={state.group} color={state.color} size={iconSize} />
        {#if compact}<span class="max-w-40 truncate text-content-dim">{state.name}</span>{/if}
      </span>
    {/if}
  {/if}

  <!-- PRIORITY — Plane all-properties.tsx:214-225 ALWAYS renders the priority box
       (border-without-text): the small bordered icon-only square, even for "none"
       (it shows the SignalHigh glyph). Like the assignee, it is NEVER hidden on the
       compact card — the box itself is the always-present affordance. Editable
       (clicking opens the picker); read-only box only when no handler is wired. -->
  {#if shown("priority")}
    {#if editPriority}
      <PriorityDropdown value={priority} variant="chip" onChange={(p) => onPriorityChange?.(p)} />
    {:else}
      <!-- Plane wraps the priority glyph in a small bordered box whose BORDER is
           priority-keyed (border-priority-*, border-strong for none), rounded-sm,
           bg-layer-2, px-0.5, no text. -->
      <span class={cn(workPriorityBox, PRIORITY_BORDER[priority])}>
        <PriorityIcon {priority} size={variant === "row" ? 14 : 12} />
      </span>
    {/if}
  {/if}

  <!-- DUE / DATE RANGE — compact card hides the empty calendar placeholder; shows
       the editor only once a date is set. -->
  {#if shown("dueAt") && (!compact || hasDates)}
    {#if editDates}
      <DateRangeDropdown
        value={{ startDate, dueAt }}
        variant="chip"
        onChange={(r) => onDatesChange?.(r)}
      />
    {:else if dueLabel}
      <!-- Plane's due chip = bordered (border-strong) pill with a leading 12px
           calendar icon + date text, going danger-red when overdue. We keep the
           dueClass tint (which already encodes overdue/today) layered over the
           shared bordered shell + add the calendar glyph. -->
      <span class={cn(dueChip, "h-5 gap-1.5 border-[0.5px] border-edge px-1.5", dueClass)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        {dueLabel}
      </span>
    {/if}
  {/if}

  <!-- SCHEDULE (Cyborg7 per-task scheduling) — a bordered cadence pill sitting
       AFTER the due chip and BEFORE the assignee, matching the due chip's shape
       (workChipPill geometry + a leading 12px clock glyph). DEFAULT-HIDDEN when the
       task carries no schedule (gated on `hasSchedule`), so an unscheduled card
       stays uncluttered — same compact-hide intent as the dates/cycle chips. When
       the schedule is DISABLED the pill greys + strikes through. Clicking opens the
       per-task schedule editor (onScheduleClick); without that handler it renders
       as a plain, non-interactive chip (the read-only board card). This is a
       read-only summary chip — it never edits inline. -->
  {#if shown("scheduled") && hasSchedule && scheduleLabel}
    {#if onScheduleClick}
      <button
        type="button"
        title={schedule?.enabled ? `Schedule: ${scheduleLabel}` : `Schedule paused: ${scheduleLabel}`}
        aria-label={schedule?.enabled ? `Schedule: ${scheduleLabel}` : `Schedule paused: ${scheduleLabel}`}
        onclick={() => onScheduleClick?.()}
        class={cn(
          workChipPill,
          "gap-1.5 transition-colors hover:bg-hover-gray focus-ring",
          schedule?.enabled ? "text-content-dim" : "text-content-muted line-through",
        )}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        <span class="max-w-40 truncate">{scheduleLabel}</span>
      </button>
    {:else}
      <span
        title={schedule?.enabled ? `Schedule: ${scheduleLabel}` : `Schedule paused: ${scheduleLabel}`}
        class={cn(
          workChipPill,
          "gap-1.5",
          schedule?.enabled ? "text-content-dim" : "text-content-muted line-through",
        )}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
        <span class="max-w-40 truncate">{scheduleLabel}</span>
      </span>
    {/if}
  {/if}

  <!-- ASSIGNEE — Plane's all-properties.tsx:313-330 ALWAYS renders the
       MemberDropdown (placeholder included): when nobody is assigned it shows the
       bordered placeholder SQUARE (border-without-text), when assigned it shows
       the avatar group (transparent-without-text, no border). Unlike the other
       optional properties this is NEVER hidden on the compact card — the empty
       state IS a visible affordance. Editable on every surface (clicking opens the
       member picker); falls back to a read-only avatar only when no handler/pools. -->
  {#if shown("assignee") && pools}
    {#if editAssignee}
      <AssigneeDropdown value={assigneeId} {pools} variant="chip" onChange={(id) => onAssigneeChange?.(id)} />
    {:else if hasAssignee}
      <AssigneeAvatar {assignee} size={variant === "row" ? 20 : 18} />
    {/if}
  {/if}

  <!-- MODULES — compact card hides the empty module stub entirely; only the detail
       row (or a future set value) renders the editor. Plane orders modules before
       cycles. -->
  {#if shown("module") && (!compact || hasModules)}
    {#if editModules}
      <ModuleSelect value={moduleIds} options={modules} variant="chip" onChange={(ids) => onModulesChange?.(ids)} />
    {/if}
  {/if}

  <!-- CYCLE — compact card hides the empty cycle stub entirely; only the detail
       row (or a future set value) renders the editor. -->
  {#if shown("cycle") && (!compact || hasCycle)}
    {#if editCycle}
      <CycleSelect value={cycleId} options={cycles} variant="chip" onChange={(id) => onCycleChange?.(id)} />
    {/if}
  {/if}

  <!-- COUNTS (sub-items / attachments / links) — Plane's all-properties.tsx renders
       the count chips in sub-issues → attachments → links order, after the
       module/cycle properties and before the labels. -->
  {#if shown("subItemCount") && subItemCount > 0}
    {@render countPill("sub-items", subItemCount)}
  {/if}
  {#if shown("attachmentCount") && attachmentCount > 0}
    {@render countPill("attachments", attachmentCount)}
  {/if}
  {#if shown("linkCount") && linkCount > 0}
    {@render countPill("links", linkCount)}
  {/if}

  <!-- LABELS — Plane's all-properties.tsx renders the labels LAST (after the
       count chips). Compact card hides the empty "+ Labels" stub; renders Plane's
       per-label BORDERED name chips (a color dot + the label name) up to
       LABEL_MAX_RENDER (3), then collapses to a single "{n} Labels" summary chip.
       The dot fill stays on our --label-* token palette (per CLAUDE.md), not the
       raw label.color. The detail row keeps the full editor so labels stay
       settable there. -->
  {#if shown("labels") && (!compact || hasLabels)}
    {#if editLabels && !compact}
      <LabelDropdown
        value={labelIds}
        options={labels}
        variant="chip"
        onChange={(ids) => onLabelsChange?.(ids)}
        onCreate={onLabelCreate}
      />
    {:else if labelSummary}
      <span class={workLabelChip} title={pickedLabels.map((l) => l.name).join(", ")}>
        <span class="bg-accent size-2 shrink-0 rounded-full"></span>
        {labelSummary}
      </span>
    {:else if pickedLabels.length}
      {#each pickedLabels as l (l.id)}
        <span class={workLabelChip} title={l.name} aria-label={`Label: ${l.name}`}>
          <span class={cn(workLabelDot, dotFill(l.color))}></span>
          <span class="max-w-[200px] truncate">{l.name}</span>
        </span>
      {/each}
    {/if}
  {/if}
</div>
