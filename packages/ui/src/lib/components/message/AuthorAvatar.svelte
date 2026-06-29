<script lang="ts">
  // The avatar glyph for a message author (#507). One place for the
  // image | emoji | provider-glyph | initials decision that ChatMessage used to
  // inline, so the message row and any other message-author surface render the
  // same three-or-four branches.
  //
  // Resolution rules (identical to ChatMessage's old inline logic):
  //   webhook post → the card author's GitHub avatar (never the token owner's
  //                  face); falls back to the repo/bot NAME initials.
  //   human        → getMemberImage(fromId) (self → own photo, others → roster),
  //                  else initials of the display name.
  //   agent (cybo) → uploaded photo (URL) → image; emoji avatar → glyph;
  //                  no custom avatar → the provider/harness icon (Codex/…).
  //   slash result → a "provider:<id>" fromId carries no cybo row; render that
  //                  provider's icon.
  import Avatar from "../Avatar.svelte";
  import GitHubIcon from "../GitHubIcon.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import type { Message } from "$lib/types.js";
  import { authState, workspaceState } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { messageAuthor } from "./message-author.js";

  let {
    message,
    width = 36,
    fontSize = 14,
  }: {
    message: Message;
    width?: number;
    fontSize?: number;
  } = $props();

  const author = $derived(messageAuthor(message));
  const isAgent = $derived(author.type === "agent");

  // Agent (cybo / slash-command responder) identity from the roster: the
  // message's fromId is the responding cybo's id; AI-command service messages
  // attribute directly to the cybo id, while a spawned cybo's own channel
  // message (/ask) attributes to its agentId — map that back via the workspace
  // agent roster.
  const agentCybo = $derived.by(() => {
    if (!isAgent) return undefined;
    const byCyboId = cyboState.list?.find((c) => c.id === message.fromId);
    if (byCyboId) return byCyboId;
    const cyboId = workspaceState.agents?.find((a) => a.agentId === message.fromId)?.cyboId;
    return cyboId ? cyboState.list?.find((c) => c.id === cyboId) : undefined;
  });
  const agentEmojiAvatar = $derived(
    agentCybo?.avatar && /^\p{Extended_Pictographic}/u.test(agentCybo.avatar)
      ? agentCybo.avatar
      : null,
  );
  const avatarImage = $derived.by(() => {
    // Webhook posts carry their author image on the message itself (resolved by
    // messageAuthor); humans resolve through the single source of truth
    // getMemberImage(fromId); agents use their non-emoji custom avatar.
    if (message.source === "webhook") return author.image;
    if (!isAgent) return authState.getMemberImage(message.fromId);
    return agentCybo?.avatar && !agentEmojiAvatar ? agentCybo.avatar : null;
  });
  // Slash AI-command results attribute to the provider/model that ran, encoded as
  // a "provider:<id>" fromId (no cybo row); render that provider's icon.
  const serviceProvider = $derived(
    isAgent && message.fromId.startsWith("provider:")
      ? message.fromId.slice("provider:".length)
      : null,
  );
  const agentProviderIcon = $derived(
    serviceProvider ??
      (isAgent && !avatarImage && !agentEmojiAvatar ? (agentCybo?.provider ?? null) : null),
  );
  // GitHub webhook posts (release/PR/issue/CI cards) are GitHub-sourced and always
  // carry a synthesized `card`. When the real actor's GitHub avatar is present we
  // use it (image, below); otherwise show the GitHub brand mark — never the generic
  // repo-name initials. Gated on `card` so a plain-text webhook (no card, e.g. a
  // future non-GitHub integration) falls back to its own initials, not a GH mark.
  const githubMark = $derived(message.source === "webhook" && message.card != null && !avatarImage);
</script>

{#if githubMark}
  <span
    class="flex shrink-0 items-center justify-center rounded-[10px] bg-surface-alt text-content"
    style:width="{width}px"
    style:height="{width}px"
    aria-label="GitHub"
  >
    <GitHubIcon size={Math.round(width * 0.55)} />
  </span>
{:else if agentEmojiAvatar}
  <span
    class="flex shrink-0 items-center justify-center rounded-[10px] bg-surface-alt leading-none"
    style:width="{width}px"
    style:height="{width}px"
    style:font-size="{Math.round(width * 0.55)}px"
  >{agentEmojiAvatar}</span>
{:else if agentProviderIcon}
  <span
    class="flex shrink-0 items-center justify-center rounded-[10px] bg-surface-alt text-content"
    style:width="{width}px"
    style:height="{width}px"
  >
    <ProviderIcon provider={agentProviderIcon} size={Math.round(width * 0.55)} />
  </span>
{:else}
  <Avatar name={author.name} {width} {fontSize} image={avatarImage} borderRadius={10} />
{/if}
