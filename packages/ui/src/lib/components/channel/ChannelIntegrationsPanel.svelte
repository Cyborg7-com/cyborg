<script lang="ts">
  // Integrations tab: inbound Webhooks (#231). The channel AI-model override moved
  // to its own "AI" tab (ChannelAiPanel) so model config and external integrations
  // stay cleanly separated. `isAdmin` gates the management controls — every member
  // can see the endpoint + payload formats; only admins configure/manage.
  import ChannelWebhooksPanel from "./ChannelWebhooksPanel.svelte";
  import type { Channel } from "$lib/core/types.js";

  let { channel, isAdmin = true }: { channel: Channel; isAdmin?: boolean } = $props();
</script>

<ChannelWebhooksPanel {channel} {isAdmin} />
