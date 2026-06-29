<script lang="ts">
  import { untrack, onDestroy } from "svelte";
  import { isTauriIOS } from "$lib/mobile/push";
  import { formatSize } from "$lib/utils.js";
  import {
    register as registerNativeComposer,
    activate as activateNativeComposer,
    unregister as unregisterNativeComposer,
    isOwner as isNativeComposerOwner,
    setText as setNativeText,
    setHasPending as setNativeHasPending,
    setAttachments as setNativeAttachments,
    setNativeVisibility,
    blurInput as blurNativeInput,
    readComposerTheme,
    pushComposerTheme,
    type ComposerOwner,
    type NativeAttachment,
  } from "$lib/mobile/nativeComposer";
  import { sendMessage, sendTypingIndicator, client } from "$lib/state/app.svelte.js";
  import { channelState, workspaceState, fetchChannelMembers, fetchChannelCybos, fetchCybos, runCatchup, channelRosterState } from "$lib/state/app.svelte.js";
  import {
    applyMentionCap,
    channelMentionCandidates,
    type ChannelMentionScope,
  } from "$lib/channel-mention-candidates.js";
  import { visibleChannels } from "$lib/channel-visibility.js";
  import { throttle, cn } from "$lib/utils.js";
  import type { Attachment } from "$lib/types.js";
  import ComposerToolbar from "../composer/ComposerToolbar.svelte";
  import ComposerLinkModal from "../composer/ComposerLinkModal.svelte";
  import ComposerAttachments, { type PendingFile } from "../composer/ComposerAttachments.svelte";
  import ComposerVoiceRecorder from "../composer/ComposerVoiceRecorder.svelte";
  import EmojiPicker from "../composer/EmojiPicker.svelte";
  import { clickOutside } from "$lib/actions/clickOutside.js";
  import MentionAutocomplete, { type MentionCandidate } from "../composer/MentionAutocomplete.svelte";
  import MobileMentionList from "../composer/MobileMentionList.svelte";
  import MobileFormatToolbar from "../composer/MobileFormatToolbar.svelte";
  import MentionHighlightOverlay from "../composer/MentionHighlightOverlay.svelte";
  import MessageRenderer from "./MessageRenderer.svelte";
  import ScheduleSendDialog from "./ScheduleSendDialog.svelte";
  import SlashCommandMenu from "../composer/SlashCommandMenu.svelte";
  import {
    CHANNEL_SLASH_COMMANDS,
    describeCountAction,
    interpretCountArg,
    matchChannelSlashCommands,
    parseChannelSlashInput,
    detectSlashArgContext,
    type ChannelSlashCommand,
    type SlashArgContext,
  } from "../composer/slash-commands.js";
  import {
    extractSlashTriggerCandidate,
    suggestClosestTrigger,
  } from "../composer/slash-suggest.js";
  import { matchPromptTemplates } from "../composer/prompt-templates.js";
  import { promptTemplatesState } from "$lib/state/prompt-templates.svelte.js";
  import type { PromptTemplate } from "$lib/core/types.js";
  import { mentionToken, resolveMentions as resolveMentionsPure } from "$lib/resolve-mentions.js";
  import {
    bulletGlyphForDepth,
    continueList,
    indentSelectedListLines,
    isInsideCodeBlockAt,
    lineDepth,
    listShortcut,
  } from "$lib/composer-list-indent.js";
  import { applyMarkdown } from "$lib/composer-markdown.js";
  import { partitionFilesBySize } from "$lib/composer-attachment-validation.js";
  import { cyboState, daemonState } from "$lib/plugins/agents/state.svelte.js";
  import { PROVIDER_LABELS } from "$lib/agent-display.js";
  import { slashProgress, slashProgressLabel } from "$lib/state/slash-progress.svelte.js";
  import { lastPersistedMessage } from "$lib/last-persisted-message.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider,
  } from "$lib/components/ui/tooltip/index.js";
  import { searchShortcodes } from "$lib/emoji.js";
  import { fileToAttachment } from "$lib/media/attachment-upload.js";
  import { draftsState } from "$lib/drafts.svelte.js";
  import { dmState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { MAX_ATTACHMENT_BYTES } from "$lib/core/client.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";

  let {
    placeholder: customPlaceholder,
    onSend: customSend,
    alwaysEnabled = false,
    draftKey: customDraftKey,
    typingParentId,
    enableSlashCommands = false,
    composerHeight = $bindable(60),
  }: {
    placeholder?: string;
    onSend?: (text: string, mentions?: string[], attachments?: Attachment[]) => void;
    alwaysEnabled?: boolean;
    /** Channel composer only: '/' opens the channel slash-command menu and a
     *  registered '/command' submit dispatches cyborg:slash_command instead of
     *  a message. NOT for the DM/thread composers or agent slash commands. */
    enableSlashCommands?: boolean;
    /** Override the per-conversation draft key. Defaults to the active
     *  channel / DM peer. Pass an explicit key for sub-contexts that share a
     *  channel (e.g. a thread reply composer). */
    draftKey?: string;
    /** Thread-typing scope (#11 thread-typing): when set (e.g. the thread reply
     *  composer), typing events are tagged with this root id so receivers route
     *  the indicator to the open thread panel instead of the channel composer. */
    typingParentId?: string;
    /** Bindable live height (CSS px) of the native iOS composer pill, mirroring
     *  `nativeComposerHeight`. The page binds this to lift content above the
     *  rest-position pill. iOS-only; floors at 60 and stays 60 off iOS. */
    composerHeight?: number;
  } = $props();

  let text = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();
  let overlayScrollTop = $state(0);

  let emojiOpen = $state(false);
  let plusMenuOpen = $state(false);
  let linkModalOpen = $state(false);
  let linkInitialText = $state("");
  let pendingFiles = $state<PendingFile[]>([]);
  // In-flight upload cancellers keyed by pending-file id (#517). Kept OUTSIDE the
  // reactive state (an AbortController isn't render data) — removeFile aborts the
  // matching PUT so the × button cancels a mid-flight upload.
  const uploadControllers = new Map<string, AbortController>();
  // Base64 JPEG thumbnails (no data: prefix) keyed by pending-file id, used to
  // feed the native iOS attachment strip (Caveat #6 — the web preview is hidden
  // behind the native pill). Computed once per image file; non-images never get
  // an entry (Swift draws a type icon). iOS-only; stays empty elsewhere.
  let nativeThumbs = $state<Record<string, string>>({});
  // Live height (CSS px) of the native iOS composer pill, reported by Swift via
  // composer:height. Drives the hidden web composer's bottom spacer so the
  // message list shrinks as the pill grows (multi-line / attachment strip) and
  // stays pinned to the latest message instead of being occluded. Floor 60 = the
  // pill's base height (matches MobileFormatToolbar PILL_HEIGHT_BASE +
  // CyborgPushPlugin composerBaseHeight); only meaningful on iOS (hideWebChrome).
  let nativeComposerHeight = $state(60);
  // Mirror the live pill height out through the bindable `composerHeight` prop so
  // the page can lift its content above the (rest-position) pill. One-way:
  // nativeComposerHeight (driven by Swift's composer:height) → composerHeight.
  $effect(() => {
    composerHeight = nativeComposerHeight;
  });
  // Ids whose thumbnail is currently being generated, so the push effect
  // doesn't kick off the (async) canvas downscale more than once per file.
  const thumbInFlight = new Set<string>();
  let isDragOver = $state(false);
  let sendError = $state<string | null>(null);
  // Files rejected at pick time for exceeding MAX_ATTACHMENT_BYTES (Item: pre-pick
  // size warning). Surfaced as an inline, dismissible warning below the composer
  // so the user learns the file was skipped BEFORE an upload attempt. Cleared on
  // the next successful pick, on dismiss, or on send.
  let rejectedFiles = $state<{ name: string; size: number }[]>([]);
  // Markdown preview toggle (Item: Eye-icon preview). When true the textarea is
  // swapped for a rendered-markdown pane using the same renderer the message list
  // uses, so the user can proof complex markdown/code before sending. Opt-in,
  // off by default — the edit path is byte-for-byte unchanged when false.
  let showPreview = $state(false);
  // Id of the most recent local slash "no daemon" alert, so the next successful
  // dispatch (or a 30s TTL) can remove it instead of leaving it pinned (#210).
  let lastSlashAlertId: string | null = null;
  // Id of the most recent local slash arg-warning note ("count clamped", "text
  // ignored") — sender-only, never persisted; replaced on the next dispatch.
  let lastSlashWarnId: string | null = null;
  let isSending = $state(false);
  let voiceRecorder: ComposerVoiceRecorder | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();

  let dragCounter = 0;

  // ─── channel slash-command menu state ───
  // Active while the composer holds ONLY a command token ("/", "/sum…") — once
  // a space is typed (args) or the text stops matching, the menu closes.
  let slashIndex = $state(0);
  let slashDismissed = $state(false); // Escape mutes the menu until text changes
  const slashQuery = $derived.by(() => {
    if (!enableSlashCommands || slashDismissed) return null;
    const m = text.match(/^\/([a-z0-9-]*)$/i);
    return m ? m[1] : null;
  });
  const slashMatches = $derived(slashQuery !== null ? matchChannelSlashCommands(slashQuery) : []);

  // ─── prompt templates (#602 — secondary autocomplete group) ───
  // When the slash menu is open, the workspace's reusable composer templates are
  // offered as a SECOND group below the channel commands. Selecting one inserts
  // its BODY (not a "/name "), which the server expands on send. The rows come
  // from promptTemplatesState (loaded lazily when the menu first opens for a
  // workspace); the filter matches the same query as the commands.
  const slashTemplateMatches = $derived(
    slashQuery !== null ? matchPromptTemplates(slashQuery, promptTemplatesState.templates) : [],
  );
  // The combined nav order: channel commands FIRST, then templates, walked by a
  // single slashIndex. n = total rows across both groups.
  const slashTotalItems = $derived(slashMatches.length + slashTemplateMatches.length);
  const slashActive = $derived(slashTotalItems > 0);

  // The currently-applied template (set when one is inserted from the menu).
  // Cleared whenever the composer text stops matching the inserted body, so a
  // user who edits the body away from the template doesn't get a stale expand
  // flag. Drives the expandTemplate flag passed to the server on send.
  let appliedTemplate = $state<{ id: string; body: string } | null>(null);

  // Lazily load the workspace's templates the first time the slash menu opens for
  // this workspace, so the secondary group is populated without a fetch on every
  // keystroke (promptTemplatesState.load is a no-op when already loaded).
  $effect(() => {
    if (!enableSlashCommands || slashQuery === null) return;
    const wsId = workspaceState.current?.id;
    if (wsId) void promptTemplatesState.load(wsId);
  });

  // Insert a template's BODY into the composer (replacing the "/query" token) and
  // flag the send for server-side expansion. Mirrors selectSlashCommand's focus
  // handling. The body may contain {channel}/{user}/{date}; the server fills them
  // in on send with the final context.
  function selectSlashTemplate(template: PromptTemplate): void {
    text = template.body;
    appliedTemplate = { id: template.id, body: template.body };
    slashIndex = 0;
    requestAnimationFrame(() => {
      if (!textarea) return;
      const pos = text.length;
      textarea.selectionStart = pos;
      textarea.selectionEnd = pos;
      textarea.focus();
      caretPos = pos;
      autoResize();
    });
  }

  // Select the row at the combined index: the first slashMatches.length rows are
  // commands; the rest are templates.
  function selectSlashItemAt(index: number): void {
    if (index < slashMatches.length) {
      selectSlashCommand(slashMatches[index]);
    } else {
      selectSlashTemplate(slashTemplateMatches[index - slashMatches.length]);
    }
  }

  // ─── slash-command ARGUMENT autocomplete (Item: scaffold args) ───
  // Caret position last seen by the input pipeline (mirrors detectMention's
  // source: native pill caret on iOS, else the textarea). Drives the slash-arg
  // context detection without re-reading the DOM in a derived.
  let caretPos = $state(0);
  // Active first-arg context ("/summarize 5", "/ask @cy") when slash commands
  // are enabled and the menu itself is closed (a fully-typed "/cmd " already has
  // a space, so slashQuery is null and slashActive is false → no overlap).
  const slashArgContext = $derived.by((): SlashArgContext | null => {
    if (!enableSlashCommands || slashDismissed) return null;
    return detectSlashArgContext(text, caretPos);
  });
  // Static-option suggestions (counts / languages) for the current arg context,
  // filtered by the partial token. The "cybo" source routes through the existing
  // @mention autocomplete instead (kind:"agent"), so it's excluded here.
  const slashArgOptions = $derived.by(() => {
    const ctx = slashArgContext;
    if (!ctx || ctx.arg.source === "cybo" || !ctx.arg.options) return [];
    const q = ctx.query.toLowerCase();
    return ctx.arg.options.filter((o) => !q || (o.label ?? o.value).toLowerCase().startsWith(q));
  });
  let slashArgIndex = $state(0);
  // The cybo-target picker is active when the arg spec asks for a cybo AND the
  // user has typed (or is about to type) the "@" prefix — gates the agent-only
  // branch in mentionCandidates so it's data-driven off the registry.
  const slashCyboArgActive = $derived(slashArgContext?.arg.source === "cybo");

  function selectSlashArgOption(value: string): void {
    const ctx = slashArgContext;
    if (!ctx || !textarea) return;
    const trailing = ctx.arg.trailing ?? " ";
    const before = text.slice(0, ctx.start);
    const after = text.slice(caretPos);
    text = before + value + trailing + after;
    const pos = before.length + value.length + trailing.length;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = pos;
      textarea.selectionEnd = pos;
      textarea.focus();
      caretPos = pos;
      autoResize();
    });
  }

  // (B) Run-target hint: while composing a registered channel slash command
  // (menu-open OR typing args), surface the provider/model it will run on —
  // the workspace's configured slash model, or "auto" when none is pinned.
  // The model a slash command will actually run on, mirroring the dispatcher's
  // precedence: per-CHANNEL override (channels.slash_command_model) > WORKSPACE
  // default > auto. Reads the channel from the store, so it updates as soon as the
  // override is saved (ChannelAiPanel → applyChannelSlashModel).
  const effectiveSlashModel = $derived.by(() => {
    const activeChannel = workspaceState.channels.find((c) => c.id === channelState.activeId);
    return activeChannel?.slashCommandModel ?? daemonState.slashCommandModel ?? null;
  });

  // Fully-typed registered command ("/summarize" or "/summarize <args>") —
  // null otherwise. Drives the run-target pill + the arg hint/echo strip.
  const slashParsed = $derived(enableSlashCommands ? parseChannelSlashInput(text) : null);

  const slashRunTarget = $derived.by(() => {
    if (!slashParsed) return null;
    const sel = effectiveSlashModel;
    return sel ? `${PROVIDER_LABELS[sel.provider] ?? sel.provider} / ${sel.model}` : "auto";
  });

  // (1.b) Live interpretation echo for count commands: how the server will
  // read the args ("/summarize 10 focus on bugs" → last 10 messages, the
  // trailing text is dropped). null for commands without count semantics.
  const slashCountEcho = $derived(
    slashParsed ? interpretCountArg(slashParsed.args, slashParsed.command) : null,
  );

  function selectSlashCommand(cmd: ChannelSlashCommand): void {
    text = `/${cmd.trigger} `;
    slashIndex = 0;
    requestAnimationFrame(() => textarea?.focus());
  }

  // ─── unknown-trigger guard ───
  // "/sumarize 10" (typo) parses as NO registered command and used to post as a
  // plain channel message — public noise. submit() blocks it and shows this
  // banner instead; "Send as text" is the explicit escape hatch.
  let unknownSlash = $state<{ trigger: string; suggestion: string | null } | null>(null);
  let bypassUnknownSlashGuard = false; // one-shot, set only by sendUnknownAsText()

  async function sendUnknownAsText(): Promise<void> {
    unknownSlash = null;
    bypassUnknownSlashGuard = true;
    try {
      await submit();
    } finally {
      bypassUnknownSlashGuard = false;
    }
  }

  function dismissUnknownSlash(): void {
    unknownSlash = null;
    textarea?.focus();
  }

  // True → the text is an UNREGISTERED "/word" command and the banner was
  // raised (submit must bail). Text that merely starts with "/" but doesn't
  // look like a command ("/etc/hosts", "/ hi", "//cdn") is not blocked.
  function blockUnknownSlash(slash: unknown, trimmed: string): boolean {
    if (slash || bypassUnknownSlashGuard) return false;
    const candidate = extractSlashTriggerCandidate(trimmed);
    if (!candidate) return false;
    unknownSlash = {
      trigger: candidate,
      suggestion: suggestClosestTrigger(
        candidate,
        CHANNEL_SLASH_COMMANDS.map((c) => c.trigger),
      ),
    };
    return true;
  }

  // ─── @mention / #channel autocomplete state ───
  let mentionActive = $state(false);
  let mentionMode = $state<"user" | "channel" | "emoji">("user");
  let mentionQuery = $state("");
  let mentionStart = $state(0); // index of the '@', '#', or ':' in `text`
  let mentionIndex = $state(0);
  // Human mentions the user explicitly picked, mapped to userId for resolution.
  let selectedMentions = $state<{ userId: string; label: string }[]>([]);

  function headingForMode(mode: "user" | "channel" | "emoji"): string {
    if (mode === "channel") return "Channels";
    if (mode === "emoji") return "Emoji";
    return "Members";
  }
  const mentionHeading = $derived(headingForMode(mentionMode));

  // Channel-scoped mention roster: WHO is actually in this channel (humans +
  // cybos), the same PG truth the Members tab reads (fetch_channel_members /
  // fetch_channel_cybos). Scoped only for a CHANNEL or THREAD composer (both
  // share channelState.activeId); a DM composer (neither enableSlashCommands
  // nor typingParentId) stays null → workspace-wide, unchanged. Loaded
  // best-effort: if the human-member fetch fails (legacy relay), the roster
  // stays null and the candidate list falls back to workspace-wide so mentions
  // never break — same degradation the Members dialog already uses.
  const mentionChannelId = $derived(
    enableSlashCommands || typingParentId != null ? channelState.activeId : null,
  );
  let mentionRoster = $state<{ channelId: string; scope: ChannelMentionScope } | null>(null);
  $effect(() => {
    const chId = mentionChannelId;
    // #630: re-run when this channel's roster is bumped (a member/cybo was
    // added/removed) so the @-autocomplete roster refreshes live, no reload.
    channelRosterState.versionOf(chId);
    if (!chId) {
      mentionRoster = null;
      return;
    }
    let active = true;
    void (async () => {
      // Human membership is the gate (well-established endpoint); cybo
      // membership is best-effort within it (empty if unavailable → matches the
      // Members tab showing no cybos there).
      let members: { userId: string }[];
      try {
        members = await fetchChannelMembers(chId);
      } catch {
        if (active && mentionChannelId === chId) mentionRoster = null;
        return;
      }
      const cyboIds = await fetchChannelCybos(chId).catch(() => [] as string[]);
      if (!active || mentionChannelId !== chId) return;
      // A channel-member cybo created in another session (post-#413, written
      // straight to PG) may not be in THIS client's roster yet — the scope
      // would then resolve it to nothing (a member silently missing from @).
      // Refresh the roster once if any channel cybo is unknown locally, exactly
      // as the Members dialog does on open.
      if (cyboIds.some((id) => !cyboState.list.some((c) => c.id === id))) {
        await fetchCybos();
        if (!active || mentionChannelId !== chId) return;
      }
      mentionRoster = {
        channelId: chId,
        scope: {
          userIds: new Set(members.map((m) => m.userId)),
          cyboIds: new Set(cyboIds),
        },
      };
    })();
    return () => {
      active = false;
    };
  });
  // The scope to apply RIGHT NOW: only when the loaded roster matches the
  // current channel (a stale load from the previous channel must not leak).
  const mentionScope = $derived(
    mentionChannelId && mentionRoster?.channelId === mentionChannelId ? mentionRoster.scope : null,
  );

  const mentionCandidates = $derived.by((): MentionCandidate[] => {
    if (!mentionActive) return [];
    const q = mentionQuery.toLowerCase();

    if (mentionMode === "emoji") {
      return searchShortcodes(q, 8).map((s) => ({
        id: s.code,
        label: `:${s.code}:`,
        emoji: s.emoji,
        kind: "emoji" as const,
      }));
    }

    if (mentionMode === "channel") {
      // #608: group DMs are hidden group_dm channels — they are not #-mentionable
      // and must never surface in channel autocomplete. Filter them out.
      return visibleChannels(workspaceState.channels)
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ id: c.id, label: c.name, kind: "channel" as const }));
    }

    // /ask @cybo — the target argument autocompletes to cybos ONLY (Mattermost
    // dynamic-argument model). Now driven by the slash-command registry's
    // arg.source === "cybo" spec (see slashCyboArgActive) instead of a hardcoded
    // "/ask" test, so adding another cybo-target command needs no composer edit.
    // Insert the slug as the token so the server resolves it unambiguously
    // (names may contain spaces). Filter against the arg query (after the "@"),
    // not the generic mention query.
    if (slashCyboArgActive && slashArgContext) {
      const aq = slashArgContext.query.toLowerCase();
      return cyboState.list
        .filter((c) => !aq || c.slug.toLowerCase().includes(aq) || c.name.toLowerCase().includes(aq))
        .map((c) => ({
          id: `cybo:${c.id}`,
          label: c.slug,
          sublabel: c.name,
          kind: "agent" as const,
        }))
        .slice(0, 8);
    }

    // @everyone pinned first (Slack-parity), then humans, then agents (cybos).
    const everyone: MentionCandidate[] =
      q === "" || "everyone".startsWith(q)
        ? [{ id: "__everyone__", label: "everyone", sublabel: "Notify the channel", kind: "everyone" as const }]
        : [];
    // Humans + cybos, CHANNEL-SCOPED to the Members-tab truth (mentionScope);
    // workspace-wide only when unscoped (DM / roster not loaded). This is what
    // stops the composer offering workspace members who aren't in the channel.
    const { humans, agents } = channelMentionCandidates({
      query: q,
      members: workspaceState.members,
      cybos: cyboState.list,
      scope: mentionScope,
    });
    // Cap the merged list so agents survive even when humans fill it — a flat
    // `.slice(0, 8)` was consumed by humans, so agents (cybos) never appeared
    // once the channel had >7 humans. Shared pure policy (everyone → humans →
    // agents, agent slots reserved), unit-tested in channel-mention-candidates.test.ts.
    return applyMentionCap<MentionCandidate>(everyone, humans, agents);
  });

  // Keep the highlighted row valid as the filtered list shrinks.
  // Clamp the highlighted autocomplete row when the candidate list shrinks.
  // Guard on `length > 0`: with an empty list `mentionIndex >= 0` is always
  // true, so writing `0` re-satisfies the condition and the effect loops
  // forever (effect_update_depth_exceeded), freezing the composer.
  $effect(() => {
    if (mentionCandidates.length > 0 && mentionIndex >= mentionCandidates.length) {
      mentionIndex = mentionCandidates.length - 1;
    }
  });

  // Keep the slash-arg highlighted row valid as its option list shrinks. Same
  // `length > 0` guard as the mention clamp above to avoid an effect loop.
  $effect(() => {
    if (slashArgOptions.length > 0 && slashArgIndex >= slashArgOptions.length) {
      slashArgIndex = slashArgOptions.length - 1;
    }
  });

  // mentionToken lives in $lib/resolve-mentions.ts (shared with the resolver).

  // ─── Per-channel / per-DM drafts (v1: initialText/onTextChange parity) ───
  // Key the draft to the active conversation so unsent text + pending
  // attachments survive a channel/DM switch and restore on return. An explicit
  // `draftKey` prop wins (used by sub-composers like thread replies that share
  // a channel); otherwise derive from the active DM peer or channel.
  const draftKey = $derived(
    customDraftKey ??
      (dmState.activePeerId ? `dm:${dmState.activePeerId}` : null) ??
      (channelState.activeId ? `channel:${channelState.activeId}` : null),
  );

  // True once the editor has been touched for the current key — guards the
  // hydration effect from clobbering live typing (v1's hydratedRef pattern).
  let loadedKey = $state<string | null>(null);

  // Load the saved draft whenever the conversation changes. The body runs in
  // `untrack` so the only reactive dependency is `draftKey` — without this the
  // effect also subscribes to the drafts store and `loadedKey`, and the persist
  // effect below (which writes the store from `text`) closes a read/write cycle
  // → effect_update_depth_exceeded, which freezes the composer after one keystroke.
  $effect(() => {
    const key = draftKey;
    untrack(() => {
      if (key === loadedKey) return;
      loadedKey = key;
      const draft = key ? draftsState.get(key) : undefined;
      text = draft?.text ?? "";
      pendingFiles = draft?.files ?? [];
      // Reset transient per-conversation UI so it doesn't leak across a
      // channel/thread switch: the preview pane and the pre-pick size-warning
      // are tied to the conversation that opened them, not the new one.
      showPreview = false;
      rejectedFiles = [];
      requestAnimationFrame(autoResize);
    });
  });

  // Auto-focus the composer once per conversation open (Slack/WhatsApp parity;
  // v1 did this via TipTap `autofocus: 'end'` on a per-channelId-keyed mount —
  // MessageComposer.tsx:507 + key={channelId}). Keyed off draftKey so it fires
  // once per channel/DM/thread open. untrack the body so this effect's only
  // reactive dep is draftKey — it must NOT transitively track text/drafts state
  // (mirrors the hydration effect above) and must NOT poke the page-level
  // conversation effects that own the unread-cursor freeze.
  let focusedKey = $state<string | null>(null);
  $effect(() => {
    const key = draftKey;
    untrack(() => {
      if (key == null || key === focusedKey) return;
      focusedKey = key;
      // Don't pop the keyboard on touch devices (Slack/iOS behavior).
      if (viewportState.isMobile) return;
      // Don't steal focus from search or another field the user is in.
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        active !== textarea &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      if (disabled) return; // channel composer is disabled until a channel is active
      // Focus after the textarea has mounted/painted; place caret at end of any
      // restored draft (matches v1 'end').
      requestAnimationFrame(() => {
        if (!textarea) return;
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    });
  });

  // Persist on every change for the current key. The `text`/`pendingFiles`
  // reads register the dependency; the key read pins it to the right slot.
  $effect(() => {
    const key = draftKey;
    // Touch deps so this effect re-runs on edits.
    const t = text;
    const files = pendingFiles;
    if (!key || key !== loadedKey) return;
    // `save()` does `this.drafts = { ...this.drafts, ... }` — that spread READS
    // the reactive store inside this effect's tracking scope, so without untrack
    // the effect both reads and writes `drafts` → effect_update_depth_exceeded,
    // which freezes the composer after the first keystroke. untrack the write so
    // the effect depends only on text/files/key, not the store's contents.
    untrack(() => draftsState.save(key, { text: t, files }));
  });

  // True when a typed handle resolves to a real workspace member or agent —
  // drives the live blue highlight in the composer (v1 TipTap Mention parity).
  function isKnownMention(label: string): boolean {
    if (label === "everyone") return true;
    const lower = label.toLowerCase();
    const member = workspaceState.members.some(
      (m) =>
        m.membershipType === "active" &&
        (m.name?.toLowerCase() === lower ||
          m.email.toLowerCase() === lower ||
          m.email.split("@")[0].toLowerCase() === lower),
    );
    if (member) return true;
    return cyboState.list.some((c) => c.name.toLowerCase() === lower);
  }

  // After typing, see if the caret sits inside an `@query` or `#query` token.
  function detectMention(): void {
    // On iOS the native pill owns input, so the hidden textarea's
    // selectionStart is stale — use the caret the native pill last reported.
    const useNative = nativeChromeHidden() && nativeCaret >= 0;
    if (!useNative && !textarea) return;
    const caret = useNative ? nativeCaret : textarea!.selectionStart;
    // Mirror the caret for the slash-arg context detector (separate from the
    // @mention token logic below). Kept in sync on every keyup/click/input.
    caretPos = caret;
    const upto = text.slice(0, caret);
    const at = upto.match(/(?:^|\s)@([\w-]*)$/);
    const hash = upto.match(/(?:^|\s)#([\w-]*)$/);
    const colon = upto.match(/(?:^|\s):([a-z0-9_+-]{2,})$/);
    if (at) {
      mentionMode = "user";
      mentionQuery = at[1];
      mentionStart = caret - at[1].length - 1;
      if (!mentionActive) mentionIndex = 0;
      mentionActive = true;
    } else if (hash) {
      mentionMode = "channel";
      mentionQuery = hash[1];
      mentionStart = caret - hash[1].length - 1;
      if (!mentionActive) mentionIndex = 0;
      mentionActive = true;
    } else if (colon) {
      mentionMode = "emoji";
      mentionQuery = colon[1];
      mentionStart = caret - colon[1].length - 1;
      if (!mentionActive) mentionIndex = 0;
      mentionActive = true;
    } else {
      mentionActive = false;
    }
  }

  function selectMention(item: MentionCandidate): void {
    // On iOS the native pill owns input; the hidden textarea isn't focused so
    // its selectionStart is stale — slice off the native caret and push the
    // result back into the pill instead of repositioning the textarea.
    const useNative = nativeChromeHidden() && nativeCaret >= 0;
    if (!useNative && !textarea) return;
    let token: string;
    if (item.kind === "emoji") token = item.emoji ?? "";
    else if (item.kind === "channel") token = `#${item.label}`;
    else if (item.kind === "everyone") token = "@everyone";
    else token = mentionToken(item.label); // human/agent → @name or @[Full Name]

    const before = text.slice(0, mentionStart);
    const after = text.slice(useNative ? nativeCaret : textarea!.selectionStart);
    const insert = `${token} `;
    text = before + insert + after;

    // Only humans resolve to a userId for notification targeting. Dedup by
    // userId AND label so a visible `@Label` token resolves to a single user.
    if (item.kind === "human") {
      const labelLower = item.label.toLowerCase();
      selectedMentions = [
        ...selectedMentions.filter(
          (s) => s.userId !== item.id && s.label.toLowerCase() !== labelLower,
        ),
        { userId: item.id, label: item.label },
      ];
    }

    mentionActive = false;
    const caret = before.length + insert.length;
    if (useNative) {
      // Push text + caret into the native pill; Swift owns the keyboard/focus,
      // and suppress the text→native mirror so this explicit setText isn't
      // double-fired by the reactive `text` effect.
      nativeCaret = caret;
      suppressNativeTextMirror = true;
      void setNativeText(text, caret);
      queueMicrotask(() => {
        suppressNativeTextMirror = false;
      });
      return;
    }
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = caret;
      textarea.selectionEnd = caret;
      textarea.focus();
      autoResize();
    });
  }

  // Resolve the message text to mentioned ids (extracted to
  // $lib/resolve-mentions.ts for testability): explicit picks + hand-typed
  // handles, members first, then cybos by name/slug → cybo:<id> (P1 fix —
  // hand-typed cybo mentions used to resolve only via an autocomplete pick).
  function resolveMentions(input: string): string[] {
    return resolveMentionsPure(input, {
      selectedMentions,
      members: workspaceState.members,
      cybos: cyboState.list,
    });
  }

  const throttledTyping = throttle(() => sendTypingIndicator(typingParentId), 3000);
  const channelName = $derived(workspaceState.activeChannel?.name ?? "channel");
  const placeholderText = $derived(customPlaceholder ?? `Message #${channelName}`);
  const disabled = $derived(!alwaysEnabled && !channelState.activeId);
  const hasContent = $derived(text.trim().length > 0 || pendingFiles.length > 0);
  const isRecording = $derived(voiceRecorder?.getIsRecording() ?? false);

  // ─── #607 Schedule send ───
  // The send-later affordance applies to top-level channel/DM messages only —
  // NOT thread replies (typingParentId set) or the agent composer. The target
  // mirrors the contract's EXACTLY-ONE-of rule: a channel when one is active,
  // otherwise the open DM peer. null = no schedule affordance for this composer.
  const scheduleTarget = $derived.by((): { channelId: string } | { toId: string } | null => {
    if (typingParentId != null) return null; // thread reply
    if (channelState.activeId) return { channelId: channelState.activeId };
    if (dmState.activePeerId) return { toId: dmState.activePeerId };
    return null;
  });
  // Human label for the target, shown in the dialog ("#general" / a peer name).
  const scheduleTargetLabel = $derived.by((): string => {
    const t = scheduleTarget;
    if (!t) return "";
    if ("channelId" in t) return `#${channelName}`;
    const peer = workspaceState.members.find((m) => m.userId === t.toId);
    return peer?.name ?? peer?.email?.split("@")[0] ?? "this conversation";
  });
  // Only humans schedule, and only when there's text — no scheduling pending
  // attachments alone (the contract carries text, not attachments).
  const canSchedule = $derived(scheduleTarget !== null && text.trim().length > 0);

  // Send-later (#607) is intentionally HIDDEN from the composer (product
  // decision). This is a deliberate, reversible UI hide — not a removal: the
  // clock affordance below is gated off, but ALL scheduling code (this dialog,
  // openScheduleDialog, the schedule_message_* RPCs, ScheduleSendDialog) stays
  // intact. Flip to `true` to restore the affordance.
  const SHOW_SCHEDULE_SEND = false;

  let scheduleDialogOpen = $state(false);
  // Snapshot of the draft taken when the dialog opens, so editing the composer
  // behind the modal doesn't change what gets scheduled.
  let scheduledText = $state("");
  let scheduledMentions = $state<string[]>([]);

  function openScheduleDialog(): void {
    const trimmed = text.trim();
    if (!canSchedule || !trimmed) return;
    scheduledText = trimmed;
    const m = resolveMentions(trimmed);
    scheduledMentions = m;
    scheduleDialogOpen = true;
  }

  // After a successful schedule, clear the composer like a normal send does.
  function afterScheduled(): void {
    selectedMentions = [];
    mentionActive = false;
    showPreview = false;
    text = "";
    if (draftKey) draftsState.clear(draftKey);
    if (textarea) {
      textarea.style.height = "auto";
      if (!nativeChromeHidden()) textarea.focus();
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    // ⌘/Ctrl formatting shortcuts (v1 TipTap-native parity): B = bold, I =
    // italic, K = link modal. Run before mention nav — those use arrows /
    // Enter / Tab / Escape, so there's no key conflict.
    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); toggleBold(); return; }
      if (k === "i") { e.preventDefault(); toggleItalic(); return; }
      if (k === "k") { e.preventDefault(); openLinkModal(); return; }
    }
    if (slashActive) {
      // #602 — nav spans BOTH groups (commands then templates) via one index.
      const n = slashTotalItems;
      if (e.key === "ArrowDown") { e.preventDefault(); slashIndex = (slashIndex + 1) % n; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashIndex = (slashIndex - 1 + n) % n; return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSlashItemAt(Math.min(slashIndex, n - 1));
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); slashDismissed = true; return; }
    }
    if (mentionActive && mentionCandidates.length > 0) {
      const n = mentionCandidates.length;
      if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % n; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + n) % n; return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mentionCandidates[Math.min(mentionIndex, n - 1)]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); mentionActive = false; return; }
    }
    // Static-option slash-arg popup (counts/languages). The cybo arg goes through
    // the @mention branch above; this only fires for non-cybo arg specs.
    if (slashArgOptions.length > 0) {
      const n = slashArgOptions.length;
      const highlighted = slashArgOptions[Math.min(slashArgIndex, n - 1)];
      if (e.key === "ArrowDown") { e.preventDefault(); slashArgIndex = (slashArgIndex + 1) % n; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashArgIndex = (slashArgIndex - 1 + n) % n; return; }
      // When the typed arg already EXACTLY equals the highlighted option's value
      // the popup is just echoing what's typed, so re-selecting it (append a
      // space) would force a double-Enter to actually send. Let Enter fall
      // through to submit in that case. A partial/prefix match still selects
      // (completes the token). Tab always completes, never submits.
      const typedArg = slashArgContext?.query ?? "";
      const isExactMatch =
        !e.shiftKey && typedArg.toLowerCase() === highlighted.value.toLowerCase();
      if ((e.key === "Enter" && !isExactMatch) || e.key === "Tab") {
        e.preventDefault();
        selectSlashArgOption(highlighted.value);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); slashDismissed = true; return; }
    }
    handleListKeys(e);
  }

  // Enter / Shift+Enter / Space list behavior, split out of handleKeydown to
  // keep that function's branching under the complexity budget.
  function handleListKeys(e: KeyboardEvent): void {
    // Tab / Shift+Tab on a list line indents / outdents it one level
    // (Mattermost parity). Web/desktop only — the iOS native pill has no Tab key.
    // Runs AFTER handleKeydown's popup Tab-guards (slash menu / mention /
    // slash-arg) have already returned, so it never steals their Tab. On a
    // NON-list line it does nothing and lets Tab keep its default focus-move
    // behavior (keyboard accessibility) — we don't trap Tab in the textarea.
    // Only a PLAIN Tab / Shift+Tab is handled — Ctrl/Cmd/Alt+Tab (browser/OS
    // tab switching) keep their default behavior (the modifier guard skips us).
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (tryIndentList(e.shiftKey ? -1 : 1)) {
        e.preventDefault();
        return;
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // List continuation (Slack parity): Enter at the end of a list item
      // continues the list; Enter on an empty item exits it instead of sending.
      if (tryContinueList()) return;
      submit();
      return;
    }
    // Shift+Enter inside a list = continue the list (Slack parity). v1 ran
    // splitListItem on Shift+Enter; a second Shift+Enter on the now-empty
    // bullet lifted it back to a plain line. tryContinueList() does both:
    // it inserts the next marker when the item has content, and strips the
    // marker (exiting the list) when the item is empty. Outside a list,
    // Shift+Enter falls through to the textarea default (plain newline).
    if (e.key === "Enter" && e.shiftKey) {
      if (tryContinueList()) e.preventDefault();
      return;
    }
    // Markdown list shortcut (Slack parity): typing a space right after a
    // line that is just "- "/"* "/"+ " or "1."–"999." converts that line
    // into a list line. v1 only fired this AFTER a hardBreak (Shift+Enter),
    // because TipTap's native input rule already handled the first line;
    // here there is no native rule, so we handle the start of ANY line.
    // ASCII smiley → emoji on space (Slack parity): ":D " becomes "😄 ". Tried
    // before the list shortcut; the two can never match the same token.
    if (e.key === " " && tryAsciiEmoji()) { e.preventDefault(); return; }
    if (e.key === " " && tryListShortcut()) e.preventDefault();
  }

  // ASCII-smiley shortcuts (Slack parity). Order matters: more-specific tokens
  // (">:(" , ":-)") precede the ones they could be confused with so the loop's
  // first endsWith() match wins.
  const ASCII_EMOJI: ReadonlyArray<readonly [string, string]> = [
    [":'(", "😢"], [">:(", "😠"],
    [":-)", "🙂"], [":)", "🙂"],
    [":-(", "🙁"], [":(", "🙁"],
    [":-D", "😄"], [":D", "😄"],
    [";-)", "😉"], [";)", "😉"],
    [":-P", "😛"], [":P", "😛"], [":-p", "😛"], [":p", "😛"],
    [":-O", "😮"], [":O", "😮"], [":-o", "😮"], [":o", "😮"],
    [":-/", "😕"], [":/", "😕"],
    [":-|", "😐"], [":|", "😐"],
    ["8-)", "😎"], ["8)", "😎"],
    ["<3", "❤️"],
  ];

  // If the text just before the caret is a standalone ASCII smiley, replace it
  // with its emoji + the space the user pressed. Returns true if it fired (the
  // caller preventDefaults the space). Mirrors tryListShortcut's caret dance.
  function tryAsciiEmoji(): boolean {
    if (!textarea) return false;
    if (textarea.selectionStart !== textarea.selectionEnd) return false;
    if (mentionActive || slashActive) return false;
    const caret = textarea.selectionStart;
    const before = text.slice(0, caret);
    for (const [token, emoji] of ASCII_EMOJI) {
      if (!before.endsWith(token)) continue;
      const start = caret - token.length;
      // Standalone token only: preceded by start-of-text or whitespace. This
      // also protects URLs ("http:/" → the ":" is preceded by a letter).
      const prev = start > 0 ? before[start - 1] : "";
      if (prev !== "" && !/\s/.test(prev)) continue;
      // Don't fire inside a fenced code block (parity with the list shortcut).
      const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
      if (isInsideCodeBlock(lineStart)) return false;
      text = text.slice(0, start) + emoji + " " + text.slice(caret);
      const pos = start + emoji.length + 1;
      requestAnimationFrame(() => {
        if (!textarea) return;
        textarea.selectionStart = pos;
        textarea.selectionEnd = pos;
        autoResize();
      });
      return true;
    }
    return false;
  }

  // Convert the current line into a list line when it consists solely of a
  // markdown marker ("-", "*", "+", or "1."–"999.") about to be followed by
  // the space the user just pressed. Returns true if it converted (and the
  // caller should preventDefault the space). Matches v1's edge cases:
  // empty selection only; skip if already in a list (don't double-nest);
  // skip inside a fenced ``` code block; 1–3 digit ordered markers; the
  // marker must be the whole line up to the caret; never fire while an
  // autocomplete popup is open.
  function tryListShortcut(): boolean {
    if (!textarea) return false;
    // Only on a collapsed caret (no selection), and never while a popup is up.
    if (textarea.selectionStart !== textarea.selectionEnd) return false;
    if (mentionActive) return false;

    // Pure core: convert a bare "-"/"*"/"+"/"N." line into a list line. Handles
    // the marker match + fenced-code-block gate + "• " normalization.
    const result = listShortcut(text, textarea.selectionStart);
    if (!result) return false;
    text = result.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = result.caret;
      textarea.selectionEnd = result.caret;
      autoResize();
    });
    return true;
  }

  // True if the line at `lineStart` sits inside an open ``` fenced code block.
  // Delegates to the shared detector in composer-list-indent.ts so the web list
  // shortcuts, the ASCII-emoji shortcut, and the indent maths all agree.
  function isInsideCodeBlock(lineStart: number): boolean {
    return isInsideCodeBlockAt(text, lineStart);
  }

  // Returns true if it handled the Enter (continued or exited a list).
  function tryContinueList(): boolean {
    if (!textarea) return false;
    // Pure core: continue the list (next marker / depth glyph) or exit it (empty
    // item drops the marker). Returns null when the caret isn't at a list-line end.
    const result = continueList(text, textarea.selectionStart);
    if (!result) return false;
    text = result.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = result.caret;
      textarea.selectionEnd = result.caret;
      autoResize();
    });
    return true;
  }

  // Thin web wrapper over the pure indentSelectedListLines helper: read the
  // textarea selection, apply the indent/outdent, write `text`, and reposition
  // the selection after the reactive update (same requestAnimationFrame + caret +
  // autoResize dance as tryContinueList/tryAsciiEmoji). Returns true if anything
  // changed (caller preventDefaults Tab); false → let Tab move focus (a11y).
  function tryIndentList(dir: 1 | -1): boolean {
    if (!textarea) return false;
    const result = indentSelectedListLines(text, textarea.selectionStart, textarea.selectionEnd, dir);
    if (!result) return false;
    text = result.text;
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.selectionStart = result.selStart;
      textarea.selectionEnd = result.selEnd;
      autoResize();
    });
    return true;
  }

  // ─── iOS native-pill markdown authoring (Caveat #6) ───────────────────────
  // The web list shortcuts above are driven by the hidden textarea's keydown +
  // selection, which never fire on the native iOS pill (keystrokes go to UIKit).
  // These variants run on (text, caret) AFTER the keystroke is already in the
  // mirrored text (the POST-insertion model) and push the result back via
  // setNativeText. They REUSE the shared isInsideCodeBlockAt / bulletGlyphForDepth
  // / lineDepth from composer-list-indent.ts (same fence + depth-glyph rules as
  // the web continueList/listShortcut cores) so the native pill stays in lockstep
  // with the web/render output; the web/desktop/Android path is byte-for-byte
  // unchanged. Returns the new {text, caret} or null when nothing applies.

  // A space was just typed at caret-1. If the line so far is exactly a markdown
  // marker + that space, normalize bullets to "• " (ordered "N. " is already
  // canonical → no-op so we don't loop). Mirrors tryListShortcut.
  function iosListStart(src: string, caret: number): { text: string; caret: number } | null {
    const lineStart = src.lastIndexOf("\n", caret - 1) + 1;
    const beforeCaret = src.slice(lineStart, caret);
    const m = beforeCaret.match(/^([-+*]|\d{1,3}\.) $/);
    if (!m) return null;
    if (isInsideCodeBlockAt(src, lineStart)) return null;
    const marker = m[1];
    const replacement = /^\d/.test(marker) ? `${marker} ` : "• ";
    if (beforeCaret === replacement) return null; // already canonical
    return { text: src.slice(0, lineStart) + replacement + src.slice(caret), caret: lineStart + replacement.length };
  }

  // A newline was just typed at caret-1. If the line before it is a list item and
  // the Enter was at the item's end, continue the list (next marker) — or, if the
  // item was empty, exit (drop the marker line). Mirrors tryContinueList for the
  // post-insertion native model.
  function iosListContinue(src: string, caret: number): { text: string; caret: number } | null {
    const nlPos = caret - 1;
    if (src[nlPos] !== "\n") return null;
    // Only when nothing followed on the line (Enter at the end of the item).
    if (caret < src.length && src[caret] !== "\n") return null;
    const prevLineStart = src.lastIndexOf("\n", nlPos - 1) + 1;
    const prevLine = src.slice(prevLineStart, nlPos);
    const bullet = prevLine.match(/^(\s*)([-•◦▪])\s+(.*)$/);
    const ordered = prevLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (!bullet && !ordered) return null;
    if (isInsideCodeBlockAt(src, prevLineStart)) return null;
    const content = bullet ? bullet[3] : ordered![3];
    if (content.trim() === "") {
      // Empty item → exit the list: remove the marker line + its trailing newline.
      return { text: src.slice(0, prevLineStart) + src.slice(caret), caret: prevLineStart };
    }
    // Depth-glyph parity with the web path so the native pill's continued bullet
    // matches the render (•/◦/▪ by depth, not the reused marker char).
    const marker = bullet
      ? `${bullet[1]}${bulletGlyphForDepth(lineDepth(prevLine))} `
      : `${ordered![1]}${Number(ordered![2]) + 1}. `;
    return { text: src.slice(0, caret) + marker + src.slice(caret), caret: caret + marker.length };
  }

  function handleInput(): void {
    // Only emit typing while there's actual content; deleting back to empty
    // shouldn't broadcast a typing indicator.
    if (text.trim() !== "") throttledTyping();
    autoResize();
    detectMention();
    // Un-mute the slash menu once the text no longer looks like a command
    // token, so a fresh "/" after Escape reopens it.
    if (slashDismissed && !/^\/[a-z0-9-]*$/i.test(text)) slashDismissed = false;
    if (slashIndex !== 0 && slashTotalItems <= slashIndex) slashIndex = 0;
    // #602 — drop the applied-template flag once the composer text no longer
    // EQUALS the inserted template body (cleared back to empty, edited, or fully
    // overwritten). A fresh, hand-typed message must not inherit a prior
    // template's server-side expansion; only an unchanged body stays flagged so
    // its {channel}/{user}/{date} still expand on send.
    if (appliedTemplate && text !== appliedTemplate.body) appliedTemplate = null;
    // Any edit invalidates the unknown-trigger banner (it described the old text).
    if (unknownSlash) unknownSlash = null;
  }

  async function submit(): Promise<void> {
    if (isSending) return;
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    // Don't send while an eager upload is still in flight — submit() would
    // re-upload the same file (duplicate request + state churn). The chip shows
    // a spinner; sending works once it resolves.
    if (pendingFiles.some((f) => f.uploading)) return;

    sendError = null;
    unknownSlash = null;

    // Registered channel slash command → dispatch cyborg:slash_command instead
    // of a message. The result arrives asynchronously as a normal channel
    // message. An UNKNOWN "/foo" that still looks like a command is blocked
    // with a suggestion banner (a typo'd /summarize would otherwise post
    // publicly as text); text that merely starts with "/" ("/etc/hosts" …)
    // falls through and sends as a plain message.
    if (enableSlashCommands && pendingFiles.length === 0) {
      const slash = parseChannelSlashInput(trimmed);
      if (blockUnknownSlash(slash, trimmed)) return;
      if (slash) {
        const wsId = workspaceState.current?.id;
        const channelId = channelState.activeId;
        if (!wsId || !channelId) return;
        // /catchup is a PERSONAL ephemeral digest — it has no channel echo and no
        // count arg. Route it through runCatchup (opens the digest sheet) instead
        // of the in-channel slash dispatch, and clear the composer.
        if (slash.command.trigger === "catchup") {
          const name = workspaceState.activeChannel?.name ?? "this channel";
          void runCatchup(channelId, name);
          text = "";
          if (draftKey) draftsState.clear(draftKey);
          return;
        }
        isSending = true;
        try {
          // Slash commands route to a daemon the user OWNS. Pass the configured
          // default explicitly when set AND still online; otherwise leave it to
          // the relay, which uses the user's single online owned daemon or
          // returns a systemAlert telling them to pick one (cloud group channels
          // have no daemon). Re-validating online here matters because the
          // default is only gated at SET time (DaemonDetail) — if it went offline
          // since, targeting it would reject into the small grey error instead of
          // the friendly systemAlert path (#210).
          const def = daemonState.defaultSlashDaemonId;
          const daemonId = def && daemonState.isOnline(def) ? def : undefined;
          const resp = await client.slashCommand(
            wsId,
            channelId,
            slash.command.trigger,
            slash.args || undefined,
            daemonId,
          );
          if (resp.systemAlert) {
            // No daemon resolved — show it as a system message in the channel
            // (seq:0 sorts it to the bottom), not small grey error text. Replace
            // any prior alert and auto-expire it (~30s) so a stale "no daemon"
            // notice doesn't stay pinned below newer real messages (#210).
            if (lastSlashAlertId) channelState.removeMessage(lastSlashAlertId);
            const alertId = `slash-alert-${Date.now()}`;
            lastSlashAlertId = alertId;
            channelState.addMessage({
              id: alertId,
              channelId: resp.channelId ?? channelId,
              fromId: "system",
              fromType: "system",
              text: resp.systemAlert,
              // Carries the discriminator so MessageList can render a "Configure
              // AI" CTA for the unconfigured case (only).
              alertType: resp.alertType ?? null,
              seq: 0,
              createdAt: Date.now(),
            });
            setTimeout(() => {
              channelState.removeMessage(alertId);
              if (lastSlashAlertId === alertId) lastSlashAlertId = null;
            }, 30_000);
            text = "";
            if (draftKey) draftsState.clear(draftKey);
            return;
          }
          if (!resp.ok) {
            // Keep the typed command so the user can retry/adjust.
            sendError = resp.error ?? `/${slash.command.trigger} failed`;
            return;
          }
          // A usable daemon dispatched the command — clear any lingering alert.
          if (lastSlashAlertId) {
            channelState.removeMessage(lastSlashAlertId);
            lastSlashAlertId = null;
          }
          // Ephemeral arg warnings from the daemon's ack ("count clamped",
          // "text ignored"): show a LOCAL system note near where the result
          // will land (seq:0 sorts to the bottom). Sender-only, never
          // persisted; replaces any prior note and expires after ~30s.
          if (resp.warnings && resp.warnings.length > 0) {
            if (lastSlashWarnId) channelState.removeMessage(lastSlashWarnId);
            const warnId = `slash-warn-${Date.now()}`;
            lastSlashWarnId = warnId;
            channelState.addMessage({
              id: warnId,
              channelId,
              fromId: "system",
              fromType: "system",
              // " · " — the system-note renders text in a plain span, where a
              // "\n" would collapse into a run-together line.
              text: resp.warnings.join(" · "),
              seq: 0,
              createdAt: Date.now(),
            });
            setTimeout(() => {
              channelState.removeMessage(warnId);
              if (lastSlashWarnId === warnId) lastSlashWarnId = null;
            }, 30_000);
          }
          // (F) Show a loading indicator until the (async) reply lands — the RPC
          // only acked the dispatch, the generated reply arrives later as a
          // channel message.
          {
            const sel = effectiveSlashModel;
            const actor = sel ? (PROVIDER_LABELS[sel.provider] ?? sel.provider) : null;
            // Anchor on the last PERSISTED message — local seq:0 ephemera (the
            // warn note added just above, the #210 alert) sort pinned-last, so
            // anchoring on one would strand the indicator until the note's TTL.
            const lastMsg = lastPersistedMessage(channelState.messages);
            slashProgress.start(
              channelId,
              slashProgressLabel(slash.command.trigger, actor),
              lastMsg?.id,
            );
          }
          text = "";
          if (draftKey) draftsState.clear(draftKey);
          if (textarea) {
            textarea.style.height = "auto";
            // On iOS the textarea is visually hidden and the native pill owns
            // the keyboard — refocusing it here would pop the WebView's soft
            // keyboard and fight the native pill.
            if (!nativeChromeHidden()) textarea.focus();
          }
        } catch (e) {
          sendError = e instanceof Error ? e.message : "Command failed";
        } finally {
          isSending = false;
        }
        return;
      }
    }

    isSending = true;

    let attachments: Attachment[] | undefined;
    const fileEntries = pendingFiles.filter((pf) => pf.file != null);
    if (fileEntries.length > 0) {
      try {
        // Reuse the eager-upload result when present; only upload files whose
        // eager upload hasn't finished (or errored) yet.
        attachments = await Promise.all(
          fileEntries.map((pf) => pf.uploaded ?? fileToAttachment(pf.file as File)),
        );
      } catch (e) {
        sendError = e instanceof Error ? e.message : "Upload failed";
        isSending = false;
        return;
      }
    }

    const mentions = resolveMentions(trimmed);
    // #602 — flag the send for server-side template expansion when this text was
    // inserted from a prompt template (and still carries content). Only the
    // channel composer (sendMessage path) supports it; the DM/thread customSend
    // path never opens the template menu (enableSlashCommands is false there).
    const expandTemplate = appliedTemplate != null;
    if (customSend) {
      customSend(trimmed, mentions.length > 0 ? mentions : undefined, attachments);
    } else {
      sendMessage(trimmed, mentions.length > 0 ? mentions : undefined, attachments, expandTemplate);
    }
    appliedTemplate = null;

    selectedMentions = [];
    mentionActive = false;
    showPreview = false;
    rejectedFiles = [];
    text = "";
    pendingFiles.forEach((pf) => { if (pf.preview) URL.revokeObjectURL(pf.preview); });
    pendingFiles = [];
    // Clear the persisted draft so it doesn't re-hydrate the just-sent text.
    if (draftKey) draftsState.clear(draftKey);
    // Reset the native caret so the next mention detection starts clean.
    nativeCaret = -1;
    nativeSelectionEnd = -1;
    isSending = false;
    if (textarea) {
      textarea.style.height = "auto";
      // Don't refocus the hidden textarea on iOS — the native pill keeps the
      // keyboard (see the slash-command branch above for the rationale).
      if (!nativeChromeHidden()) textarea.focus();
    }
  }

  function autoResize(): void {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  }

  // ─── Markdown insertion helpers ───
  // On iOS the visible composer is the native pill and the hidden textarea is
  // never focused (its selection is stale), so every helper below first checks
  // useNativeComposer(): if true it operates on (text, nativeCaret,
  // nativeSelectionEnd) and pushes the result into the pill via pushNative()
  // (#13 P1). When false (web / desktop / Android) the existing textarea path
  // runs byte-for-byte unchanged.
  // The three markdown editors below are thin adapters over the pure
  // applyMarkdown core ($lib/composer-markdown.ts): read the selection (native
  // pill caret on iOS, else the textarea), run the pure transform, then write
  // `text` + reposition. The native pill takes a single caret (selEnd, the end
  // of the inserted run); the web textarea keeps the returned anchor..head range.
  function wrapSelection(before: string, after: string): void {
    if (useNativeComposer()) {
      // Native: trim whitespace OUT of the wrapped range so the markers hug the
      // text (`_ hi _` is invalid markdown). Collapse to selEnd (the pill takes
      // one caret offset).
      const r = applyMarkdown(text, nativeCaret, nativeSelectionEnd, {
        kind: "wrap",
        before,
        after,
        trimSelection: true,
      });
      pushNative(r.text, r.selEnd);
      return;
    }
    if (!textarea) return;
    const r = applyMarkdown(text, textarea.selectionStart, textarea.selectionEnd, {
      kind: "wrap",
      before,
      after,
      trimSelection: false,
    });
    text = r.text;
    requestAnimationFrame(() => {
      textarea!.selectionStart = r.selStart;
      textarea!.selectionEnd = r.selEnd;
      textarea!.focus();
    });
  }

  function insertAtCursor(content: string): void {
    if (useNativeComposer()) {
      const r = applyMarkdown(text, nativeCaret, nativeSelectionEnd, { kind: "insert", content });
      pushNative(r.text, r.selEnd);
      return;
    }
    if (!textarea) return;
    const r = applyMarkdown(text, textarea.selectionStart, textarea.selectionEnd, {
      kind: "insert",
      content,
    });
    text = r.text;
    requestAnimationFrame(() => {
      textarea!.selectionStart = r.selEnd;
      textarea!.selectionEnd = r.selEnd;
      textarea!.focus();
      autoResize();
    });
  }

  function insertLinePrefix(prefix: string): void {
    if (useNativeComposer()) {
      // Anchor off the selection START (top of the line the caret sits on).
      const start = Math.min(nativeCaret, nativeSelectionEnd);
      const r = applyMarkdown(text, start, start, { kind: "linePrefix", prefix });
      pushNative(r.text, r.selEnd);
      return;
    }
    if (!textarea) return;
    const start = textarea.selectionStart;
    const r = applyMarkdown(text, start, start, { kind: "linePrefix", prefix });
    text = r.text;
    requestAnimationFrame(() => {
      textarea!.selectionStart = r.selEnd;
      textarea!.selectionEnd = r.selEnd;
      textarea!.focus();
    });
  }

  function toggleBold(): void { wrapSelection("*", "*"); }
  function toggleItalic(): void { wrapSelection("_", "_"); }
  function toggleStrike(): void { wrapSelection("~~", "~~"); }
  function toggleCode(): void { wrapSelection("`", "`"); }
  function toggleCodeBlock(): void { wrapSelection("```\n", "\n```"); }
  function toggleOrderedList(): void { insertLinePrefix("1. "); }
  function toggleBulletList(): void { insertLinePrefix("• "); }
  function toggleBlockquote(): void { insertLinePrefix("> "); }

  // Native iOS format bar (composer:format → onFormat). The INLINE styles
  // (bold/italic/strike/code) are owned by the native rich-text editor and never
  // reach here — the native pill toggles them on its attributed buffer directly
  // (Slack "activate then type", no markdown markers in the JS text). Only the
  // LINE / insertion kinds are routed to JS: list/quote insert a markdown prefix
  // at the live native selection; link opens the modal.
  function handleNativeFormat(kind: string): void {
    switch (kind) {
      case "bulletList": toggleBulletList(); break;
      case "orderedList": toggleOrderedList(); break;
      case "blockquote": toggleBlockquote(); break;
      case "link": openLinkModal(); break;
    }
  }

  function openLinkModal(): void {
    if (useNativeComposer()) {
      // Seed the modal with whatever the native pill has selected; the inserted
      // link lands at the native caret via handleLinkSave → insertAtCursor.
      const start = Math.min(nativeCaret, nativeSelectionEnd);
      const end = Math.max(nativeCaret, nativeSelectionEnd);
      linkInitialText = text.slice(start, end);
      linkModalOpen = true;
      return;
    }
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    linkInitialText = text.slice(start, end);
    linkModalOpen = true;
  }

  function handleLinkSave(displayText: string, url: string): void {
    if (displayText && displayText !== url) {
      insertAtCursor(`[${displayText}](${url})`);
    } else {
      insertAtCursor(url);
    }
  }

  // ─── File handling ───
  const maxAttachmentLabel = formatSize(MAX_ATTACHMENT_BYTES);

  function addFiles(fileList: FileList | File[]): void {
    // Pre-pick size guard: reject oversized files up-front so the user sees an
    // inline warning BEFORE an upload is attempted, instead of discovering it as
    // a per-chip error after the eager upload fails. fileToAttachment still
    // enforces the same limit on the send path, so this is purely additive UX.
    const { accepted, rejected } = partitionFilesBySize(fileList, MAX_ATTACHMENT_BYTES);
    rejectedFiles = rejected;
    if (accepted.length === 0) return;

    const newPending: PendingFile[] = accepted.map((file) => ({
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      uploading: false,
      mimeType: file.type,
      fileName: file.name,
    }));
    pendingFiles = [...pendingFiles, ...newPending];
    // Eager upload (v1 parity): start uploading as soon as the file is added,
    // not on send. The chip shows a spinner → ✓ (or a retry button on failure),
    // and submit() reuses the result so sending feels instant.
    for (const pf of newPending) void uploadPending(pf.id);
  }

  // Upload one pending file in the background. Used by addFiles (eager) and the
  // chip's retry button. Mutates the matching pendingFiles entry by id so it
  // survives reordering/removal while the upload is in flight.
  async function uploadPending(id: string): Promise<void> {
    const target = pendingFiles.find((f) => f.id === id);
    if (!target?.file) return;
    const file = target.file;
    // Fresh canceller for this attempt (covers retry after a prior abort).
    const controller = new AbortController();
    uploadControllers.set(id, controller);
    pendingFiles = pendingFiles.map((f) =>
      f.id === id ? { ...f, uploading: true, error: undefined, progress: 0 } : f,
    );
    try {
      const attachment = await fileToAttachment(file, {
        // Live S3 progress (#517) → drive the chip's bar. Only touch the matching
        // entry; if it was removed mid-upload the map finds nothing (harmless).
        onProgress: (pct) => {
          pendingFiles = pendingFiles.map((f) => (f.id === id ? { ...f, progress: pct } : f));
        },
        signal: controller.signal,
      });
      pendingFiles = pendingFiles.map((f) =>
        f.id === id
          ? { ...f, uploading: false, error: undefined, progress: undefined, uploaded: attachment }
          : f,
      );
    } catch (e) {
      // A user-cancelled upload (× during flight) aborts the PUT and removeFile
      // has already dropped the chip — don't resurrect it with an error row.
      if (e instanceof Error && e.name === "AbortError") return;
      pendingFiles = pendingFiles.map((f) =>
        f.id === id
          ? {
              ...f,
              uploading: false,
              progress: undefined,
              error: e instanceof Error ? e.message : "Upload failed",
            }
          : f,
      );
    } finally {
      uploadControllers.delete(id);
    }
  }

  function removeFile(id: string): void {
    const pf = pendingFiles.find((f) => f.id === id);
    if (pf?.preview) URL.revokeObjectURL(pf.preview);
    // Cancel an in-flight upload (#517): abort the PUT so removing the chip while
    // it's uploading actually stops the transfer (uploadPending swallows the
    // resulting AbortError without flashing an error row).
    uploadControllers.get(id)?.abort();
    uploadControllers.delete(id);
    pendingFiles = pendingFiles.filter((f) => f.id !== id);
  }

  function handleFileChange(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    addFiles(files);
    input.value = "";
  }

  // ─── Native iOS attachment preview (Caveat #6) ───
  // Downscale an image File to a small base64 JPEG (no data: prefix) for the
  // native pill's thumbnail strip. Bounded to ~120px so the payload that
  // crosses the JS→Swift bridge stays tiny. Returns "" on any failure (Swift
  // then falls back to a generic image icon).
  function fileToNativeThumb(file: File): Promise<string> {
    return new Promise((resolve) => {
      if (!file.type.startsWith("image/")) return resolve("");
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 120;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve("");
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          resolve(dataUrl.split(",")[1] ?? "");
        } catch {
          resolve("");
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve("");
      };
      img.src = url;
    });
  }

  function nativeAttachKind(mime: string): NativeAttachment["kind"] {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
  }

  // A single bare URL (https?://… or www.…) with no internal whitespace.
  const BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s]+$/i;

  function handlePaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;

    // Paste-a-link-over-selection: if the clipboard is a single bare URL and
    // there's a non-empty selection in the textarea, wrap the selection in a
    // markdown link `[selection](url)` instead of overwriting it (v1 TipTap
    // setLink parity). Falls through to default paste when there's no selection
    // or the clipboard isn't a bare URL.
    const pastedText = cd.getData("text/plain").trim();
    if (textarea && pastedText && BARE_URL_RE.test(pastedText)) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = text.slice(start, end);
      if (selected) {
        e.preventDefault();
        const url = pastedText.startsWith("www.") ? `https://${pastedText}` : pastedText;
        const markdown = `[${selected}](${url})`;
        // Mirror the programmatic-insert pattern: set the reactive `text` (the
        // bound value) and reposition the caret after the inserted link on the
        // next frame so Svelte's render has applied the new value.
        text = text.slice(0, start) + markdown + text.slice(end);
        requestAnimationFrame(() => {
          const pos = start + markdown.length;
          textarea!.selectionStart = pos;
          textarea!.selectionEnd = pos;
          textarea!.focus();
          autoResize();
        });
        return;
      }
    }

    const items = cd.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          const ext = item.type.split("/")[1] ?? "png";
          imageFiles.push(new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: item.type }));
        }
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }

  function handleVoiceComplete(file: File, preview: string): void {
    pendingFiles = [...pendingFiles, {
      id: `voice-${Date.now()}`,
      file,
      preview,
      uploading: false,
      mimeType: file.type,
      fileName: file.name,
    }];
  }

  // ─── Drag and drop ───
  function handleDragEnter(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragCounter += 1;
    if (dragCounter === 1) isDragOver = true;
  }

  function handleDragOver(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) isDragOver = false;
  }

  function handleDrop(e: DragEvent): void {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragCounter = 0;
    isDragOver = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) addFiles(files);
  }

  // ─── Outside click for popups ───
  // Dismiss-on-outside-click for the emoji / plus / mention popups is the shared
  // `clickOutside` action (#510), applied per-container in the markup below
  // (each `enabled` by its own open flag). It's bubble-phase `click` — same as
  // the old single `svelte:document onclick` handler — so the toggle buttons'
  // `stopPropagation()` still prevents an immediate re-close. Esc stays handled
  // inline by the composer's keydown (mention) — no behaviour change.

  // ─── Emoji from picker ───
  function handleEmojiSelect(emoji: string): void {
    insertAtCursor(emoji);
    emojiOpen = false;
  }

  // ─── Native iOS composer bridge (Caveat #6) ───────────────────────────────
  // On the Tauri iOS shell a native UIKit pill rides the keyboard (no WebView
  // resize → no parpadeo). This Svelte composer stays mounted but visually
  // hidden; native send/mic/attach/text-change events route back into it so
  // mentions / upload / voice logic keeps running. Everything below is gated on
  // isTauriIOS() — web / desktop / Android are completely unaffected.
  const onIOS = isTauriIOS();
  // KILL-SWITCH: the native UIKit keyboard-riding pill (Caveat #6) is not yet
  // rendering on-device, which left the iOS composer invisible (web chrome was
  // hidden in favor of a pill that never showed → no way to send a message).
  // Until the native pill is verified on a real device, keep it OFF and use the
  // ordinary web composer on iOS (fully functional; just no anti-flicker pill).
  // Flip back to true to re-enable the native bridge once it's confirmed.
  const NATIVE_COMPOSER_ENABLED = true;
  // Collapse the web composer chrome on iOS whenever the native pill is the
  // input surface. Swift shows the pill on every chat route (URL-KVO), and this
  // MessageInput is only mounted on chat routes, so the chrome hides 1:1 with
  // the pill being present — no double composer. (Buried instances behind a
  // full-screen sheet, e.g. a channel under an open thread, also hide their
  // chrome, but they're off-screen so it's never a visible "missing" composer.)
  const hideWebChrome = onIOS && NATIVE_COMPOSER_ENABLED;

  let nativeOwner: ComposerOwner | null = null;
  // Suppress the text→native mirror when the text change *originated* from a
  // native `composer:text-changed` event — otherwise setText would echo back to
  // the pill on every keystroke and stomp the caret.
  let suppressNativeTextMirror = false;
  // Caret position last reported by the native pill. When the web chrome is
  // hidden (iOS), the textarea isn't focused, so `textarea.selectionStart` is
  // stale — detectMention/selectMention read this instead. -1 means "no native
  // caret yet, fall back to the textarea".
  let nativeCaret = -1;
  // End of the selection last reported by the native pill (== nativeCaret for a
  // collapsed caret). The formatting toolbar uses both ends to wrap an actual
  // selection (bold/italic/strike/code/link over selected text); the native
  // pill reports both via composer:text-changed. -1 means "no native selection
  // yet". (P1 #13 — iOS composer formatting toolbar.)
  let nativeSelectionEnd = -1;
  // True when the native pill currently owns input for this instance — gates
  // the caret-source switch in detectMention/selectMention so the web path is
  // never affected.
  function nativeChromeHidden(): boolean {
    return onIOS && nativeOwner != null && isNativeComposerOwner(nativeOwner);
  }

  // True when this instance should route a formatting/insert transform through
  // the native pill (iOS, pill is owned, a caret has been reported) instead of
  // mutating the hidden textarea. Web / desktop / Android always return false,
  // so those paths are byte-for-byte unchanged. (#13 P1.)
  function useNativeComposer(): boolean {
    return nativeChromeHidden() && nativeCaret >= 0;
  }

  // Push a programmatic text + caret edit into the native pill, suppressing the
  // reactive text→native mirror so this explicit setNativeText isn't double-
  // fired (echo-loop guard — same dance as selectMention). Keeps nativeCaret /
  // nativeSelectionEnd in sync so a follow-up transform reads the new caret.
  function pushNative(newText: string, newCaret: number): void {
    text = newText;
    nativeCaret = newCaret;
    nativeSelectionEnd = newCaret;
    suppressNativeTextMirror = true;
    void setNativeText(text, newCaret);
    queueMicrotask(() => {
      suppressNativeTextMirror = false;
    });
  }

  // Read the live theme tokens and hand them to Swift (Caveat #11 — theme from
  // JS, never via evaluateJavaScript inside a plugin command).
  async function activateNative(): Promise<void> {
    if (!nativeOwner) return;
    const owner = nativeOwner;
    // activate() claims its activationSeq synchronously before the await
    // (Caveat #7); callers fire-and-forget so registration stays before any
    // await on the mount path.
    const ok = await activateNativeComposer(owner, { theme: readComposerTheme() });
    // On (re)activation, push the current composer state into the pill so it
    // shows the restored draft + the right send affordance. Guard on still
    // being owner — a sibling may have taken over while the invoke resolved.
    if (!ok || !isNativeComposerOwner(owner)) return;
    // Push the live palette through the dedicated theme channel so a freshly
    // shown pill always gets the CURRENT colours even if Swift's URL-KVO read
    // raced the first paint (the bridge `activate()` discards its theme arg, so
    // this is the path that actually repaints the pill). Idempotent with the KVO
    // read — it just corrects/overrides it deterministically.
    pushComposerTheme();
    await setNativeText(text);
    await setNativeHasPending(pendingFiles.length > 0);
  }

  async function handleNativeSend(_text: string): Promise<void> {
    // The native pill's text is already mirrored into `text` via the
    // text-changed events, and submit() consults pendingFiles for image-only
    // sends — so we drive the existing submit() rather than trusting the event
    // payload. On a SUCCESSFUL send submit() sets text="", which the text-mirror
    // $effect pushes to the native pill (clearing it); on FAILURE text is left
    // intact so the pill keeps the user's message. We therefore do NOT eagerly
    // clear the pill here (that would wipe it even when the send failed) — but
    // we reset the native caret so the next mention detection starts clean.
    await submit();
    nativeCaret = -1;
    nativeSelectionEnd = -1;
  }

  function handleNativeTextChanged(
    nextText: string,
    selectionStart: number,
    selectionEnd: number = selectionStart,
  ): void {
    const prev = text;
    suppressNativeTextMirror = true;
    text = nextText;
    nativeCaret = selectionStart;
    nativeSelectionEnd = selectionEnd;
    // iOS markdown authoring (#13): the web toolbar/key handlers can't run on the
    // native pill, so detect the just-typed char from the delta and apply the list
    // transforms here. Single-char insertion at the caret only (paste/backspace/
    // autocorrect-replace won't match → no-op). The result is pushed back to the
    // pill via setNativeText (composer_set_text doesn't echo composer:text-changed,
    // so this can't loop). Mentions/slash already use this same native-caret path.
    const inserted =
      nextText.length === prev.length + 1 && selectionStart >= 1
        ? nextText[selectionStart - 1]
        : null;
    let xf: { text: string; caret: number } | null = null;
    if (inserted === "\n") xf = iosListContinue(nextText, selectionStart);
    else if (inserted === " ") xf = iosListStart(nextText, selectionStart);
    if (xf) {
      text = xf.text;
      nativeCaret = xf.caret;
      nativeSelectionEnd = xf.caret;
      void setNativeText(xf.text, xf.caret);
    }
    // Run the same input pipeline a real keystroke would (typing indicator,
    // auto-resize is a no-op for the hidden textarea, mention detection off the
    // native caret, slash-menu un-mute).
    handleInput();
    // Clear the suppress flag after the reactive mirror effect has had a chance
    // to observe this same tick's `text` write without re-pushing to native.
    queueMicrotask(() => {
      suppressNativeTextMirror = false;
    });
  }

  function handleNativeAttach(): void {
    // Mirror the web "+" → file-input path; the native picker (file-picked
    // event) is the primary path on iOS, this is the fallback affordance.
    fileInputEl?.click();
  }

  function handleNativeMic(): void {
    void voiceRecorder?.startRecording();
  }

  function handleNativeFilePicked(file: File): void {
    addFiles([file]);
  }

  // onReclaim fires (from the bridge) when a sibling that had grabbed the pill
  // (a thread panel) is destroyed and ownership falls back to THIS still-mounted
  // instance — re-show + re-sync so the underlying channel/dm composer regains
  // the native pill without a hide/show flicker.
  function handleNativeReclaim(): void {
    void activateNative();
  }

  function nativeCallbacks() {
    return {
      onSend: handleNativeSend,
      onTextChanged: handleNativeTextChanged,
      onAttach: handleNativeAttach,
      onMic: handleNativeMic,
      onFormat: handleNativeFormat,
      onFilePicked: handleNativeFilePicked,
      onAttachRemoved: (id: string) => removeFile(id),
      onAttachRetry: (id: string) => void uploadPending(id),
      onHeightChanged: (h: number) => { nativeComposerHeight = Math.max(60, Math.round(h)); },
      onReclaim: handleNativeReclaim,
    };
  }

  // The web composer chrome is collapsed to zero footprint on iOS (see the
  // wrapper markup) so the native pill is what's seen; the composer stays
  // MOUNTED so all of its mention / upload / voice / draft logic keeps running.
  //
  // Register THIS instance + bind callbacks, then activate. register() pushes
  // onto the bridge's LIFO stack so the most-recently-mounted instance wins the
  // pill — matches the visible-on-top composer in the 3-instance reality (a
  // thread panel opened over a channel takes the pill; closing it hands the
  // pill back via onReclaim). Done at top-level script eval (component init),
  // BEFORE any await, so the register → activate handshake happens before
  // SvelteKit's async navigation can interleave (Caveat #7).
  if (onIOS && NATIVE_COMPOSER_ENABLED) {
    nativeOwner = registerNativeComposer(nativeCallbacks());
    void activateNative();
  }

  // Re-claim the pill whenever this instance becomes the active conversation
  // again (keyed on draftKey). A sibling may have taken the pill; on re-entry,
  // re-register (pushes to the top of the stack) so events route here and the
  // pill re-shows. untrack the body so the effect's only reactive dep is
  // draftKey. No-op off iOS.
  let lastActivatedKey: string | null = null;
  $effect(() => {
    if (!onIOS || !NATIVE_COMPOSER_ENABLED) return;
    const key = draftKey;
    untrack(() => {
      if (key == null || key === lastActivatedKey) return;
      lastActivatedKey = key;
      if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) {
        if (nativeOwner) unregisterNativeComposer(nativeOwner);
        nativeOwner = registerNativeComposer(nativeCallbacks());
      }
      void activateNative();
    });
  });

  // Mirror programmatic text changes (drafts, mention picks, markdown toolbar,
  // paste) into the native pill so the pill shows what the composer holds. Skip
  // echoes that originated from a native text-changed event. No-op off iOS.
  $effect(() => {
    const t = text;
    if (!onIOS || suppressNativeTextMirror) return;
    if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) return;
    void setNativeText(t);
  });

  // Mirror the pending-attachment count so the native send button enables for
  // image-only sends (Swift only sees the text view's emptiness otherwise).
  // No-op off iOS.
  $effect(() => {
    const hasPending = pendingFiles.length > 0;
    if (!onIOS) return;
    if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) return;
    void setNativeHasPending(hasPending);
  });

  // Render the pending attachments as a visible thumbnail strip in the native
  // pill. The web ComposerAttachments preview is collapsed to opacity:0 behind
  // the pill on iOS, so this is the only visible draft preview there. Re-runs on
  // any pendingFiles change (pick/upload-state/remove) and when a thumbnail
  // finishes generating (nativeThumbs). Kicks off thumbnail generation for any
  // image file that doesn't have one yet.
  $effect(() => {
    if (!onIOS) return;
    if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) return;
    const files = pendingFiles;
    const thumbs = nativeThumbs;
    const items: NativeAttachment[] = files.map((pf) => ({
      id: pf.id,
      kind: nativeAttachKind(pf.mimeType),
      thumb: thumbs[pf.id] ?? "",
      state: pf.error ? "error" : pf.uploaded ? "ready" : "uploading",
    }));
    void setNativeAttachments(items);
    // Generate any missing image thumbnails (once each); the resulting state
    // write re-runs this effect, which re-pushes with the thumbnail filled in.
    for (const pf of files) {
      if (
        pf.file &&
        pf.mimeType.startsWith("image/") &&
        !(pf.id in thumbs) &&
        !thumbInFlight.has(pf.id)
      ) {
        thumbInFlight.add(pf.id);
        void fileToNativeThumb(pf.file).then((b64) => {
          thumbInFlight.delete(pf.id);
          nativeThumbs = { ...nativeThumbs, [pf.id]: b64 };
        });
      }
    }
  });

  // Re-push CSS theme tokens to the native pill whenever the resolved theme
  // changes — covers both explicit setTheme() calls and OS media-query switches
  // while preference is "system".
  //
  // ORDERING (the dark-pill-on-light-document bug): we subscribe via the store's
  // `onResolvedChange` rather than tracking `preferencesState.resolvedTheme` in a
  // raw $effect. A $derived-tracking effect could schedule the re-read against an
  // ambiguous boundary relative to the store's `#apply()` (which writes
  // `data-theme`) and, worse, against the browser's style recompute — reading the
  // PREVIOUS theme's `--color-*` tokens and pushing a stale (dark) palette onto a
  // freshly-light document. The store now (a) writes `data-theme` synchronously in
  // `#apply()`, then (b) fires `onResolvedChange` listeners on the NEXT animation
  // frame — AFTER the style recompute — so `readComposerTheme()` inside
  // pushComposerTheme() always reads the CURRENT rendered palette. We also re-read
  // + re-push once on the following frame as a cheap self-heal in case the
  // recompute hadn't fully settled at first read. LIFO owner guard preserved.
  // No-op off iOS.
  //
  // CHANNEL: this now drives the dedicated `composer_set_theme` command via
  // pushComposerTheme(). activateNative() can NOT repaint the pill on an in-chat
  // toggle — the bridge `activate()` defers visibility to Swift's URL-KVO and
  // DISCARDS its theme arg, so the pill kept the old palette until the next
  // navigation. pushComposerTheme() invokes the new command, which parses the
  // tokens into Swift's cg* vars and calls applyComposerTheme() on the main
  // thread. The owner guard stays: the native pill is a single global overlay so
  // a non-owner pushing the same palette would be harmless/idempotent, but
  // gating on the live owner avoids N redundant IPC invokes when several
  // MessageInputs are mounted (channel + thread + dm) — only the live owner fires.
  $effect(() => {
    if (!onIOS || !NATIVE_COMPOSER_ENABLED) return;
    const unsubscribe = preferencesState.onResolvedChange(() => {
      if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) return;
      // pushComposerTheme() re-reads readComposerTheme() (live CSS tokens). The
      // store fired us post-recompute, so this read matches the rendered theme.
      pushComposerTheme();
      // Self-heal: one frame later, if the computed palette changed (a late
      // recompute), re-push. Cheap and idempotent — guarded on still-owning.
      requestAnimationFrame(() => {
        if (!nativeOwner || !isNativeComposerOwner(nativeOwner)) return;
        pushComposerTheme();
      });
    });
    return unsubscribe;
  });

  onDestroy(() => {
    // Pop this instance off the stack. The bridge handles the rest (Caveat #7):
    // if it was the top owner, it bumps activationSeq (rolling back any
    // in-flight activate from this instance) and either hands the pill to the
    // next instance down via onReclaim, or hides it if the stack is now empty.
    // If it was buried, it's just spliced out — the top owner is untouched.
    if (nativeOwner) unregisterNativeComposer(nativeOwner);
    nativeOwner = null;
  });
