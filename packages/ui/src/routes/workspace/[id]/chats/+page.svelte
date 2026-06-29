<script lang="ts">
  // Chats tab (mobile): the full channels + DMs + agents list as a screen,
  // instead of jumping straight into a single channel. Reuses ChannelSidebar
  // (channels, projects, Direct Messages, Agent DMs) — its handleChannelClick /
  // handleDmClick / handleAgentClick already navigate into the conversation.
  import ChannelSidebar from "$lib/components/channel/ChannelSidebar.svelte";
</script>

<div class="chats-screen h-full w-full overflow-hidden">
  <ChannelSidebar />
</div>

<style>
  /* ChannelSidebar is a fixed-width <aside> on desktop; let it fill the screen
     as a full-width list on the mobile Chats tab. */
  .chats-screen :global(aside) {
    width: 100% !important;
    max-width: none !important;
    border-right: 0 !important;
  }
</style>
