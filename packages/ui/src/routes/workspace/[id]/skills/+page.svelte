<script lang="ts">
  import { page } from "$app/state";
  import SkillsPane from "$lib/components/panes/SkillsPane.svelte";

  const wsId = $derived(page.params.id ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <SkillsPane workspaceId={wsId} />
</div>
