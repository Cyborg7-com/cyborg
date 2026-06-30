<script lang="ts">
  // WS3 — the single create-task sheet (full body). Mounted once in
  // tasks/+layout.svelte and driven by the shared openCreate store (openCreateTask
  // seeds + opens it). Field set + persist logic match the desktop CreateTaskDialog
  // 1:1: title (required) · description · status/state · priority · due date ·
  // assignee, with the SAME 2-step persist (create_task only accepts
  // title/description/dueAt/assigneeId/projectId/stateId, so a non-default
  // status/priority rides ONE follow-up updateTask) and Plane's "Create more"
  // rapid-entry toggle.
  //
  // Nested selects are INLINE ACCORDION sections (not sheet-over-sheet): tapping a
  // field expands its option list IN PLACE; full picker sheets are reserved for the
  // Detail screen. The new row arrives via the cyborg:tasks_changed broadcast (no
  // local optimistic insert), exactly like the desktop dialog. Token-only.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import { createTaskSheet, closeCreateTask } from "$lib/tasks/openCreate.svelte.js";
  import { workspaceState, client } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import { btnPrimary, titleInput, priorityDot } from "$lib/tasks/ui.js";
  import {
    STATUS_OPTIONS,
    statusLabel,
    dueToInputValue,
    type StatusKey,
  } from "$lib/tasks/detail.js";
  import { columnForStatus } from "$lib/tasks/board.js";
  import { PRIORITY_ORDER, priorityStyle, type Priority } from "$lib/tasks/priority.js";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { agentDisplayName } from "$lib/agent-display.js";
  import type { TaskState } from "$lib/core/types.js";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import CheckIcon from "@lucide/svelte/icons/check";
  import UserIcon from "@lucide/svelte/icons/user";
  import FlagIcon from "@lucide/svelte/icons/flag";
  import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
  import { cn } from "$lib/utils.js";

  const DEFAULT_STATUS: StatusKey = "pending";

  // Only ACTIVE members are assignable (an invited-but-not-joined member can't own
  // work yet) — same filter the desktop dialog + channel picker use.
  const pools = $derived<AssigneePools>({
    members: (workspaceState.members ?? []).filter((m) => m.membershipType === "active"),
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  // ── Form state ───────────────────────────────────────────────────────────────
  let title = $state("");
  let description = $state("");
  let status = $state<StatusKey>(DEFAULT_STATUS);
  let stateId = $state<string | null>(null);
  let priority = $state<Priority>("none");
  // <input type="date"> value (LOCAL YYYY-MM-DD); empty = no due date.
  let dueDate = $state("");
  let assigneeId = $state<string | null>(null);
  let creating = $state(false);
  let error = $state<string | null>(null);
  // Plane's "Create more": keep the sheet open after a create, clear, refocus.
  let createMore = $state(false);
  let titleEl = $state<HTMLInputElement | null>(null);

  // Which inline accordion is expanded (single-open). null = all collapsed.
  let openSection = $state<"status" | "priority" | "assignee" | null>(null);
  function toggleSection(s: "status" | "priority" | "assignee"): void {
    openSection = openSection === s ? null : s;
  }

  // The project's workflow states drive the Status field when present (fetched on
  // open from the seeded projectId). Empty (workspace-level Tasks tab, no project)
  // → the legacy four-status path.
  let states = $state<TaskState[]>([]);
  const hasStates = $derived(states.length > 0);
  const selectedState = $derived(stateId ? (states.find((s) => s.id === stateId) ?? null) : null);
  const selectedAssignee = $derived(resolveAssignee(assigneeId, pools));

  // Seed ONLY from the explicit init — NOT states[0]. The open effect calls this
  // (via resetFields), and reading `states` there while the same effect also
  // writes it would re-trigger the effect. The project's first/backlog state is
  // applied as the fallback in the fetch `.then` below, once the catalog is in.
  function defaultStateId(): string | null {
    return createTaskSheet.init.stateId ?? null;
  }
  function normalizeStatus(seed: string | undefined): StatusKey {
    if (!seed) return DEFAULT_STATUS;
    const column = columnForStatus(seed);
    if (column === "todo") return DEFAULT_STATUS;
    return column;
  }
  function normalizePriority(seed: string | undefined): Priority {
    if (seed === "urgent" || seed === "high" || seed === "medium" || seed === "low") return seed;
    return "none";
  }

  // Seed the fields from the store's init (or sensible defaults). Title +
  // description always start empty.
  function applyInitial(): void {
    const init = createTaskSheet.init;
    status = normalizeStatus(init.status);
    stateId = defaultStateId();
    priority = normalizePriority(init.priority);
    assigneeId = init.assigneeId ?? null;
    dueDate = dueToInputValue(init.dueAt ?? null);
  }
  function resetFields(): void {
    title = "";
    description = "";
    applyInitial();
    openSection = null;
  }

  const canSubmit = $derived(title.trim().length > 0 && !creating);

  // Reset + (re)hydrate the project states whenever the sheet opens. Keyed on
  // `open` so a reopen re-seeds; a failed states fetch degrades to the legacy
  // status path (no crash). focus the title once mounted.
  $effect(() => {
    if (!createTaskSheet.open) return;
    error = null;
    creating = false;
    // Clear any stale catalog from a previous project BEFORE seeding, so a reopen
    // for a different project never shows/seeds the old project's states. The
    // effect only ever WRITES `states` (never reads it), so these writes can't
    // re-trigger it.
    states = [];
    resetFields();
    const projectId = createTaskSheet.init.projectId ?? null;
    let active = true;
    if (projectId) {
      void client
        .fetchProjectStates(projectId)
        .then((s) => {
          if (!active) return;
          states = s;
          // Default to the project's first/backlog state when none was seeded.
          if (!stateId) stateId = createTaskSheet.init.stateId ?? s[0]?.id ?? null;
          return undefined;
        })
        .catch(() => {}); // intentional: best-effort state prefetch; the create sheet works without it
    }
    requestAnimationFrame(() => titleEl?.focus());
    return () => {
      active = false;
    };
  });

  async function submit(): Promise<void> {
    const t = title.trim();
    const wsId = workspaceState.current?.id;
    if (!t || !wsId || creating) return;
    creating = true;
    error = null;
    const init = createTaskSheet.init;

    // A date input has no time-of-day; pin to local end-of-day so a task due
    // "today" isn't already overdue (matches the desktop dialog + detail.ts).
    let dueAt: number | undefined;
    if (dueDate) {
      // Build from local numeric parts, NOT `new Date("YYYY-MM-DDT23:59:59")`:
      // that string form parses inconsistently (and can shift to UTC) in
      // Safari/WebKit, which powers the Tauri iOS wrapper. (Gemini PR #1075)
      const [y, m, d] = dueDate.split("-").map(Number);
      const ts = new Date(y, m - 1, d, 23, 59, 59).getTime();
      if (!Number.isNaN(ts)) dueAt = ts;
    }

    try {
      const created = await client.createTask(wsId, t, {
        description: description.trim() || undefined,
        assigneeId: assigneeId ?? undefined,
        dueAt,
        projectId: init.projectId || undefined,
        // With a state catalog the chosen state files the task directly; without
        // one, fall back to any seeded stateId.
        stateId: (hasStates ? stateId : init.stateId) || undefined,
      });

      // create_task can't carry priority, and (with no catalog) status rides a
      // follow-up too. Status is compared by board COLUMN so we never fire a
      // no-op. A failed follow-up must NOT fail the create (the task exists).
      const updates: { status?: string; priority?: string } = {};
      if (!hasStates && columnForStatus(status) !== columnForStatus(created.status)) {
        updates.status = status;
      }
      if (priority !== "none") updates.priority = priority;
      if (updates.status !== undefined || updates.priority !== undefined) {
        try {
          await client.updateTask(wsId, created.id, updates);
        } catch (err) {
          console.error("Failed to apply status/priority to the new work item", err);
        }
      }

      if (createMore) {
        resetFields();
        requestAnimationFrame(() => titleEl?.focus());
      } else {
        closeCreateTask();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn't create the work item.";
    } finally {
      creating = false;
    }
  }
</script>

<MobileSheet
  open={createTaskSheet.open}
  onclose={closeCreateTask}
  title="New work item"
  ariaLabel="Create work item"
  maxHeight="92vh"
>
  <div class="flex flex-col gap-3 pb-2">
    <!-- Title (required) — borderless, autofocused. -->
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={titleEl}
      type="text"
      bind:value={title}
      autofocus
      placeholder="Work item title"
      aria-label="Work item title"
      class={cn(titleInput, "text-[17px]")}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
    />

    <!-- Description -->
    <textarea
      bind:value={description}
      rows="3"
      placeholder="Add a description…"
      aria-label="Description"
      class="w-full resize-none bg-transparent text-[14px] text-content placeholder:text-content-muted focus:outline-none"
    ></textarea>

    <div class="flex flex-col divide-y divide-edge/60 border-y border-edge/60">
      <!-- ── Status / State (inline accordion) ── -->
      <div>
        <button
          type="button"
          onclick={() => toggleSection("status")}
          class="touch-target-row flex w-full items-center gap-3 py-2 text-left"
          aria-expanded={openSection === "status"}
        >
          <span class="grid size-4 shrink-0 place-items-center text-content-muted">
            <StateGroupIcon group={selectedState?.group ?? "backlog"} color={selectedState?.color} size={16} />
          </span>
          <span class="w-20 shrink-0 text-[13px] font-medium text-content-dim">Status</span>
          <span class="ml-auto min-w-0 flex-1 truncate text-right text-[13px] text-content">
            {hasStates ? (selectedState?.name ?? "Select state") : statusLabel(status)}
          </span>
          <ChevronDownIcon class={cn("size-4 shrink-0 text-content-muted transition-transform", openSection === "status" && "rotate-180")} />
        </button>
        {#if openSection === "status"}
          <div class="flex flex-col pb-2">
            {#if hasStates}
              {#each states as s (s.id)}
                <button
                  type="button"
                  onclick={() => {
                    stateId = s.id;
                    openSection = null;
                  }}
                  class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
                >
                  <StateGroupIcon group={s.group} color={s.color} size={16} />
                  <span class={priorityDot} style={`background:${s.color}`}></span>
                  <span class="min-w-0 flex-1 truncate">{s.name}</span>
                  {#if stateId === s.id}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
                </button>
              {/each}
            {:else}
              {#each STATUS_OPTIONS as o (o.value)}
                <button
                  type="button"
                  onclick={() => {
                    status = o.value;
                    openSection = null;
                  }}
                  class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
                >
                  <span class="min-w-0 flex-1 truncate">{o.label}</span>
                  {#if status === o.value}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

      <!-- ── Priority (inline accordion) ── -->
      <div>
        <button
          type="button"
          onclick={() => toggleSection("priority")}
          class="touch-target-row flex w-full items-center gap-3 py-2 text-left"
          aria-expanded={openSection === "priority"}
        >
          <span class="grid size-4 shrink-0 place-items-center text-content-muted">
            {#if priority !== "none"}<PriorityIcon {priority} size={16} />{:else}<FlagIcon class="size-4" />{/if}
          </span>
          <span class="w-20 shrink-0 text-[13px] font-medium text-content-dim">Priority</span>
          <span class="ml-auto min-w-0 flex-1 truncate text-right text-[13px] capitalize text-content">
            {priority === "none" ? "No priority" : priority}
          </span>
          <ChevronDownIcon class={cn("size-4 shrink-0 text-content-muted transition-transform", openSection === "priority" && "rotate-180")} />
        </button>
        {#if openSection === "priority"}
          <div class="flex flex-col pb-2">
            <button
              type="button"
              onclick={() => {
                priority = "none";
                openSection = null;
              }}
              class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
            >
              <FlagIcon class="size-4 text-content-muted" />
              <span class="min-w-0 flex-1 truncate text-content-muted">No priority</span>
              {#if priority === "none"}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
            </button>
            {#each PRIORITY_ORDER as p (p)}
              {@const ps = priorityStyle(p)}
              <button
                type="button"
                onclick={() => {
                  priority = p;
                  openSection = null;
                }}
                class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
              >
                <PriorityIcon priority={p} size={16} />
                <span class="min-w-0 flex-1 truncate">{ps?.label ?? p}</span>
                {#if priority === p}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- ── Assignee (inline accordion) ── -->
      <div>
        <button
          type="button"
          onclick={() => toggleSection("assignee")}
          class="touch-target-row flex w-full items-center gap-3 py-2 text-left"
          aria-expanded={openSection === "assignee"}
        >
          <span class="grid size-5 shrink-0 place-items-center text-content-muted">
            {#if selectedAssignee}
              <Avatar name={selectedAssignee.name} avatar={selectedAssignee.avatarUrl} width={20} fontSize={10} />
            {:else}
              <UserIcon class="size-4" />
            {/if}
          </span>
          <span class="w-20 shrink-0 text-[13px] font-medium text-content-dim">Assignee</span>
          <span class="ml-auto min-w-0 flex-1 truncate text-right text-[13px] text-content">
            {selectedAssignee?.name ?? "Unassigned"}
          </span>
          <ChevronDownIcon class={cn("size-4 shrink-0 text-content-muted transition-transform", openSection === "assignee" && "rotate-180")} />
        </button>
        {#if openSection === "assignee"}
          <div class="flex max-h-64 flex-col overflow-y-auto pb-2">
            <button
              type="button"
              onclick={() => {
                assigneeId = null;
                openSection = null;
              }}
              class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
            >
              <UserIcon class="size-4 text-content-muted" />
              <span class="min-w-0 flex-1 truncate text-content-muted">Unassigned</span>
              {#if assigneeId === null}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
            </button>
            {#each pools.members as m (m.userId)}
              {@const name = m.name ?? m.email}
              <button
                type="button"
                onclick={() => {
                  assigneeId = m.userId;
                  openSection = null;
                }}
                class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
              >
                <Avatar {name} image={m.imageUrl ?? m.image} width={20} fontSize={10} />
                <span class="min-w-0 flex-1 truncate">{name}</span>
                {#if assigneeId === m.userId}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
              </button>
            {/each}
            {#each pools.cybos as c (c.id)}
              <button
                type="button"
                onclick={() => {
                  assigneeId = c.id;
                  openSection = null;
                }}
                class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
              >
                <Avatar name={c.name} avatar={c.avatar} width={20} fontSize={10} />
                <span class="min-w-0 flex-1 truncate">{c.name}</span>
                {#if assigneeId === c.id}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
              </button>
            {/each}
            {#each pools.agents as a (a.agentId)}
              {@const name = agentDisplayName(a)}
              <button
                type="button"
                onclick={() => {
                  assigneeId = a.agentId;
                  openSection = null;
                }}
                class="touch-target-row pressable-row flex items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-content"
              >
                <Avatar {name} avatar={a.cyboAvatar} width={20} fontSize={10} />
                <span class="min-w-0 flex-1 truncate">{name}</span>
                {#if assigneeId === a.agentId}<CheckIcon class="size-4 shrink-0 text-accent" />{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- ── Due date — native OS date picker (compact, no accordion needed) ── -->
      <div class="flex items-center gap-3 py-2">
        <span class="grid size-4 shrink-0 place-items-center text-content-muted">
          <CalendarClockIcon class="size-4" />
        </span>
        <label for="mobile-create-due" class="w-20 shrink-0 text-[13px] font-medium text-content-dim">Due date</label>
        <input
          id="mobile-create-due"
          type="date"
          bind:value={dueDate}
          class="ml-auto min-w-0 flex-1 rounded-[4px] bg-transparent px-2 py-1 text-right text-[13px] text-content focus:outline-none"
        />
      </div>
    </div>

    {#if error}
      <p class="text-[12px] text-error" role="alert">{error}</p>
    {/if}

    <!-- Footer: "Create more" toggle + Create button. -->
    <div class="mt-1 flex items-center justify-between gap-3">
      <label class="flex cursor-pointer items-center gap-2 text-[13px] text-content-dim select-none">
        <input type="checkbox" bind:checked={createMore} class="size-4 accent-[color:var(--c7-accent)]" />
        Create more
      </label>
      <button type="button" onclick={submit} disabled={!canSubmit} class={btnPrimary}>
        {creating ? "Creating…" : "Create"}
      </button>
    </div>
  </div>
</MobileSheet>