</script>

<svelte:window
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
/>

<input
  bind:this={fileInputEl}
  type="file"
  multiple
  accept="image/*,video/*,audio/*,.pdf,.txt,.json,.md"
  class="hidden"
  onchange={handleFileChange}
/>

<!-- On the Tauri iOS shell the native UIKit pill is the visible composer
     (Caveat #6). The web chrome stays MOUNTED (mentions / upload / voice / draft
     logic all keep running and route through the native bridge) but is made
     invisible + non-interactive so only the native pill shows.
     NOT display:none / height:0 — the native pill is a UIKit OVERLAY floating
     over the web content, so the web layout must RESERVE its height as a spacer
     (V1's 60px spacer-above-the-pill fix); otherwise the message list runs
     under the pill and the last message is hidden behind it. We keep the
     hidden textarea / file input's layout boxes too (selection + picker
     fallback). The spacer reserves EXACTLY the pill height — no extra --sab:
     the native pill already accounts for the home indicator, and adding --sab
     here left a large dead gap above the composer when the keyboard is up. -->
<!-- Mobile widths get a hairline separator above the composer area (iMessage
     bar convention) + slightly tighter padding; desktop keeps its spacing. -->
<div
  class={cn("shrink-0", viewportState.isMobile ? "hairline-t px-3 pb-3 pt-2" : "px-4 pb-3 pt-1")}
  style={hideWebChrome
    ? `height:${nativeComposerHeight}px;padding:0;margin:0;overflow:hidden;opacity:0;pointer-events:none;`
    : undefined}
  aria-hidden={hideWebChrome ? "true" : undefined}
