<script lang="ts">
  import { agentStreamState } from "$lib/state/app.svelte.js";
  import PermissionCard from "./PermissionCard.svelte";
  import QuestionCard, { isAskUserQuestion } from "./QuestionCard.svelte";
  import { cn } from "$lib/utils.js";

  // Renders the answerable QuestionCard / PermissionCard for every pending
  // permission of an agent. Extracted from the agent detail page so the SAME
  // interactive cards can be mounted on other surfaces (e.g. the channel
  // sidebar) — a pending permission used to be answerable ONLY on the detail
  // page, so an agent @-mentioned in a channel would hang until the user knew
  // to navigate away to approve it (#648).
  let {
    agentId,
    class: className = "",
  }: {
    agentId: string;
    class?: string;
  } = $props();

  const pending = $derived(agentStreamState.getPendingPermissions(agentId));
</script>

{#if pending.length > 0}
  <div class={cn("space-y-2", className)}>
    {#each pending as perm (perm.id)}
      {#if isAskUserQuestion(perm)}
        <QuestionCard {agentId} request={perm} />
      {:else}
        <PermissionCard {agentId} request={perm} />
      {/if}
    {/each}
  </div>
{/if}
