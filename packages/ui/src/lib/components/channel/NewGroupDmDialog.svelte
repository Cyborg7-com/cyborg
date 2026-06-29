<!--
  NewGroupDmDialog (#608) — multi-select picker for starting a group DM. Pick
  2–8 OTHER members (the creator is implicit), then Create. The server validates
  membership + the cap and derives the auto-name (members' display names,
  sorted); on success we navigate to the new hidden group_dm channel, which rides
  the normal channel pipeline. Mirrors AddChannelMembersDialog's dialog/sheet
  shell so the surface matches the rest of the app.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { workspaceState, createGroupDm as createGroupDmAction, authState, channelState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import { toast } from "svelte-sonner";
  import { cn, nameToColor } from "$lib/utils.js";
  import { canCreateGroupDm, groupDmCandidates, MAX_GROUP_DM_OTHERS } from "$lib/group-dm-select.js";

  let { open = $bindable(false) }: { open: boolean } = $props();

  let search = $state("");
  let creating = $state(false);
  // Ordered selection (insertion order) so the chip row reads predictably.
  let selectedIds = $state<string[]>([]);

  const selectedSet = $derived(new Set(selectedIds));
  const wsId = $derived(workspaceState.current?.id);

  const candidates = $derived(
    groupDmCandidates({
      members: workspaceState.members,
      selfId: authState.user?.id,
      selectedIds: selectedSet,
      query: search,
    }),
  );

  // The selected members as full rows (for the chip row), in selection order.
  const selectedMembers = $derived(
    selectedIds
      .map((id) => workspaceState.members.find((m) => m.userId === id))
      .filter((m): m is NonNullable<typeof m> => m != null),
  );

  const atCap = $derived(selectedIds.length >= MAX_GROUP_DM_OTHERS);
  const canCreate = $derived(canCreateGroupDm(selectedIds.length) && !creating);

  // Trim + fall back so an empty/whitespace name never renders blank. Mirrors the
  // server-side groupDmMemberLabel (group-dm.ts) so chips/rows read the same as
  // the auto-generated title.
  function memberLabel(m: { name: string | null; email: string }): string {
    const name = m.name?.trim();
    return name || m.email.split("@")[0] || "Someone";
  }

  function toggle(userId: string) {
    if (selectedSet.has(userId)) {
      selectedIds = selectedIds.filter((id) => id !== userId);
    } else if (!atCap) {
      selectedIds = [...selectedIds, userId];
    }
  }

  function reset() {
    search = "";
    selectedIds = [];
  }

  async function handleCreate() {
    if (!canCreate || !wsId) return;
    creating = true;
    try {
      const channel = await createGroupDmAction(selectedIds);
      if (channel) {
        open = false;
        reset();
        channelState.activeId = null;
        goto(`/workspace/${wsId}/channel/${channel.id}`);
      }
    } catch (err) {
      console.error("Failed to create group DM:", err);
      toast.error("Couldn't start the group DM — check your connection and permissions.");
    } finally {
      creating = false;
    }
  }
</script>

{#snippet avatar(name: string, image: string | null | undefined, size: number)}
  {#if image}
    <img src={image} alt={name} class="rounded-full object-cover shrink-0" style:width={`${size}px`} style:height={`${size}px`} />
  {:else}
    <div
      class="rounded-full flex items-center justify-center font-bold text-accent-foreground shrink-0"
      style:width={`${size}px`}
      style:height={`${size}px`}
      style:font-size={`${Math.round(size * 0.4)}px`}
      style:background-color={nameToColor(name)}
    >
      {name[0]?.toUpperCase() ?? "?"}
    </div>
  {/if}
{/snippet}

{#snippet picker(inputClass: string)}
  <div class="space-y-3">
    {#if selectedMembers.length > 0}
      <!-- Selected-member chips (removable). -->
      <div class="flex flex-wrap gap-1.5">
        {#each selectedMembers as m (m.userId)}
          <button
            type="button"
            onclick={() => toggle(m.userId)}
            class="flex items-center gap-1.5 rounded-full bg-surface-raised pl-1 pr-2 py-0.5 text-sm text-content hover:bg-surface-hover transition-colors cursor-pointer"
            aria-label={`Remove ${memberLabel(m)}`}
          >
            {@render avatar(memberLabel(m), authState.getMemberImage(m.userId), 20)}
            <span class="truncate max-w-[140px]">{memberLabel(m)}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        {/each}
      </div>
    {/if}

    <input
      type="text"
      class={inputClass}
      placeholder="Search people by name or email..."
      bind:value={search}
    />

    <ScrollArea class="h-[260px]">
      {#if candidates.length === 0}
        <p class="text-sm text-content-muted px-1 py-4 text-center">
          {search.trim() ? "No matching people" : "No more people to add"}
        </p>
      {:else}
        <div class="space-y-1">
          {#each candidates as m (m.userId)}
            <button
              type="button"
              onclick={() => toggle(m.userId)}
              disabled={atCap}
              class={cn(
                "w-full flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover transition-colors text-left",
                atCap ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
              )}
            >
              {@render avatar(memberLabel(m), authState.getMemberImage(m.userId), 32)}
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-content truncate">{memberLabel(m)}</div>
                <div class="text-xs text-content-muted truncate">{m.email}</div>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </ScrollArea>

    <div class="flex items-center justify-between gap-3">
      <span class="text-xs text-content-muted">
        {selectedIds.length} selected{atCap ? ` (max ${MAX_GROUP_DM_OTHERS})` : ""}
      </span>
      <Button size="sm" onclick={handleCreate} disabled={!canCreate}>
        {creating ? "Starting..." : "Start group DM"}
      </Button>
    </div>
  </div>
{/snippet}

{#if open && viewportState.isMobile}
  <MobileSheet {open} title="New group DM" onclose={() => { if (creating) return; open = false; reset(); }}>
    <div class="pb-1">
      {@render picker("w-full rounded-[12px] border border-edge bg-surface px-3 py-2.5 text-base text-content outline-none")}
    </div>
  </MobileSheet>
{:else if open}
  <Dialog bind:open onOpenChange={(o) => { if (!o) { open = false; reset(); } }}>
    <DialogContent
      class="sm:max-w-[440px]"
      showCloseButton={true}
      escapeKeydownBehavior={creating ? "ignore" : "close"}
      interactOutsideBehavior={creating ? "ignore" : "close"}
    >
      <DialogHeader>
        <DialogTitle>New group DM</DialogTitle>
      </DialogHeader>
      <div class="py-2">
        {@render picker("w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content outline-none")}
      </div>
    </DialogContent>
  </Dialog>
{/if}
