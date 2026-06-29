<script lang="ts">
  // Assignee dropdown for a task. Groups the workspace's assignable identities
  // into People (members) / Cybos / Agents, each row an avatar + name, plus an
  // "Unassigned" option. Selecting a row sets the bound `value` to that id (or
  // null for unassigned). Pure presentational — the parent owns the pools and
  // decides what to do with the chosen id.
  import * as Select from "$lib/components/ui/select/index.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { controlBtn } from "$lib/tasks/ui.js";
  import { agentDisplayName } from "$lib/agent-display.js";
  import { cn } from "$lib/utils.js";

  let {
    value = $bindable(null),
    pools,
    onChange,
  }: {
    value?: string | null;
    pools: AssigneePools;
    // Optional: fired with the chosen id (or null) on every selection, in
    // addition to updating the bound `value`. The detail card uses this to
    // persist the change (CreateTaskDialog relies on bind:value and ignores it).
    onChange?: (value: string | null) => void;
  } = $props();

  // Sentinel for the "Unassigned" option — Select values are strings, so we map
  // it to null on selection and back to the sentinel for the trigger.
  const UNASSIGNED = "__unassigned__";

  const selected = $derived(resolveAssignee(value, pools));
</script>

<Select.Root
  type="single"
  value={value ?? UNASSIGNED}
  onValueChange={(v) => {
    const next = v && v !== UNASSIGNED ? v : null;
    value = next;
    onChange?.(next);
  }}
>
  <Select.Trigger class={cn(controlBtn, "w-full justify-start text-content")}>
    {#if selected}
      <Avatar name={selected.name} avatar={selected.avatarUrl} width={20} fontSize={10} />
      <span class="truncate">{selected.name}</span>
    {:else}
      <span class="text-content-muted">Unassigned</span>
    {/if}
  </Select.Trigger>
  <Select.Content>
    <Select.Item value={UNASSIGNED} label="Unassigned">
      <span class="text-content-muted">Unassigned</span>
    </Select.Item>

    {#if pools.members.length > 0}
      <Select.Group>
        <Select.Label>People</Select.Label>
        {#each pools.members as m (m.userId)}
          {@const name = m.name ?? m.email}
          <Select.Item value={m.userId} label={name}>
            <Avatar {name} image={m.imageUrl ?? m.image} width={20} fontSize={10} />
            <span class="truncate">{name}</span>
          </Select.Item>
        {/each}
      </Select.Group>
    {/if}

    {#if pools.cybos.length > 0}
      <Select.Group>
        <Select.Label>Cybos</Select.Label>
        {#each pools.cybos as c (c.id)}
          <Select.Item value={c.id} label={c.name}>
            <Avatar name={c.name} avatar={c.avatar} width={20} fontSize={10} />
            <span class="truncate">{c.name}</span>
          </Select.Item>
        {/each}
      </Select.Group>
    {/if}

    {#if pools.agents.length > 0}
      <Select.Group>
        <Select.Label>Agents</Select.Label>
        {#each pools.agents as a (a.agentId)}
          {@const name = agentDisplayName(a)}
          <Select.Item value={a.agentId} label={name}>
            <Avatar {name} avatar={a.cyboAvatar} width={20} fontSize={10} />
            <span class="truncate">{name}</span>
          </Select.Item>
        {/each}
      </Select.Group>
    {/if}
  </Select.Content>
</Select.Root>