>
  {#if isDragOver}
    <div class="fixed inset-0 z-[var(--z-elevated)] flex items-center justify-center pointer-events-none" style="background-color: rgba(0, 0, 0, 0.55);">
      <div class="rounded-2xl border-2 border-dashed border-accent-foreground/70 px-8 py-6 text-center" style="background-color: rgba(20, 20, 20, 0.85);">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-accent-foreground mx-auto mb-2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <div class="text-accent-foreground text-[15px] font-semibold">Drop files to attach</div>
        <div class="text-accent-foreground/70 text-[12px] mt-1">They'll be uploaded when you send</div>
      </div>
    </div>
  {/if}

  <div
    class="relative rounded-[18px] border border-edge bg-surface-alt focus-within:border-content-dim"
    use:clickOutside={{ enabled: mentionActive, escape: false, onClose: () => { mentionActive = false; } }}
  >
    <!-- Formatting controls are meaningless while previewing (they'd mutate the
         hidden textarea); dim + disable pointer events during preview to match
         Mattermost's show-formatting UX. Edit mode is unchanged. -->
    <!-- rounded-t-[17px] + overflow-hidden clip the toolbar's own square-cornered
         bg to the field's 18px radius (17 = 18 minus the 1px field border). -->
    <div class="overflow-hidden rounded-t-[17px]" style={showPreview ? "opacity:0.4;pointer-events:none;" : undefined} aria-hidden={showPreview ? "true" : undefined}>
      <ComposerToolbar
        onToggleBold={toggleBold}
        onToggleItalic={toggleItalic}
        onToggleStrike={toggleStrike}
        onToggleOrderedList={toggleOrderedList}
        onToggleBulletList={toggleBulletList}
        onToggleBlockquote={toggleBlockquote}
        onToggleCode={toggleCode}
        onToggleCodeBlock={toggleCodeBlock}
        onLinkClick={openLinkModal}
      />
    </div>

    <!-- Web / desktop link popover. On iOS the whole composer chrome is
         opacity:0 (which hides fixed descendants too), so the iOS link modal is
         rendered OUTSIDE this chrome below — gate this one off when the native
         pill owns input so the two never both grab focus. -->
    <ComposerLinkModal
      open={linkModalOpen && !hideWebChrome}
      initialText={linkInitialText}
      onSave={handleLinkSave}
      onClose={() => { linkModalOpen = false; textarea?.focus(); }}
    />

    <!-- #607 Schedule send dialog: opens against the captured draft snapshot
         (scheduledText/scheduledMentions) for the active channel/DM target. -->
    {#if scheduleTarget !== null}
      <ScheduleSendDialog
        bind:open={scheduleDialogOpen}
        channelId={"channelId" in scheduleTarget ? scheduleTarget.channelId : null}
        toId={"toId" in scheduleTarget ? scheduleTarget.toId : null}
        targetLabel={scheduleTargetLabel}
        text={scheduledText}
        mentions={scheduledMentions}
        onScheduled={afterScheduled}
      />
    {/if}

    <ComposerVoiceRecorder
      bind:this={voiceRecorder}
      onRecordingComplete={handleVoiceComplete}
      floating={hideWebChrome}
      onRecordingStart={() => {
        // iOS: hide the native pill + drop the keyboard so the floating recording
        // bar (portaled over the WebView) is visible and tappable.
        if (hideWebChrome) {
          void blurNativeInput();
          void setNativeVisibility(false);
        }
      }}
      onRecordingStop={() => {
        // Bring the pill back — it now shows the voice attachment + send button.
        if (hideWebChrome) void setNativeVisibility(true);
      }}
    />

    <ComposerAttachments
      files={pendingFiles}
      onRemove={removeFile}
      onRetry={uploadPending}
    />

    {#if slashActive}
      <SlashCommandMenu
        items={slashMatches}
        templates={slashTemplateMatches}
        selectedIndex={Math.min(slashIndex, slashTotalItems - 1)}
        onSelect={selectSlashCommand}
        onSelectTemplate={selectSlashTemplate}
        onHover={(i) => (slashIndex = i)}
      />
    {/if}

    {#if slashParsed}
      <!-- Slash guidance strip: (1.a) persistent arg hint, (1.b) live
           interpretation echo, and (B) the run-target pill. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 pt-1.5 text-[11px] text-content-muted">
        {#if slashParsed.command.hint}
          <span class="flex items-center gap-1.5 whitespace-nowrap">
            <span class="font-mono font-medium text-content-dim">/{slashParsed.command.trigger}</span>
            <span aria-hidden="true" class="opacity-40">│</span>
            <span class="font-mono">{slashParsed.command.hint}</span>
            {#if slashParsed.command.maxCount !== undefined}
              <span>— max {slashParsed.command.maxCount}</span>
            {/if}
          </span>
        {/if}

        {#if slashCountEcho}
          <span class="flex flex-wrap items-center gap-x-1.5">
            <span class="text-content-dim">
              {describeCountAction(slashParsed.command, slashCountEcho.count)}{slashCountEcho.usedDefault ? " (default)" : ""}
            </span>
            {#if slashCountEcho.clamped}
              <span class="text-warning">
                ⚠ {slashCountEcho.count === slashParsed.command.maxCount
                  ? `capped at the max (${slashParsed.command.maxCount})`
                  : "minimum is 1"}
              </span>
            {/if}
            {#if slashCountEcho.ignoredText}
              <span class="text-warning">⚠ extra text is ignored</span>
            {/if}
          </span>
        {/if}

        {#if slashRunTarget}
          <!-- (B) Where this slash command will run. -->
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger>
                <span class="flex items-center gap-1.5 whitespace-nowrap">
                  <svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>Runs on <span class="font-medium text-content-dim">{slashRunTarget}</span></span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {#if slashRunTarget === "auto"}
                  No model pinned — Cyborg7 picks a cheap model automatically. Set one in workspace settings.
                {:else}
                  This channel's slash commands run on {slashRunTarget}.
                {/if}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        {/if}
      </div>
    {/if}

    <!-- Slash-command ARGUMENT autocomplete (static options: counts / langs).
         The cybo target ("/ask @cybo") routes through MentionAutocomplete below
         instead; this popup only shows for arg specs with literal `options`.
         Same placement idiom + theme tokens as SlashCommandMenu. -->
    {#if !hideWebChrome && slashArgOptions.length > 0}
      <div
        class="absolute bottom-full left-0 mb-1 z-50 w-[var(--panel-wide)] max-h-[240px] overflow-y-auto rounded-lg border border-edge bg-popover text-popover-foreground py-1 shadow-md"
        role="listbox"
        aria-label="Command arguments"
      >
        <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
          /{slashArgContext?.command.trigger} — {slashArgContext?.command.hint ?? "argument"}
        </div>
        {#each slashArgOptions as opt, i (opt.value)}
          <button
            type="button"
            role="option"
            aria-selected={i === slashArgIndex}
            onmousedown={(e) => { e.preventDefault(); selectSlashArgOption(opt.value); }}
            onmouseenter={() => (slashArgIndex = i)}
            class:bg-dropdown-hover={i === slashArgIndex}
            class="w-full flex items-baseline gap-2 px-3 py-1.5 text-left cursor-pointer transition-colors text-[13px]"
          >
            <span class="font-semibold shrink-0">{opt.label ?? opt.value}</span>
            {#if opt.hint}
              <span class="text-content-muted text-[12px] truncate ml-auto">{opt.hint}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Composer-anchored dropdown. Shown whenever the web composer chrome is
         visible (web / desktop, and iOS while the native pill is disabled). When
         the native pill owns input (hideWebChrome), MobileMentionList renders the
         visible list below instead. -->
    {#if !hideWebChrome && mentionActive && mentionCandidates.length > 0}
      <MentionAutocomplete
        items={mentionCandidates}
        selectedIndex={mentionIndex}
        heading={mentionHeading}
        onSelect={selectMention}
        onHover={(i) => (mentionIndex = i)}
      />
    {/if}

    <!-- Markdown preview (Item: Eye toggle). Renders the live draft with the same
         renderer the message list uses, so the user can proof markdown/code/tables
         before sending. The textarea is kept MOUNTED behind it (display:none) so
         the draft, caret, mention state and bindings survive a toggle — only the
         visible surface swaps. Empty drafts show a hint instead of a blank box. -->
    {#if showPreview}
      <div
        class="relative w-full min-h-[40px] max-h-[200px] overflow-y-auto px-3 py-2 text-[16px]"
        style="line-height: 1.46;"
        data-testid="composer-preview"
      >
        {#if text.trim()}
          <MessageRenderer text={text} />
        {:else}
          <span class="text-content-muted">Nothing to preview yet.</span>
        {/if}
      </div>
    {/if}

    <!-- Mention highlight: a scroll-synced mirror sits behind the textarea and
         re-paints recognized @mentions in the --mention-* tokens. The textarea
         on top keeps transparent text + a visible caret, so caret/selection/
         autocomplete are untouched (v1 TipTap Mention parity). -->
    <div class="relative" style={showPreview ? "display:none;" : undefined}>
      <MentionHighlightOverlay text={text} isMention={isKnownMention} scrollTop={overlayScrollTop} />
      <textarea
        bind:this={textarea}
        bind:value={text}
        onkeydown={handleKeydown}
        oninput={handleInput}
        onkeyup={detectMention}
        onclick={detectMention}
        onpaste={handlePaste}
        onscroll={(e) => (overlayScrollTop = e.currentTarget.scrollTop)}
        placeholder={placeholderText}
        rows={1}
        {disabled}
        class="relative w-full resize-none bg-transparent text-[16px] placeholder:text-content-muted outline-none min-h-[40px] max-h-[200px] overflow-y-auto px-3 py-2"
        style="line-height: 1.46; color: transparent; caret-color: var(--caret-color); font-family: inherit; scrollbar-gutter: stable;"
      ></textarea>
    </div>

    <!-- Bottom bar: +, emoji, @, mic on left — send on right -->
    <div class="flex items-center justify-between px-2 py-1">
      <div class="flex items-center gap-0.5">
        <!-- + menu -->
        <div
          class="relative"
          use:clickOutside={{ enabled: plusMenuOpen, escape: false, onClose: () => { plusMenuOpen = false; } }}
        >
          <!-- 44pt touch target on mobile widths (iOS HIG); desktop keeps the
               compact 28px footprint so the bar height doesn't change there. -->
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); plusMenuOpen = !plusMenuOpen; }}
            class={cn(
              "flex items-center justify-center hover:bg-edge rounded cursor-pointer text-content-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              viewportState.isMobile ? "h-[44px] w-[44px]" : "h-[28px] w-[28px]",
            )}
            title="Actions"
          >
            <svg width={viewportState.isMobile ? 20 : 16} height={viewportState.isMobile ? 20 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          {#if plusMenuOpen}
            <div class="absolute bottom-full left-0 mb-1 z-50 rounded-lg py-1 w-[var(--panel-slim)]" style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);">
              <button
                type="button"
                onclick={() => { fileInputEl?.click(); plusMenuOpen = false; }}
                class="w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer transition-colors text-[13px] hover:bg-[var(--dropdown-hover)]"
                style="color: var(--dropdown-name);"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                Upload from your computer
              </button>
            </div>
          {/if}
        </div>

        <!-- Emoji picker -->
        <div
          class="relative"
          use:clickOutside={{ enabled: emojiOpen, escape: false, onClose: () => { emojiOpen = false; } }}
        >
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); emojiOpen = !emojiOpen; }}
            class="flex items-center justify-center p-1.5 hover:bg-edge rounded cursor-pointer text-content-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent touch-target"
            title="Emoji"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
          </button>
          {#if emojiOpen}
            <div class="absolute bottom-full left-0 mb-1 z-50">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => { emojiOpen = false; }}
              />
            </div>
          {/if}
        </div>

        <!-- @ mentions trigger -->
        <button
          type="button"
          onclick={() => { insertAtCursor("@"); requestAnimationFrame(detectMention); }}
          class="flex items-center justify-center p-1.5 hover:bg-edge rounded cursor-pointer text-content-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent touch-target"
          title="Mention someone"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" /></svg>
        </button>

        <!-- Voice recording -->
        {#if !isRecording}
          <button
            type="button"
            onclick={() => voiceRecorder?.startRecording()}
            class="flex items-center justify-center p-1.5 hover:bg-edge rounded cursor-pointer text-content-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent touch-target"
            title="Record voice note"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
          </button>
        {/if}

        <!-- Markdown preview toggle (Eye). Swaps the textarea for a rendered
             preview of the current draft and back. The "open eye" / "closed eye"
             glyph + active ring signal the current mode (Mattermost show_formatting
             parity). Disabled while empty — nothing to preview. -->
        <button
          type="button"
          onclick={() => { showPreview = !showPreview; if (!showPreview) requestAnimationFrame(() => textarea?.focus()); }}
          disabled={!showPreview && !text.trim()}
          aria-pressed={showPreview}
          class={cn("touch-target flex items-center justify-center p-1.5 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors", showPreview ? "bg-edge-light text-content ring-1 ring-edge" : "text-content-dim hover:bg-edge", !showPreview && !text.trim() && "opacity-40 cursor-not-allowed")}
          title={showPreview ? "Edit message" : "Preview markdown"}
          data-testid="composer-preview-toggle"
        >
          {#if showPreview}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
          {/if}
        </button>

        <!-- #607 Schedule send: a clock affordance that opens the time picker for
             the CURRENT draft. Only for top-level channel/DM messages with text
             (canSchedule); hidden in threads/agent composer. Disabled while empty.
             Gated behind SHOW_SCHEDULE_SEND — a reversible product hide (see the
             flag's comment in <script>); the dialog + handlers stay wired. -->
        {#if SHOW_SCHEDULE_SEND && scheduleTarget !== null}
          <button
            type="button"
            onclick={openScheduleDialog}
            disabled={!canSchedule}
            class={cn(
              "touch-target flex items-center justify-center p-1.5 rounded cursor-pointer text-content-dim hover:bg-edge focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors",
              !canSchedule && "opacity-40 cursor-not-allowed",
            )}
            title="Schedule send"
            aria-label="Schedule send"
            data-testid="composer-schedule-send"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></svg>
          </button>
        {/if}
      </div>

      <!-- Send button: circular 32px accent (arrow-up, iMessage-style). Only
           appears while there's text / pending attachments — fade+scale 150ms
           (instant under prefers-reduced-motion). Stays visible while sending
           so the spinner has a home after submit() clears the text. -->
      <button
        type="button"
        onclick={submit}
        disabled={!hasContent || isSending}
        aria-label="Send message"
        class={cn(
          "touch-target flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full cursor-pointer",
          "transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          isSending ? "bg-accent/70" : "bg-accent hover:bg-accent-hover active:scale-[0.92]",
          hasContent || isSending
            ? "scale-100 opacity-100"
            : "pointer-events-none scale-75 opacity-0",
        )}
      >
        {#if isSending}
          <div class="w-[14px] h-[14px] border-2 border-accent-foreground/30 border-t-accent-foreground rounded-full animate-spin"></div>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-accent-foreground">
            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
          </svg>
        {/if}
      </button>
    </div>

    {#if rejectedFiles.length > 0}
      <!-- Pre-pick size warning (Item: file-size warning at pick time). Lists the
           files skipped for exceeding the limit, BEFORE any upload. Dismissible;
           also clears on the next pick / send. -->
      <div class="flex items-start gap-2 px-3 py-1.5 text-[12px] text-warning" role="alert" data-testid="composer-size-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div class="min-w-0 flex-1">
          {#if rejectedFiles.length === 1}
            <span class="font-medium">{rejectedFiles[0].name}</span> exceeds the {maxAttachmentLabel} limit ({formatSize(rejectedFiles[0].size)}) and was not attached.
          {:else}
            {rejectedFiles.length} files exceed the {maxAttachmentLabel} limit and were not attached:
            <span class="text-content-muted">{rejectedFiles.map((f) => f.name).join(", ")}</span>
          {/if}
        </div>
        <button
          type="button"
          onclick={() => (rejectedFiles = [])}
          class="shrink-0 text-content-muted hover:text-content cursor-pointer"
          aria-label="Dismiss size warning"
          title="Dismiss"
        >&times;</button>
      </div>
    {/if}

    {#if sendError}
      <div class="flex items-center gap-2 px-3 py-1.5 text-[12px] text-error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        {sendError}
      </div>
    {/if}

    {#if unknownSlash}
      <!-- Unknown-trigger guard: the typed "/word" is not a registered command. -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[12px] text-content-muted">
        <span>
          <span class="font-medium text-content-dim">/{unknownSlash.trigger}</span> is not a command.{#if unknownSlash.suggestion}
            Did you mean <span class="font-medium text-content-dim">/{unknownSlash.suggestion}</span>?{/if}
        </span>
        <button
          type="button"
          onclick={sendUnknownAsText}
          class="underline underline-offset-2 cursor-pointer hover:text-content-dim"
        >Send as text</button>
        <button
          type="button"
          onclick={dismissUnknownSlash}
          class="underline underline-offset-2 cursor-pointer hover:text-content-dim"
        >Fix it</button>
      </div>
    {/if}
  </div>
</div>

<!-- iOS native composer (Caveat #6): the dropdown above lives inside the
     zero-footprint / pointer-events:none web chrome, so on iOS it can't be seen
     or tapped. Render the same candidates in a position:fixed overlay floated
     ABOVE the native pill (outside the hidden chrome) so it's visible + tappable.
     Only when this instance currently owns the native pill (nativeChromeHidden)
     so a buried/inactive composer never paints a stray list. Selection routes
     back through the existing selectMention(), which pushes the chosen token
     into the native pill via the bridge. -->
{#if onIOS && nativeChromeHidden() && mentionActive && mentionCandidates.length > 0}
  <MobileMentionList
    items={mentionCandidates}
    selectedIndex={mentionIndex}
    heading={mentionHeading}
    onSelect={selectMention}
    onHover={(i) => (mentionIndex = i)}
    pillHeight={nativeComposerHeight}
  />
{/if}

<!-- iOS formatting toolbar (#13 P1): same problem as the mention dropdown — the
     web ComposerToolbar lives inside the zero-footprint / pointer-events:none
     web chrome, so on iOS it's invisible + untappable. Surface the SAME toolbar
     in a position:fixed bar above the native pill, toggled by an "Aa"
     affordance. Only when this instance owns the pill (nativeChromeHidden) and
     no mention/slash overlay is active (so the two fixed overlays never share
     the strip above the pill). Handlers route through the same toggle* funcs
     the web toolbar uses; on iOS those operate on the native selection and push
     via the bridge (useNativeComposer / pushNative). -->
<!-- iOS formatting toolbar is now NATIVE: the pill's UITextView inputAccessoryView
     (see CyborgPushPlugin.makeComposerFormatBar). It rides the keyboard so taps
     never dismiss it or drop the selection — which the web-overlay bar here
     couldn't do. Native buttons fire `composer:format` → onFormat → the same
     toggle* funcs (handleNativeFormat above). The web MobileFormatToolbar is
     retained only for any non-iOS surface that might mount this composer. -->
{#if onIOS && false}
  <MobileFormatToolbar
    onToggleBold={toggleBold}
    onToggleItalic={toggleItalic}
    onToggleStrike={toggleStrike}
    onToggleOrderedList={toggleOrderedList}
    onToggleBulletList={toggleBulletList}
    onToggleBlockquote={toggleBlockquote}
    onToggleCode={toggleCode}
    onToggleCodeBlock={toggleCodeBlock}
    onLinkClick={openLinkModal}
    pillHeight={nativeComposerHeight}
  />
{/if}

<!-- iOS link modal (#13 P1): rendered OUTSIDE the hidden composer chrome (whose
     opacity:0 would also hide a fixed descendant) as a centered fixed overlay.
     Only when this instance owns the native pill, so a buried composer can't pop
     a stray modal. Inserts at the native caret via handleLinkSave/insertAtCursor. -->
{#if onIOS && nativeChromeHidden()}
  <ComposerLinkModal
    open={linkModalOpen}
    initialText={linkInitialText}
    ios
    onSave={handleLinkSave}
    onClose={() => { linkModalOpen = false; }}
  />
{/if}
