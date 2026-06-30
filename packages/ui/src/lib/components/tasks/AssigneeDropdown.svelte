<script lang="ts">
  // Controlled ASSIGNEE editor for the Tasks surfaces. Single assignee for v1,
  // rendered as a one-avatar stack via AssigneeAvatar (which differentiates
  // human / cybo / agent / unassigned). Renders a trigger CHIP (compact card) or
  // a ROW editor (detail-panel property row) that opens a dropdown grouping the
  // assignable identities into People / Cybos / Agents plus an "Unassigned"
  // option. Selecting fires onChange(assigneeId | null) — the PARENT owns the
  // pools and persistence; this component holds NO client/state references.
  //
  // Reuses the existing AssigneeAvatar + resolveAssignee (lib/tasks/assignee.ts)
  // rather than re-deriving names/faces, and the same dropdown-menu primitive +
  // ui.ts tokens as the State/Priority editors so the four read identically.
  // Token-only; zero raw color literals.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import { haptic } from "$lib/mobile/haptics.js";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { agentDisplayName } from "$lib/agent-display.js";
  import {
    propertyEditor,
    propertyEditorEmpty,
    menuPanel,
    menuSectionLabel,
    filterOption,
    menuItemRowActive,
    workAssigneeBox,
    workAvatarRing,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let {
    value = null,
    pools,
    disabled = false,
    onChange,
    placeholder = "Assignee",
    variant = "chip",
    class: className,
  }: {
    // The current assignee id (member userId / cybo id / agent agentId), or null.
    value?: string | null;
    // The assignable identity pools (members / cybos / agents). Required so the
    // editor can both resolve the trigger face and list the options.
    pools: AssigneePools;
    disabled?: boolean;
    // Fired with the chosen id (or null for "Unassigned") on every selection.
    onChange: (next: string | null) => void;
    placeholder?: string;
    // chip / row = trigger + popover; inline = the grouped option list rendered
    // directly (no trigger/popover) for the mobile picker sheet.
    variant?: "chip" | "row" | "inline";
    class?: string;
  } = $props();

  const selected = $derived(resolveAssignee(value, pools));
  const avatarSize = $derived(variant === "row" ? 18 : 20);

  // The trigger SHELL differs by variant AND (on the chip) by assigned-ness, to
  // reproduce Plane's MemberDropdown exactly (all-properties.tsx:313-330):
  //  - row    -> the full property-row editor (avatar + name).
  //  - chip + UNASSIGNED -> buttonVariant="border-without-text": the bordered h-5
  //    SQUARE placeholder (workAssigneeBox) carrying ONLY a members icon. This is
  //    Plane's always-present placeholder — the card NEVER hides the assignee.
  //  - chip + ASSIGNED   -> buttonVariant="transparent-without-text": NO border,
  //    just the avatar (the avatar group), with hover:bg-transparent px-0.
  const triggerClass = $derived(
    variant === "row"
      ? propertyEditor
      : selected
        ? "inline-flex h-5 items-center px-0"
        : workAssigneeBox,
  );
</script>

{#if variant === "inline"}
  <!-- Inline option list for the mobile picker sheet: Unassigned + the People /
       Cybos / Agents groups exactly as the popover, selected row tinted via
       menuItemRowActive, but no trigger/popover. One tap fires onChange — the
       sheet persists + closes. -->
  <div class={cn("flex flex-col", className)}>
    <button
      type="button"
      {disabled}
      aria-label="Unassigned"
      aria-pressed={value == null}
      class={cn(filterOption, "cursor-pointer", value == null && menuItemRowActive)}
      onclick={() => {
        haptic("selection");
        onChange(null);
      }}
    >
      <AssigneeAvatar assignee={null} size={18} />
      <span class="truncate text-content-muted">Unassigned</span>
    </button>

    {#if pools.members.length > 0}
      <span class={menuSectionLabel}>People</span>
      {#each pools.members as m (m.userId)}
        {@const name = m.name ?? m.email}
        <button
          type="button"
          {disabled}
          aria-label={`Assignee: ${name}`}
          aria-pressed={value === m.userId}
          class={cn(filterOption, "cursor-pointer", value === m.userId && menuItemRowActive)}
          onclick={() => {
            haptic("selection");
            onChange(m.userId);
          }}
        >
          <Avatar {name} image={m.imageUrl ?? m.image} width={18} fontSize={9} />
          <span class="truncate">{name}</span>
        </button>
      {/each}
    {/if}

    {#if pools.cybos.length > 0}
      <span class={menuSectionLabel}>Cybos</span>
      {#each pools.cybos as c (c.id)}
        <button
          type="button"
          {disabled}
          aria-label={`Assignee: ${c.name}`}
          aria-pressed={value === c.id}
          class={cn(filterOption, "cursor-pointer", value === c.id && menuItemRowActive)}
          onclick={() => {
            haptic("selection");
            onChange(c.id);
          }}
        >
          <Avatar name={c.name} avatar={c.avatar} width={18} fontSize={9} />
          <span class="truncate">{c.name}</span>
        </button>
      {/each}
    {/if}

    {#if pools.agents.length > 0}
      <span class={menuSectionLabel}>Agents</span>
      {#each pools.agents as a (a.agentId)}
        {@const name = agentDisplayName(a)}
        <button
          type="button"
          {disabled}
          aria-label={`Assignee: ${name}`}
          aria-pressed={value === a.agentId}
          class={cn(filterOption, "cursor-pointer", value === a.agentId && menuItemRowActive)}
          onclick={() => {
            haptic("selection");
            onChange(a.agentId);
          }}
        >
          <Avatar {name} avatar={a.cyboAvatar} width={18} fontSize={9} />
          <span class="truncate">{name}</span>
        </button>
      {/each}
    {/if}
  </div>
{:else}
  <DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected?.name ?? "Unassigned"}
    aria-label={selected ? `Assignee: ${selected.name}` : "Unassigned"}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {#if variant === "chip" && !selected}
      <!-- Plane unassigned placeholder square (border-without-text): just the
           members icon h-3 w-3 with mx-[4px] (avatar.tsx:56-60). The bordered box
           geometry is on the trigger via workAssigneeBox. -->
      <svg
        class="mx-[4px] h-3 w-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
      </svg>
    {:else if variant === "chip"}
      <!-- Plane assigned: the avatar (group) with NO border — each avatar wrapped
           in a rounded-full ring (avatar-group.tsx:67-69). -->
      <span class={cn(workAvatarRing, "grid place-items-center overflow-hidden")}>
        <AssigneeAvatar assignee={selected} size={avatarSize} />
      </span>
    {:else}
      <AssigneeAvatar assignee={selected} size={avatarSize} />
      <span class={cn("truncate", !selected && propertyEditorEmpty)}>
        {selected ? selected.name : placeholder}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 overflow-y-auto p-1")}>
    <DropdownMenuItem
      class={cn(filterOption, "cursor-pointer", value == null && menuItemRowActive)}
      onSelect={() => onChange(null)}
    >
      <AssigneeAvatar assignee={null} size={18} />
      <span class="truncate text-content-muted">Unassigned</span>
    </DropdownMenuItem>

    {#if pools.members.length > 0}
      <span class={menuSectionLabel}>People</span>
      {#each pools.members as m (m.userId)}
        {@const name = m.name ?? m.email}
        <DropdownMenuItem
          class={cn(filterOption, "cursor-pointer", value === m.userId && menuItemRowActive)}
          onSelect={() => onChange(m.userId)}
        >
          <Avatar {name} image={m.imageUrl ?? m.image} width={18} fontSize={9} />
          <span class="truncate">{name}</span>
        </DropdownMenuItem>
      {/each}
    {/if}

    {#if pools.cybos.length > 0}
      <span class={menuSectionLabel}>Cybos</span>
      {#each pools.cybos as c (c.id)}
        <DropdownMenuItem
          class={cn(filterOption, "cursor-pointer", value === c.id && menuItemRowActive)}
          onSelect={() => onChange(c.id)}
        >
          <Avatar name={c.name} avatar={c.avatar} width={18} fontSize={9} />
          <span class="truncate">{c.name}</span>
        </DropdownMenuItem>
      {/each}
    {/if}

    {#if pools.agents.length > 0}
      <span class={menuSectionLabel}>Agents</span>
      {#each pools.agents as a (a.agentId)}
        {@const name = agentDisplayName(a)}
        <DropdownMenuItem
          class={cn(filterOption, "cursor-pointer", value === a.agentId && menuItemRowActive)}
          onSelect={() => onChange(a.agentId)}
        >
          <Avatar {name} avatar={a.cyboAvatar} width={18} fontSize={9} />
          <span class="truncate">{name}</span>
        </DropdownMenuItem>
      {/each}
    {/if}
  </DropdownMenuContent>
  </DropdownMenu>
{/if}
