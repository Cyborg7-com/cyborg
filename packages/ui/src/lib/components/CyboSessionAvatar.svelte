<script lang="ts">
  // Identity glyph for an agent-session row (sidebar, session lists, menus).
  //
  // Resolves the session's CYBO identity from the agent row's denormalized
  // fields + the client roster (cybo-chat-identity.ts), so stale/failed
  // sessions — created before identity denorm existed, or whose spawn died
  // before any agent-state sync — still show the cybo's own photo/emoji/name
  // initials. Cybo sessions NEVER fall back to the Cyborg logo or the generic
  // provider/bot icon (ghost-identity fix, follow-up to #404); non-cybo
  // sessions keep their provider icon.
  import Avatar from "$lib/components/Avatar.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import { cyboState } from "$lib/state/app.svelte.js";
  import { sessionCyboIdentity, type ChatIdentityAgentRow } from "$lib/cybo-chat-identity.js";
  import { agentDisplayName, providerBrandColor } from "$lib/agent-display.js";

  let {
    agent,
    size = 14,
    radius = "50%",
    class: className = "",
  }: {
    agent: ChatIdentityAgentRow & { provider?: string | null; agentId?: string | null };
    size?: number;
    // Border radius for image/initials (lists use rounded-full, cards rounded boxes).
    radius?: string;
    class?: string;
  } = $props();

  const identity = $derived(sessionCyboIdentity(agent, cyboState.list));
  const name = $derived(
    identity.name ??
      agentDisplayName(
        { cyboId: agent.cyboId, cyboName: agent.cyboName, provider: agent.provider, agentId: agent.agentId },
        cyboState.list,
      ),
  );
  // Raw avatar string (image URL or emoji) for the cybo, fed to <Avatar avatar>
  // so the image | emoji | initials decision goes through the ONE shared
  // resolveAvatarSource rule instead of a per-surface branch. identity already
  // classified it via the same helper, so this round-trips identically; null
  // (no avatar) makes Avatar render the cybo's own initials.
  const cyboAvatar = $derived(identity.image ?? identity.emoji);
</script>

{#if identity.isCybo}
  <!-- One Avatar handles image | emoji | initials via the shared resolver; the
       placeholder identity is the CYBO's own (its name → initials), never the
       Cyborg logo / generic bot. -->
  <Avatar
    {name}
    avatar={cyboAvatar}
    width={size}
    fontSize={Math.max(8, Math.round(size * 0.45))}
    borderRadius={radius}
    class={className}
  />
{:else}
  <!-- Raw provider session (Claude/Codex/…): the bare glyph rendered black at
       avatar size reads as a messy asterisk. Put it in a soft brand-tinted tile
       with the brand-colored glyph (Claude coral, Codex green), sized to ~52% of
       the tile so it has breathing room. -->
  {@const brand = providerBrandColor(agent.provider) ?? "var(--text-muted)"}
  <span
    class={"inline-flex shrink-0 items-center justify-center " + className}
    style="width: {size}px; height: {size}px; border-radius: {radius}; background: color-mix(in srgb, {brand} 15%, var(--bg-base)); color: {brand};"
  >
    <ProviderIcon provider={agent.provider ?? "unknown"} size={Math.round(size * 0.52)} />
  </span>
{/if}
