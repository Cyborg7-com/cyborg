<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { toast } from "svelte-sonner";
  import { reportClientError } from "@cyborg7/observability/web";
  import { createDictation } from "$lib/composer/dictation.svelte.js";
  import {
    agentStreamState,
    daemonStatusState,
    providerState,
    resumePickerState,
    sessionState,
    sendAgentPrompt,
    cancelAgent,
    fetchAgentCommands,
    fetchAgentFileSuggestions,
    fetchProviders,
    setAgentModel,
    setAgentMode,
    setAgentThinking,
  } from "$lib/state/app.svelte.js";
  import type { Agent, AgentSlashCommand } from "$lib/types.js";
  import { PROVIDER_LABELS } from "$lib/agent-display.js";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import SlashCommandPalette from "./SlashCommandPalette.svelte";
  import FileMentionPalette, { type FileEntry } from "./FileMentionPalette.svelte";
  import QueuedPromptList from "./QueuedPromptList.svelte";
  import ContextWindowMeter from "./ContextWindowMeter.svelte";
  import CombinedModelSelector from "$lib/components/agents/components/CombinedModelSelector.svelte";
  import ComposerAttachments from "$lib/components/composer/ComposerAttachments.svelte";
  import { createAttachmentUploads } from "$lib/composer/attachment-uploads.svelte.js";
  import { formatSize } from "$lib/utils.js";
  import { MAX_ATTACHMENT_BYTES } from "$lib/core/client.js";

  let { agent }: { agent: Agent } = $props();

  // Attachment affordance (#579) — same upload pipeline + pill renderer the
  // channel composer uses, shared via createAttachmentUploads + ComposerAttachments.
  const uploads = createAttachmentUploads();
  let fileInput: HTMLInputElement | undefined = $state();
  let isDragOver = $state(false);
  let dragCounter = $state(0);
  const maxAttachmentLabel = formatSize(MAX_ATTACHMENT_BYTES);

  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) uploads.addFiles(input.files);
    input.value = "";
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          const ext = item.type.split("/")[1] ?? "png";
          images.push(new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: item.type }));
        }
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      uploads.addFiles(images);
    }
  }

  function handleDragEnter(e: DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragCounter += 1;
    if (dragCounter === 1) isDragOver = true;
  }
  function handleDragOver(e: DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
  function handleDragLeave(e: DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) isDragOver = false;
  }
  function handleDrop(e: DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragCounter = 0;
    isDragOver = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) uploads.addFiles(files);
  }

  // Fetch the catalog of THIS agent's daemon. An un-targeted fetch is answered
  // by an arbitrary daemon in multi-daemon workspaces — its catalog may not
  // contain this agent's provider, which silently collapses the model menu to a
  // static label (the recurring "selector disabled after login" bug).
  onMount(() => {
    if (agent.daemonId) {
      if (!providerState.byDaemon[agent.daemonId]) fetchProviders(agent.daemonId);
    } else if (providerState.list.length === 0 && !providerState.loading) {
      fetchProviders();
    }
  });

  // Self-heal: if the daemon wasn't connected at mount (fresh login race), the
  // fetch above failed/yielded nothing — retry when it reports online. Gated by
  // the PER-DAEMON in-flight flag (a global one would dedupe wrongly across
  // composers for different daemons); fetchProviders also self-dedupes.
  $effect(() => {
    if (
      agent.daemonId &&
      daemonStatusState.get(agent.daemonId) === "online" &&
      !providerState.byDaemon[agent.daemonId] &&
      !providerState.loadingDaemons[agent.daemonId]
    ) {
      fetchProviders(agent.daemonId);
    }
  });

  // Seed the stream store from this agent's snapshot so the mode/thinking pills
  // reflect the provider's real modes on open. Non-ACP providers (Claude, Codex,
  // Pi, OpenCode) never emit the *_changed events the store otherwise relies on,
  // so without this the mode pill is stuck on the generic default/bypass
  // fallback and thinking shows blank. hydrateFromSnapshot fills gaps only, so
  // it never clobbers a live event.
  $effect(() => {
    agentStreamState.hydrateFromSnapshot(agent.agentId, {
      availableModes: agent.availableModes,
      currentModeId: agent.modeId,
      thinkingOptionId: agent.thinkingOptionId,
    });
  });

  let promptText = $state("");
  let sending = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let slashCommands: AgentSlashCommand[] = $state([]);
  let showSlashPalette = $state(false);
  let commandsFetched = $state(false);
  let commandsLoading = $state(false);
  let palette: SlashCommandPalette | undefined = $state();

  // Cyborg builtins surfaced ONLY in a Claude agent session — the session-level
  // /status + /resume actions (moved here from the channel composer, where they
  // never belonged). These are CLIENT-side: handleSlashSelect INTERCEPTS them and
  // never sends them to the agent. `builtin` distinguishes them from the
  // provider's real slash commands (which only carry name/description/argumentHint).
  const CYBORG_SLASH_BUILTINS: AgentSlashCommand[] = [
    { name: "status", description: "Show this session's status", argumentHint: "", builtin: "status" },
    { name: "resume", description: "Resume a past session", argumentHint: "", builtin: "resume" },
  ];

  // Only Claude sessions get the cyborg builtins (resume/status are Claude-scoped:
  // the session picker imports Claude transcripts, and a non-Claude provider never
  // exposes these). Matches the thinking-effort provider test below.
  const isClaudeSession = $derived.by(() => {
    const p = (agent.provider ?? "").toLowerCase();
    return p.includes("claude") || p.includes("anthropic");
  });

  // The palette list: cyborg builtins FIRST, then the provider's fetched commands
  // (Claude only). Non-Claude sessions see exactly the provider catalog, unchanged.
  const paletteCommands = $derived(
    isClaudeSession ? [...CYBORG_SLASH_BUILTINS, ...slashCommands] : slashCommands,
  );

  // Ephemeral, client-side /status panel (no server round-trip) — shows the
  // session facts the client already holds. Toggled by the /status builtin.
  let showStatus = $state(false);
  const runtimeInfo = $derived(agentStreamState.getRuntimeInfo(agent.agentId));
  const statusProviderLabel = $derived(PROVIDER_LABELS[agent.provider] ?? agent.provider);
  const statusName = $derived(agent.cyboName ?? statusProviderLabel);

  // #581: @-file/dir autocomplete. The mention spans from `mentionStart` (the `@`)
  // to the caret; `fileEntries` is the daemon's workspace-cwd search result.
  let showFilePalette = $state(false);
  let fileEntries: FileEntry[] = $state([]);
  let fileLoading = $state(false);
  let mentionStart = $state(-1);
  let filePalette: FileMentionPalette | undefined = $state();
  // Monotonic id so a slow search can't overwrite a newer one's results.
  let fileFetchSeq = 0;
  let fileDebounce: ReturnType<typeof setTimeout> | undefined;

  // Clear a pending search timer on unmount so a debounced fetch can't fire (and
  // touch state) after the composer is gone.
  onDestroy(() => {
    if (fileDebounce) clearTimeout(fileDebounce);
  });

  // Find an active `@`-mention at the caret: the last `@` that is preceded by
  // start-of-text or whitespace (so `user@host` doesn't trigger) and is followed
  // only by non-whitespace up to the caret. Returns the `@` index + the query
  // typed after it, or null when there's no mention in progress.
  function findActiveMention(text: string, caret: number): { start: number; query: string } | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at === -1) return null;
    if (at > 0 && !/\s/.test(before[at - 1])) return null;
    const query = before.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  let showModeMenu = $state(false);
  let showThinkingMenu = $state(false);

  let switchingModel = $state(false);
  let switchingMode = $state(false);
  let switchingThinking = $state(false);

  const turnStatus = $derived(agentStreamState.getTurnStatus(agent.agentId));
  const pendingPerms = $derived(agentStreamState.getPendingPermissions(agent.agentId));
  const currentModel = $derived(agentStreamState.getModel(agent.agentId));
  const currentModeId = $derived(agentStreamState.getModeId(agent.agentId));
  const streamModes = $derived(agentStreamState.getAvailableModes(agent.agentId));
  const thinkingOptionId = $derived(agentStreamState.getThinkingOptionId(agent.agentId));
  // Live token-usage / context-window / cost for the meter (#580). Fed by the
  // stream's turn_completed / usage_updated; null until the first turn reports.
  const usage = $derived(agentStreamState.getUsage(agent.agentId));
  // Running = the live turn stream says so, OR the agent's authoritative lifecycle
  // (from the server snapshot, kept synced on turn events in workspaceState.agents)
  // does. The ephemeral stream map can be missing/stale after navigating away and
  // back (e.g. cleared on workspace switch, or events not seen while unmounted),
  // which would otherwise drop STOP + QUEUE even though the agent is still
  // generating. lifecycle reverts to "idle" when the turn completes, so SEND
  // returns normally.
  const isRunning = $derived(turnStatus === "running" || agent.lifecycle === "running");
  // Input is NOT disabled while running anymore — submitting then queues the
  // prompt. Only an in-flight send or a pending permission blocks the input.
  // ── Voice dictation (#582): a mic button that transcribes speech into the
  // prompt via the Web Speech API. Hidden entirely when the browser has no
  // SpeechRecognition (Firefox, most in-app/Tauri webviews) — graceful fallback,
  // the rest of the composer is untouched. `dictationBase` is the prompt text at
  // the moment dictation starts, so the transcript appends instead of clobbering.
  let dictationBase = "";
  const dictation = createDictation({
    onTranscript: (transcript) => {
      promptText = dictationBase + transcript;
      void tick().then(autoResize);
    },
    onError: (err) => {
      if (err === "not-allowed" || err === "service-not-allowed") {
        toast.error("Microphone access denied — enable it to dictate.");
      }
    },
  });

  function toggleDictation() {
    if (!dictation.listening) {
      // Append to existing text (with a separating space), don't overwrite it.
      dictationBase = promptText.trim().length > 0 ? promptText.replace(/\s*$/, "") + " " : "";
      textarea?.focus();
    }
    dictation.toggle();
  }

  onDestroy(() => dictation.dispose());

  // While dictation is live, disable the textarea + send/queue: the transcript
  // callback rewrites promptText on every result, so simultaneous typing/sending
  // would race and clobber. The mic button itself uses `micDisabled` (no
  // listening term) so it stays clickable to STOP dictation.
  const inputDisabled = $derived(sending || pendingPerms.length > 0 || dictation.listening);
  const micDisabled = $derived(sending || pendingPerms.length > 0);
  const queued = $derived(agentStreamState.getQueue(agent.agentId));

  const isCybo = $derived(!!agent.cyboId);
  // The provider entry for THIS agent's daemon, wrapped as the single-provider
  // catalog the shared CombinedModelSelector expects.
  const selectorProvider = $derived(
    providerState.forDaemon(agent.daemonId).find((p) => p.id === agent.provider),
  );
  // Modes for the pill before the agent stream sends mode_changed: prefer the
  // live stream modes, then the provider catalog's modes (correct for Codex and
  // other non-Claude daemons), and only then the Claude default/bypass pair.
  const availableModes = $derived.by(() => {
    if (streamModes.length > 0) return streamModes;
    if (selectorProvider?.modes && selectorProvider.modes.length > 0) return selectorProvider.modes;
    return [
      { id: "default", label: "Default" },
      { id: "bypassPermissions", label: "Bypass Permissions" },
    ];
  });
  const models = $derived(selectorProvider?.models ?? []);
  const selectorProviders = $derived(selectorProvider ? [selectorProvider] : []);
  // Cybos can switch model too, but for the LIVE session only — setAgentModel
  // changes the running agent; we don't persist to cybo.json, so a re-spawn
  // reverts to the cybo's configured model.
  const canSwitchModel = $derived(models.length > 1 && !switchingModel && !isRunning);

  // Thinking / reasoning-effort options, scoped to what the ACTIVE provider
  // actually supports so we never offer a value the model silently ignores (#842).
  // Sets are sourced from the provider definitions: Claude (ClaudeThinkingEffort:
  // low/medium/high/xhigh/max), Pi (PiThinkingLevel: minimal/low/medium/high/xhigh),
  // Codex (reasoning_effort passthrough — standard low/medium/high). "brief"/"verbose"
  // are legacy Cyborg-only and not a provider effort level. Unknown providers fall
  // back to the full list so we never UNDER-offer a value the daemon would accept.
  const ALL_THINKING_OPTIONS: { id: string; label: string }[] = [
    { id: "disabled", label: "Off" },
    { id: "minimal", label: "Effort: Minimal" },
    { id: "low", label: "Effort: Low" },
    { id: "medium", label: "Effort: Medium" },
    { id: "high", label: "Effort: High" },
    { id: "xhigh", label: "Effort: Extra high" },
    { id: "max", label: "Effort: Max" },
    { id: "brief", label: "Brief" },
    { id: "verbose", label: "Verbose" },
  ];
  function thinkingIdsForProvider(providerId: string | undefined): string[] | null {
    const p = (providerId ?? "").toLowerCase();
    if (p.includes("claude") || p.includes("anthropic"))
      return ["disabled", "low", "medium", "high", "xhigh", "max"];
    if (p === "pi" || p.startsWith("pi-") || p.startsWith("pi/"))
      return ["disabled", "minimal", "low", "medium", "high", "xhigh"];
    if (p.includes("codex")) return ["disabled", "minimal", "low", "medium", "high"];
    return null; // unknown provider → offer everything (never under-offer)
  }
  const thinkingOptions = $derived.by(() => {
    const ids = thinkingIdsForProvider(selectorProvider?.id ?? agent.provider);
    if (!ids) return ALL_THINKING_OPTIONS;
    return ALL_THINKING_OPTIONS.filter((o) => ids.includes(o.id));
  });

  function shortModel(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1];
  }

  const displayModel = $derived.by(() => {
    if (currentModel) return shortModel(currentModel);
    if (agent.model) return shortModel(agent.model);
    return null;
  });

  const displayMode = $derived(
    currentModeId
      ? (availableModes.find((m) => m.id === currentModeId)?.label ?? currentModeId)
      : null,
  );

  // A "bypass" mode removes the human approval gate for tool calls
  // (Claude bypassPermissions, Codex danger-full-access, etc.). We surface it in
  // red so it can never be silently left on.
  function isBypassMode(modeId: string | null | undefined): boolean {
    if (!modeId) return false;
    const id = modeId.toLowerCase();
    return (
      id.includes("bypass") ||
      id.includes("full-access") ||
      id.includes("full_access") ||
      id.includes("danger") ||
      id.includes("yolo")
    );
  }
  const isDangerMode = $derived(isBypassMode(currentModeId));

  async function handleModelSelect(modelId: string) {
    switchingModel = true;
    try {
      await setAgentModel(agent.agentId, modelId || null, agent.daemonId ?? undefined);
    } catch (err) {
      reportClientError({
        source: "AgentComposer.setAgentModel",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't change model");
    }
    switchingModel = false;
  }

  async function handleModeSelect(modeId: string) {
    showModeMenu = false;
    if (!modeId) return;
    switchingMode = true;
    try {
      await setAgentMode(agent.agentId, modeId, agent.daemonId ?? undefined);
    } catch (err) {
      reportClientError({
        source: "AgentComposer.setAgentMode",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't change mode");
    }
    switchingMode = false;
  }

  async function handleThinkingSelect(value: string) {
    showThinkingMenu = false;
    const thinkingValue = value === "disabled" ? null : value;
    switchingThinking = true;
    try {
      await setAgentThinking(agent.agentId, thinkingValue, agent.daemonId ?? undefined);
    } catch (err) {
      reportClientError({
        source: "AgentComposer.setAgentThinking",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
      toast.error(
        err instanceof Error && err.message ? err.message : "Couldn't change thinking level",
      );
    }
    switchingThinking = false;
  }

  const slashFilter = $derived(
    showSlashPalette && promptText.startsWith("/")
      ? promptText.slice(1)
      : "",
  );

  async function handleSend() {
    const text = promptText.trim();
    // Send with text OR attachments alone (an image with no caption is valid).
    // Never while an eager upload is still in flight — the Attachment payload
    // isn't ready yet (the button is disabled, this is the keyboard guard).
    // No text AND no SUCCESSFULLY-uploaded attachment → nothing to send. Using
    // `uploaded.length` (not `hasAny`) means a lone attachment that errored out
    // can't slip an empty prompt past the guard.
    if ((!text && uploads.uploaded.length === 0) || inputDisabled || uploads.anyUploading)
      return;
    const attachments = uploads.uploaded;
    // Agent busy → park the prompt + its attachments in the client-side queue;
    // it flushes automatically (FIFO) when the current turn completes.
    if (isRunning) {
      agentStreamState.enqueue(agent.agentId, text, attachments);
      promptText = "";
      uploads.clear();
      showSlashPalette = false;
      closeFilePalette();
      if (textarea) textarea.style.height = "auto";
      return;
    }
    sending = true;
    showSlashPalette = false;
    closeFilePalette();
    try {
      await sendAgentPrompt(agent.agentId, text, attachments.length > 0 ? attachments : undefined);
      promptText = "";
      uploads.clear();
      if (textarea) textarea.style.height = "auto";
    } catch (err) {
      // Send failed — the prompt + attachments are intentionally NOT cleared
      // (cleared only on the success path above) so the user can retry. Surface it.
      reportClientError({
        source: "AgentComposer.sendAgentPrompt",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
        platform: "web",
      });
      // Surface the real reason (relay/daemon sends a clear message+code: no
      // spawn access, daemon offline, etc.) instead of a generic message (#842).
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't send prompt");
    } finally {
      sending = false;
    }
  }

  // Send/Queue is enabled when there's text or a SUCCESSFULLY-uploaded
  // attachment (not merely a pending/errored chip), the input isn't blocked,
  // and no upload is mid-flight — so a failed lone upload doesn't leave the
  // button enabled to fire an empty prompt.
  const canSend = $derived(
    (promptText.trim().length > 0 || uploads.uploaded.length > 0) &&
      !inputDisabled &&
      !uploads.anyUploading,
  );

  function handleCancel() {
    cancelAgent(agent.agentId);
  }

  // Pull a queued prompt back into the composer for editing (removes it from
  // the queue; re-submitting re-queues it at the end).
  function handleEditQueued(id: string) {
    const removed = agentStreamState.removeFromQueue(agent.agentId, id);
    if (removed) {
      promptText = removed.text;
      textarea?.focus();
    }
  }

  function handleCancelQueued(id: string) {
    agentStreamState.removeFromQueue(agent.agentId, id);
  }

  function handleSlashSelect(cmd: AgentSlashCommand) {
    // Cyborg builtins (/status, /resume) are CLIENT-side actions — intercept and
    // RETURN, never falling through to the provider send path. Clear the composer
    // so the typed "/" doesn't linger.
    if (cmd.builtin) {
      showSlashPalette = false;
      promptText = "";
      if (textarea) textarea.style.height = "auto";
      if (cmd.builtin === "resume") {
        resumePickerState.start(agent.channelId ?? null);
      } else if (cmd.builtin === "status") {
        showStatus = true;
      }
      return;
    }
    promptText = `/${cmd.name} `;
    showSlashPalette = false;
    textarea?.focus();
  }

  function closeFilePalette() {
    showFilePalette = false;
    mentionStart = -1;
    fileEntries = [];
    fileLoading = false;
    if (fileDebounce) clearTimeout(fileDebounce);
  }

  // #581: replace the in-progress `@mention` (from the `@` to the caret) with the
  // chosen path + a trailing space, then place the caret right after it.
  function handleFileSelect(entry: FileEntry) {
    if (mentionStart < 0 || !textarea) {
      closeFilePalette();
      return;
    }
    const caret = textarea.selectionStart ?? promptText.length;
    const insert = `@${entry.path}${entry.kind === "directory" ? "/" : " "}`;
    promptText = promptText.slice(0, mentionStart) + insert + promptText.slice(caret);
    const nextCaret = mentionStart + insert.length;
    closeFilePalette();
    textarea.focus();
    // Restore the caret after Svelte flushes the new value.
    queueMicrotask(() => textarea?.setSelectionRange(nextCaret, nextCaret));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (showFilePalette && filePalette?.handleKeydown(e)) {
      if (e.key === "Escape") closeFilePalette();
      return;
    }
    if (showSlashPalette && palette?.handleKeydown(e)) {
      if (e.key === "Escape") showSlashPalette = false;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // #581: detect an active `@`-mention at the caret and (debounced) fetch
  // file/dir suggestions from the agent's workspace. Called on every input.
  function updateFileMention() {
    const caret = textarea?.selectionStart ?? promptText.length;
    const mention = findActiveMention(promptText, caret);
    if (!mention) {
      if (showFilePalette) closeFilePalette();
      return;
    }
    showFilePalette = true;
    mentionStart = mention.start;
    fileLoading = true;
    const seq = ++fileFetchSeq;
    if (fileDebounce) clearTimeout(fileDebounce);
    fileDebounce = setTimeout(() => {
      fetchAgentFileSuggestions(agent.agentId, mention.query)
        .then((entries) => {
          // Ignore a stale response that resolved after a newer keystroke.
          if (seq === fileFetchSeq) fileEntries = entries;
          return entries;
        })
        .catch(() => {
          if (seq === fileFetchSeq) fileEntries = [];
        })
        .finally(() => {
          if (seq === fileFetchSeq) fileLoading = false;
        });
    }, 180);
  }

  function autoResize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";

    if (promptText === "/") {
      showSlashPalette = true;
      // Mark fetched only on SUCCESS so a failed first fetch (e.g. typed "/"
      // before the agent finished loading) retries instead of staying empty
      // forever. Don't refetch once we have a successful (even empty) result.
      if (!commandsFetched && !commandsLoading) {
        commandsLoading = true;
        fetchAgentCommands(agent.agentId)
          .then((cmds) => {
            slashCommands = cmds;
            commandsFetched = true;
            return cmds;
          })
          // intentional: slash-command palette prefetch; on failure commandsFetched stays false so the next "/" retries.
          .catch(() => {})
          .finally(() => {
            commandsLoading = false;
          });
      }
    } else if (!promptText.startsWith("/") || promptText.includes(" ")) {
      showSlashPalette = false;
    }

    // #581: the @-file mention is independent of the slash palette (it can start
    // anywhere in the prompt, not just at position 0).
    updateFileMention();
  }

  function closeAllMenus() {
    showModeMenu = false;
    showThinkingMenu = false;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-dropdown]")) {
      closeAllMenus();
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="bg-surface px-4 py-3">
  <div class="mx-auto max-w-3xl">
    <!-- Ephemeral /status panel (Claude session builtin) — client-held facts only,
         no server round-trip. Dismissible; lives above the input card. -->
    {#if showStatus}
      <div class="mb-2 rounded-2xl border border-edge bg-surface-alt px-4 py-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-content">Session status</span>
          <button
            type="button"
            onclick={() => (showStatus = false)}
            class="flex h-6 w-6 items-center justify-center rounded-full text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
            aria-label="Dismiss status"
            title="Dismiss"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <dl class="mt-2 flex flex-col gap-1.5 text-[13px]">
          <div class="flex gap-3">
            <dt class="w-28 shrink-0 text-content-muted">Agent</dt>
            <dd class="min-w-0 flex-1 truncate text-content">{statusName}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-28 shrink-0 text-content-muted">Provider</dt>
            <dd class="min-w-0 flex-1 truncate text-content">{statusProviderLabel}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-28 shrink-0 text-content-muted">Model</dt>
            <dd class="min-w-0 flex-1 truncate text-content">{displayModel ?? "default"}</dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-28 shrink-0 text-content-muted">Session</dt>
            <dd class="min-w-0 flex-1 truncate font-mono text-content-dim">
              {runtimeInfo?.sessionId ? runtimeInfo.sessionId.slice(0, 12) : "not started yet"}
            </dd>
          </div>
          <div class="flex gap-3">
            <dt class="w-28 shrink-0 text-content-muted">Resumable</dt>
            <dd class="min-w-0 flex-1 truncate text-content">
              {sessionState.list.length} archived {sessionState.list.length === 1 ? "session" : "sessions"}
            </dd>
          </div>
        </dl>
      </div>
    {/if}

    <!-- Queued prompts (shown while the agent is busy) -->
    <QueuedPromptList queued={queued} onEdit={handleEditQueued} onCancel={handleCancelQueued} />

    <!-- Paseo-style input card (mobile: 18r pill per S4/S6) -->
    <div
      role="group"
      aria-label="Agent message composer"
      ondragenter={handleDragEnter}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
      class={cn(
        "flex flex-col gap-2 border bg-surface-alt px-4 py-3 transition-[border-color] duration-200 focus-within:border-content-muted/40",
        isDragOver ? "border-dashed border-btn-primary-bg" : "border-edge",
        viewportState.isMobile ? "rounded-[18px]" : "rounded-2xl",
      )}
    >
      <!-- Attachment preview pills (above the textarea, like the channel composer) -->
      {#if uploads.files.length > 0}
        <ComposerAttachments
          files={uploads.files}
          onRemove={(id) => uploads.removeFile(id)}
          onRetry={(id) => uploads.retry(id)}
        />
      {/if}
      {#if uploads.rejected.length > 0}
        <p class="text-[11.5px] text-error">
          {uploads.rejected.map((r) => r.name).join(", ")}
          {uploads.rejected.length > 1 ? "are" : "is"} too large (max {maxAttachmentLabel}).
        </p>
      {/if}

      <!-- Textarea -->
      <div class="relative">
        {#if showSlashPalette}
          <SlashCommandPalette
            bind:this={palette}
            commands={paletteCommands}
            filter={slashFilter}
            onselect={handleSlashSelect}
          />
        {/if}
        {#if showFilePalette}
          <FileMentionPalette
            bind:this={filePalette}
            entries={fileEntries}
            loading={fileLoading}
            onselect={handleFileSelect}
          />
        {/if}
        <textarea
          bind:this={textarea}
          bind:value={promptText}
          onkeydown={handleKeydown}
          oninput={autoResize}
          onpaste={handlePaste}
          placeholder={isRunning ? "Queue a message…" : "Message agent..."}
          rows={1}
          disabled={inputDisabled}
          class={cn(
            "w-full resize-none bg-transparent text-content placeholder:text-content-muted outline-none min-h-[24px] max-h-[200px] leading-relaxed",
            // 16px on mobile: anything smaller makes iOS WebKit zoom the page
            // on focus. Desktop keeps the themed text-sm.
            viewportState.isMobile ? "text-[16px]" : "text-sm",
          )}
          style:caret-color="var(--caret-color)"
        ></textarea>
      </div>

      <!-- Button row -->
      <div class="flex items-end justify-between -mx-1.5">
        <!-- Left group: attach + status pills. flex-wrap so on a narrow (mobile)
             viewport the mode/thinking pills wrap to a second line instead of
             being clipped or pushed out of view behind the send button. -->
        <div class="flex min-w-0 flex-1 shrink flex-wrap items-end gap-x-0.5 gap-y-1">
          <!-- Attach button (image/file picker) — drag-drop + paste also work -->
          <input
            bind:this={fileInput}
            type="file"
            multiple
            class="hidden"
            onchange={handleFileChange}
          />
          <button
            type="button"
            onclick={() => fileInput?.click()}
            class={cn(
              "flex shrink-0 items-center justify-center text-content-muted transition-colors hover:bg-hover-gray",
              viewportState.isMobile ? "h-[28px] w-[28px] rounded-full" : "h-7 w-7 rounded-full",
            )}
            title="Attach files"
            aria-label="Attach files"
          >
            <!-- Paperclip icon -->
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>

          <!-- Model pill — shrink-0 like the other pills so it wraps as a unit
               instead of being the lone shrink target (which would truncate the
               model name first on a tight line). Its own label still caps at
               max-w-[120px]. Wrapper div is fine: the dropdown anchors to the
               selector's internal .relative, not this element. -->
          {#if models.length > 1 || displayModel || isCybo}
            <div class="shrink-0">
              <CombinedModelSelector
                providers={selectorProviders}
                value={currentModel ?? agent.model ?? null}
                disabled={!canSwitchModel}
                loading={providerState.loading}
                openUp
                triggerClass={viewportState.isMobile
                  ? "h-[28px] gap-1.5 rounded-full bg-raised px-3 font-lato text-[13px] text-content-dim"
                  : undefined}
                onSelect={handleModelSelect}
              />
            </div>
          {/if}

          <!-- Mode pill (icon only, like Paseo's shield icon) -->
          {#if availableModes.length > 1 || displayMode}
            <div class="relative shrink-0" data-dropdown>
              <button
                onclick={() => { closeAllMenus(); if (availableModes.length > 1) showModeMenu = !showModeMenu; }}
                disabled={switchingMode || isRunning || availableModes.length <= 1}
                class={cn(
                  "flex items-center transition-colors",
                  viewportState.isMobile
                    ? cn(
                        "h-[28px] gap-1.5 rounded-full px-3 text-[13px]",
                        isDangerMode ? "bg-error/10 text-error" : "bg-raised text-content-dim",
                      )
                    : cn(
                        "h-7 justify-center rounded-full",
                        isDangerMode ? "gap-1 px-2 bg-error/10 text-error hover:bg-error/20" : "w-7 text-content-muted",
                        !isDangerMode && availableModes.length > 1 && "hover:bg-hover-gray",
                      ),
                  availableModes.length > 1 && "cursor-pointer",
                  "disabled:opacity-50",
                )}
                title={isDangerMode
                  ? `Mode: ${displayMode ?? "bypass"} — permission checks are OFF`
                  : `Mode: ${displayMode ?? "default"}`}
              >
                {#if isDangerMode}
                  <!-- Shield-off icon (permissions bypassed) -->
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19.7 14a8 8 0 0 0 .3-2V5l-8-3-3.2 1.2"/>
                    <path d="M4.7 4.7 4 5v7c0 6 8 10 8 10a16 16 0 0 0 3.7-2.4"/>
                    <line x1="2" y1="2" x2="22" y2="22"/>
                  </svg>
                  <span class={cn("font-medium", viewportState.isMobile ? "text-[13px]" : "text-[11px]")}>Bypass</span>
                {:else}
                  <!-- Shield icon -->
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    {#if currentModeId === "plan"}
                      <path d="M9 12l2 2 4-4" stroke="currentColor"/>
                    {/if}
                  </svg>
                  {#if viewportState.isMobile}
                    <span class="text-[13px]">{displayMode ?? "Default"}</span>
                  {/if}
                {/if}
              </button>

              {#if showModeMenu}
                <div class="absolute bottom-full left-0 z-50 mb-1 min-w-[140px] rounded-lg border border-edge bg-raised shadow-lg py-1">
                  {#each availableModes as mode (mode.id)}
                    <button
                      onclick={() => handleModeSelect(mode.id)}
                      class={cn(
                        "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover-gray",
                        isBypassMode(mode.id) ? "text-error" : "text-content-dim",
                        currentModeId === mode.id && "font-medium",
                        currentModeId === mode.id && !isBypassMode(mode.id) && "text-content",
                      )}
                    >
                      {#if isBypassMode(mode.id)}
                        <!-- Alert triangle: this mode disables permission prompts -->
                        <svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
                          <line x1="12" y1="9" x2="12" y2="13"/>
                          <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                      {/if}
                      {mode.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <!-- Thinking pill -->
          <div class="relative shrink-0" data-dropdown>
            <button
              onclick={() => { closeAllMenus(); showThinkingMenu = !showThinkingMenu; }}
              disabled={switchingThinking || isRunning}
              class={cn(
                "flex items-center transition-colors cursor-pointer",
                viewportState.isMobile
                  ? "h-[28px] gap-1.5 rounded-full bg-raised px-3 text-[13px] text-content-dim"
                  : "h-7 gap-1 rounded-2xl px-2 text-content-muted hover:bg-hover-gray",
                "disabled:opacity-50",
              )}
              title="Thinking: {thinkingOptionId ?? 'disabled'}"
            >
              <!-- Brain icon -->
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
                <line x1="9" y1="21" x2="15" y2="21"/>
              </svg>
              <span class={viewportState.isMobile ? "text-[13px]" : "text-[11px]"}>
                {#if thinkingOptionId && thinkingOptionId !== "disabled"}
                  {thinkingOptionId}
                {:else}
                  off
                {/if}
              </span>
              <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {#if showThinkingMenu}
              <div class="absolute bottom-full left-0 z-50 mb-1 min-w-[130px] rounded-lg border border-edge bg-raised shadow-lg py-1">
                {#each thinkingOptions as opt (opt.id)}
                  <button
                    onclick={() => handleThinkingSelect(opt.id)}
                    class={cn(
                      "flex w-full items-center px-3 py-1.5 text-left text-xs text-content-dim hover:bg-hover-gray transition-colors",
                      (thinkingOptionId ?? "disabled") === opt.id && "text-content font-medium",
                    )}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <!-- Context-window / token-usage + cost meter (#580). Renders nothing
               until the agent reports usage; degrades to whatever the provider
               gives. shrink-0 so it wraps with the other pills on mobile. -->
          <ContextWindowMeter usage={usage} compact={viewportState.isMobile} />
        </div>

        <!-- Right group: cancel + queue (running) or send (idle) -->
        <div class="flex shrink-0 items-center gap-1">
          <!-- Dictation mic (#582): only when the browser supports speech-to-text. -->
          {#if dictation.supported}
            <button
              type="button"
              onclick={toggleDictation}
              disabled={micDisabled}
              aria-label={dictation.listening ? "Stop dictation" : "Dictate message"}
              aria-pressed={dictation.listening}
              title={dictation.listening ? "Stop dictation" : "Dictate message"}
              class={cn(
                "flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                dictation.listening
                  ? "bg-error/15 text-error animate-pulse"
                  : "text-content-muted hover:bg-hover-gray hover:text-content",
              )}
            >
              <!-- mic icon -->
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </button>
          {/if}
          {#if isRunning}
            <button
              onclick={handleCancel}
              class="flex h-7 items-center gap-1 rounded-full bg-error/10 border border-error/30 px-3 text-[11px] font-medium text-error hover:bg-error/20 transition-colors"
            >
              <!-- Square icon (stop) -->
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1"/>
              </svg>
              Cancel
            </button>
            <button
              onclick={handleSend}
              disabled={!canSend}
              class="ml-1 flex h-7 items-center gap-1 rounded-full bg-hover-gray px-3 text-[11px] font-medium text-content transition-colors hover:bg-edge disabled:opacity-40 disabled:cursor-not-allowed"
              title="Queue message — sends when the agent finishes"
            >
              <!-- list-plus icon -->
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="11" y1="12" x2="3" y2="12"/>
                <line x1="16" y1="6" x2="3" y2="6"/>
                <line x1="11" y1="18" x2="3" y2="18"/>
                <line x1="18" y1="9" x2="18" y2="15"/>
                <line x1="21" y1="12" x2="15" y2="12"/>
              </svg>
              Queue
            </button>
          {:else}
            <button
              onclick={handleSend}
              disabled={!canSend}
              class="flex h-7 w-7 items-center justify-center rounded-full bg-btn-primary-bg text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-40 disabled:cursor-not-allowed ml-1"
              title="Send message"
            >
              {#if sending}
                <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20"/>
                </svg>
              {:else}
                <!-- ArrowUp icon -->
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5"/>
                  <polyline points="5 12 12 5 19 12"/>
                </svg>
              {/if}
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
