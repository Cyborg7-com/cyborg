<script lang="ts">
  // Controlled DATE-RANGE editor for the Tasks surfaces. A trigger CHIP (compact
  // card) or ROW editor (detail-panel property row) that opens a popover holding
  // TWO native date pickers — a start date and a due date. The due value tints
  // overdue-red (past + not done) on both the trigger and its picker. Each edit
  // fires onChange({ startDate, dueAt }) with the FULL pair (the unchanged half
  // echoed back) — the PARENT owns persistence; this holds NO client/state refs.
  //
  // DATE CONTRACT: both `startDate` and `dueAt` are ISO strings | null (the P1b
  // task date shape), NOT ms-epoch. We convert ISO <-> the <input type="date">
  // value (YYYY-MM-DD) at this boundary so the native picker works while the
  // emitted values stay ISO; the parent maps these to whatever its task model
  // stores. We chose ONE combined editor (start + due together) over two single
  // editors because Plane edits the range as a unit and overdue depends on due.
  //
  // Token-only: trigger via inlineRowControl / propertyEditor / propertyEditorEmpty,
  // the overdue tint via the existing `text-error` token (matching due.ts), the
  // panel via menuPanel. Zero raw color literals.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import {
    workChipPill,
    propertyEditor,
    propertyEditorEmpty,
    fieldLabel,
    menuPanel,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  export interface DateRange {
    // ISO date strings (or null). The parent decides the precision it persists.
    startDate: string | null;
    dueAt: string | null;
  }

  let {
    value = { startDate: null, dueAt: null },
    disabled = false,
    onChange,
    placeholder = "Set dates",
    variant = "chip",
    class: className,
  }: {
    // The current { startDate, dueAt } pair (ISO strings | null). Controlled.
    value?: DateRange;
    disabled?: boolean;
    // Fired with the full pair on every edit (the unchanged half echoed back).
    onChange: (next: DateRange) => void;
    placeholder?: string;
    variant?: "chip" | "row";
    class?: string;
  } = $props();

  // ── ISO <-> <input type="date"> (YYYY-MM-DD) boundary ──────────────────────
  // The native picker speaks YYYY-MM-DD; tasks carry ISO. Parse defensively: a
  // malformed stored value yields "" (empty picker) rather than throwing.
  function toInputValue(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    // Local Y-M-D so the displayed day matches what the user picked.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  // Emit a midday-UTC ISO so a date never slips a day across timezones. Empty
  // picker -> null.
  function fromInputValue(v: string): string | null {
    if (!v) return null;
    return new Date(`${v}T12:00:00.000Z`).toISOString();
  }

  // Short human label for the trigger ("Mar 5"); empty -> "".
  function shortLabel(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const startLabel = $derived(shortLabel(value.startDate));
  const dueLabel = $derived(shortLabel(value.dueAt));
  const hasAny = $derived(Boolean(value.startDate || value.dueAt));

  // Overdue = due date is in the past (date-only comparison, so "today" is never
  // overdue). The parent decides whether a done task should suppress this by not
  // passing a due — here it's a pure date check.
  const overdue = $derived.by(() => {
    if (!value.dueAt) return false;
    const d = new Date(value.dueAt);
    if (Number.isNaN(d.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return due.getTime() < today.getTime();
  });

  // chip = Plane's date chip (border-with-text BorderButton): bordered pill, h-5,
  // px-1.5, gap-1.5 (workChipPill). row = the full property-row editor.
  const triggerClass = $derived(variant === "row" ? propertyEditor : workChipPill);
  const dateInput =
    "h-8 w-full rounded-[4px] border border-edge bg-surface-alt px-2 text-[13px] " +
    "text-content outline-none focus:border-accent";

  function setStart(v: string): void {
    onChange({ startDate: fromInputValue(v), dueAt: value.dueAt });
  }
  function setDue(v: string): void {
    onChange({ startDate: value.startDate, dueAt: fromInputValue(v) });
  }
</script>

<DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title="Start / due dates"
    aria-label="Start and due dates"
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    <!-- calendar glyph (currentColor; goes red with the trigger when overdue) -->
    <span class={cn("inline-flex shrink-0", overdue && "text-error")}>
      <svg width={variant === "row" ? 16 : 14} height={variant === "row" ? 16 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    </span>
    {#if !hasAny}
      {#if variant === "row"}
        <span class={cn("truncate", propertyEditorEmpty)}>{placeholder}</span>
      {/if}
    {:else}
      <span class={cn("truncate", overdue && "text-error")}>
        {#if startLabel && dueLabel}
          {startLabel} – {dueLabel}
        {:else if dueLabel}
          {dueLabel}
        {:else}
          {startLabel}
        {/if}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "flex w-60 flex-col gap-2 p-3")}>
    <div class="flex flex-col gap-1">
      <span class={fieldLabel}>Start date</span>
      <input
        type="date"
        value={toInputValue(value.startDate)}
        max={toInputValue(value.dueAt) || undefined}
        onchange={(e) => setStart(e.currentTarget.value)}
        class={dateInput}
      />
    </div>
    <div class="flex flex-col gap-1">
      <span class={cn(fieldLabel, overdue && "text-error")}>Due date</span>
      <input
        type="date"
        value={toInputValue(value.dueAt)}
        min={toInputValue(value.startDate) || undefined}
        onchange={(e) => setDue(e.currentTarget.value)}
        class={cn(dateInput, overdue && "border-error text-error")}
      />
    </div>
  </DropdownMenuContent>
</DropdownMenu>
