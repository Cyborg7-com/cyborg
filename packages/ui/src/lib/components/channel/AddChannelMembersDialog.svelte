<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { workspaceState, addChannelMember, addChannelCybo } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { toast } from "svelte-sonner";
  import Avatar from "$lib/components/Avatar.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import type { ChannelMember } from "$lib/core/types.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";

  let {
    open = $bindable(false),
    channelId,
    existingMembers = [],
    existingCyboIds = [],
    onmemberadded,
    oncyboadded,
  }: {
    open: boolean;
    channelId: string;
    existingMembers: ChannelMember[];
    existingCyboIds?: string[];
    onmemberadded?: () => void;
    oncyboadded?: () => void;
  } = $props();

  let search = $state("");
  let adding = $state<string | null>(null);
  // Per-cybo in-flight flags (not a single id) so adding several in quick
  // succession doesn't prematurely re-enable an earlier one's button.
  let addingCybos = $state<Record<string, boolean>>({});

  // An add (member or cybo) is in flight — block dialog dismissal mid-write so an
  // accidental Esc / outside-click / sheet-close can't interrupt it (mirrors
  // ChannelDetailsDialog.isBusy).
  const isBusy = $derived(adding !== null || Object.keys(addingCybos).length > 0);

  const existingIds = $derived(new Set(existingMembers.map((m) => m.userId)));
  const existingCyboSet = $derived(new Set(existingCyboIds));

  // Workspace cybos not already in the channel, matched against the same search.
  const availableCybos = $derived(
    cyboState.list
      .filter((c) => !existingCyboSet.has(c.id))
      .filter((c) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q);
      }),
  );

  async function handleAddCybo(cyboId: string) {
    if (addingCybos[cyboId]) return;
    addingCybos[cyboId] = true;
    try {
      await addChannelCybo(channelId, cyboId);
      oncyboadded?.();
    } catch (err) {
      console.error("Failed to add cybo:", err);
      // Surface the failure — offline (request() rejects "Not connected") or a
      // permission denial would otherwise look like "nothing happened".
      const cybo = cyboState.list.find((c) => c.id === cyboId);
      toast.error(
        `Couldn't add ${cybo ? `@${cybo.slug}` : "the cybo"} — check your connection and permissions.`,
      );
    } finally {
      delete addingCybos[cyboId];
    }
  }

  const available = $derived(
    workspaceState.members
      .filter((m) => m.membershipType === "active" && !existingIds.has(m.userId))
      .filter((m) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (m.name?.toLowerCase().includes(q) ?? false) || m.email.toLowerCase().includes(q);
      }),
  );

  async function handleAdd(userId: string) {
    adding = userId;
    try {
      await addChannelMember(channelId, userId);
      onmemberadded?.();
    } catch (err) {
      console.error("Failed to add member:", err);
      const member = workspaceState.members.find((m) => m.userId === userId);
      toast.error(
        `Couldn't add ${member?.name ?? member?.email ?? "the member"} — check your connection and permissions.`,
      );
    } finally {
      adding = null;
    }
  }
</script>

{#snippet memberList()}
  {#if available.length === 0 && availableCybos.length === 0}
    <p class="text-sm text-content-muted px-1 py-4 text-center">
      {search.trim() ? "No matching members or cybos" : "All workspace members and cybos are already in this channel"}
    </p>
  {:else}
    <div class="space-y-1">
      {#each available as member}
        <div class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover">
          <div class="w-8 h-8 rounded-full bg-surface-raised flex items-center justify-center text-xs font-medium text-content-dim shrink-0">
            {(member.name ?? member.email)[0]?.toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-content truncate">{member.name ?? member.email}</div>
            <div class="text-xs text-content-muted truncate">{member.email}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onclick={() => handleAdd(member.userId)}
            disabled={adding === member.userId}
          >
            {adding === member.userId ? "Adding..." : "Add"}
          </Button>
        </div>
      {/each}
      {#if availableCybos.length > 0}
        <div class="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
          Cybos
        </div>
        {#each availableCybos as cybo (cybo.id)}
          <div class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover">
            {#if cybo.avatar && !/^\p{Extended_Pictographic}/u.test(cybo.avatar)}
              <Avatar name={cybo.name} image={cybo.avatar} width={32} fontSize={13} />
            {:else}
              <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised">
                {#if cybo.avatar}{cybo.avatar}{:else}<CyborgIcon size={16} />{/if}
              </span>
            {/if}
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-content truncate">{cybo.name}</div>
              <div class="text-xs text-content-muted truncate">{cybo.role ?? cybo.provider}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onclick={() => handleAddCybo(cybo.id)}
              disabled={addingCybos[cybo.id]}
            >
              {addingCybos[cybo.id] ? "Adding..." : "Add"}
            </Button>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
{/snippet}

{#if open && viewportState.isMobile}
  <!-- Mobile: same form inside an iOS bottom sheet. Search input ≥16px to
       suppress iOS focus-zoom. Same handlers (handleAdd / handleAddCybo). -->
  <MobileSheet {open} title="Add members" onclose={() => { if (isBusy) return; open = false; search = ""; }}>
    <div class="space-y-3 pb-1">
      <input
        type="text"
        class="w-full rounded-[12px] border border-edge bg-surface px-3 py-2.5 text-base text-content outline-none"
        placeholder="Search by name or email..."
        bind:value={search}
      />
      <div class="max-h-[50vh] overflow-y-auto">
        {@render memberList()}
      </div>
    </div>
  </MobileSheet>
{:else if open}
  <Dialog bind:open onOpenChange={(o) => { if (!o) { open = false; search = ""; } }}>
    <DialogContent
      class="sm:max-w-[440px]"
      showCloseButton={true}
      escapeKeydownBehavior={isBusy ? "ignore" : "close"}
      interactOutsideBehavior={isBusy ? "ignore" : "close"}
    >
      <DialogHeader>
        <DialogTitle>Add members</DialogTitle>
      </DialogHeader>

      <div class="py-2 space-y-3">
        <input
          type="text"
          class="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content outline-none"
          placeholder="Search by name or email..."
          bind:value={search}
        />

        <ScrollArea class="h-[260px]">
          {@render memberList()}
        </ScrollArea>
      </div>
    </DialogContent>
  </Dialog>
{/if}
