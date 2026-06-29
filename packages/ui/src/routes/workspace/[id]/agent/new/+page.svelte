<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    workspaceState,
    providerState,
    fetchProviders,
    createCybo,
    updateCybo,
    deleteCybo,
    fetchCybo,
    cyboState,
    agentsPaneState,
    daemonState,
    authState,
  } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import {
    cyboCapabilityFor,
    daemonDisplayName,
    isNativeHarnessRow,
    rowBackends,
    type CyboCapability,
  } from "$lib/cybo-capability.js";
  import { isApiKeyProvider, withApiKeyProviders, API_KEY_AUTH_MODE } from "$lib/provider-catalog.js";
  import ProviderDaemonStatus from "$lib/components/agents/components/ProviderDaemonStatus.svelte";
  import ApiKeyCredentialField from "$lib/components/agents/components/ApiKeyCredentialField.svelte";
  import StatusBadge from "$lib/plugins/agents/components/settings/StatusBadge.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import { cn } from "$lib/utils.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import ModelCombobox from "$lib/components/agents/components/ModelCombobox.svelte";
  import {
    derivePreset,
    PERMISSION_PRESETS,
    PLATFORM_PERMISSION_OPTIONS,
    presetPermissions,
    type PermissionPresetId,
  } from "$lib/permission-presets.js";

  // This page creates a reusable cybo TEMPLATE (a persona: identity +
  // personality + provider) — it does NOT launch a session. Templates show up
  // under Agents → Templates; live sessions launch from the "Create agent"
  // dialog in the Agents pane.

  // The daemon's NATIVE providers (cyborg:list_providers) PLUS the vendored
  // openai-compatible api-key providers (MiniMax/OpenRouter) from the catalog —
  // the daemon doesn't report those, so the wizard surfaces them from the
  // catalog snapshot (internal docs). Additive: native rows win
  // on id collision.
  const providers = $derived(withApiKeyProviders(providerState.list));
  const workspaceId = $derived(workspaceState.current?.id);

  let selectedProvider: string | null = $state(null);
  let formModel = $state("");
  let creating = $state(false);
  let error = $state("");

  const selectedProviderDef = $derived(
    providers.find((p) => p.id === selectedProvider) ?? null,
  );
  // An api-key (openai-compatible) provider authenticates with a per-daemon API
  // key (llm_auth_mode "api-key"), not a host login. Drives the credential field.
  const selectedIsApiKey = $derived(isApiKeyProvider(selectedProvider));

  // Per-daemon REAL capability for each provider row (internal docs item 3):
  // which online daemons can run a cybo with this backend TODAY (runtime
  // authenticated for it) vs. need setup. Daemons that predate the published
  // runtime profile fall into `unknown` → row keeps today's behavior.
  // Only daemons the user can run code on (owner OR daemon_access grant):
  // a foreign daemon must not be offered as a "Set up →" target, nor counted
  // as "configured" for a backend the user can't actually launch on.
  const onlineDaemons = $derived(daemonState.accessibleOnline);
  // The daemon a new session will launch on — its provider state is the
  // headline of the collapsed status line (#443).
  const targetDaemonId = $derived(daemonState.effectiveId(authState.user?.id));
  // Memoized per provider id ($derived map, not a per-row function call) so the
  // capability filter runs once per providers/daemons change, not per render.
  const EMPTY_CAPABILITY: CyboCapability = { configured: [], needsSetup: [], unknown: [] };
  const rowCapabilities = $derived(
    new Map(
      providers.map((p) => [
        p.id,
        // Native harnesses (internal docs) don't use runtime credentials — their
        // truth is the catalog's own `available` badge. Api-key providers
        // (MiniMax/OpenRouter) authenticate with a per-daemon API key surfaced by
        // the credential field below, NOT the PI runtime profile — so neither gets
        // the per-daemon runtime-credentials line.
        isNativeHarnessRow(p.id) || isApiKeyProvider(p.id)
          ? EMPTY_CAPABILITY
          : cyboCapabilityFor(rowBackends(p), onlineDaemons),
      ]),
    ),
  );
  function rowCapability(p: (typeof providers)[number]): CyboCapability {
    return rowCapabilities.get(p.id) ?? EMPTY_CAPABILITY;
  }
  const defaultModel = $derived(
    selectedProviderDef?.models.find((m) => m.isDefault)?.id ?? "",
  );

  $effect(() => {
    if (selectedProvider && selectedProviderDef) {
      formModel = defaultModel;
    }
  });

  // Providers for the daemon the cybo will launch on (#443): targeting the
  // effective daemon (instead of letting the relay pick an arbitrary one)
  // makes the catalog match the launch target, and engages the per-daemon
  // cache in providerState.byDaemon for instant rows on revisit. Daemons load
  // async with the workspace, so refetch when the target resolves/changes —
  // never downgrade back to the arbitrary (null-target) fetch.
  let providersFetchedFor = $state<string | null | false>(false);
  $effect(() => {
    const target = targetDaemonId;
    if (providersFetchedFor === target || (providersFetchedFor !== false && target === null)) {
      return;
    }
    providersFetchedFor = target;
    void fetchProviders(target ?? undefined);
  });

  // ─── Home daemon (problem 4) ──────────────────────────────────────────
  // The cybo's explicit "home" computer — the machine it lives on / runs on,
  // chosen here at creation and carried authoritatively across daemons. Only
  // daemons the user can actually run code on are offered (owner OR access
  // grant), mirroring the spawn-target guard. The user may pick any of them;
  // when left unset we default to the sponsor/selected daemon (targetDaemonId).
  let homeDaemonId = $state<string | null>(null);
  // userPickedHomeDaemon distinguishes "user hasn't touched it" (track the live
  // default) from "user explicitly chose one" (don't override their pick).
  let userPickedHomeDaemon = $state(false);
  // Daemons the user may home a cybo on (online + accessible). The current home
  // (in edit mode) is unioned in even if offline, so an offline home isn't
  // silently dropped from the picker.
  const homeDaemonChoices = $derived.by(() => {
    const list = [...daemonState.accessibleOnline];
    if (homeDaemonId && !list.some((d) => d.id === homeDaemonId)) {
      const existing = daemonState.byId(homeDaemonId);
      if (existing) list.push(existing);
    }
    return list;
  });
  // Track the effective default until the user picks explicitly (or we prefill an
  // existing cybo's saved home in edit mode).
  $effect(() => {
    if (userPickedHomeDaemon || isEditing) return;
    homeDaemonId = targetDaemonId;
  });
  const homeDaemonLabel = $derived.by(() => {
    if (!homeDaemonId) return "Auto (sponsor daemon)";
    const d = daemonState.byId(homeDaemonId);
    return d ? daemonDisplayName(d) : homeDaemonId;
  });
  // Problem 4 (Part 1): a SHORT, readable daemon name for the prominent header
  // indicator — never the muted "Auto (sponsor daemon)" longform. When Auto, we
  // resolve the effective sponsor daemon's real name so the user always sees the
  // machine the cybo will actually run on, not an opaque "Auto".
  const homeDaemonShortName = $derived.by(() => {
    const id = homeDaemonId ?? targetDaemonId;
    if (!id) return "Auto";
    const d = daemonState.byId(id);
    return d ? daemonDisplayName(d) : id;
  });
  // Sentinel for the "Auto" option (Select values are strings; null isn't one).
  const HOME_DAEMON_AUTO = "__auto__";
  function onHomeDaemonChange(v: string): void {
    userPickedHomeDaemon = true;
    homeDaemonId = v === HOME_DAEMON_AUTO ? null : v;
  }

  // ─── Identity / personality ──────────────────────────────────────────
  type SectionId = "identity" | "voice" | "model" | "abilities" | "schedule";
  let activeSection = $state<SectionId>("identity");
  let displayName = $state("");
  let handleName = $state("");
  let jobTitle = $state("");
  let voiceTraits = $state<string[]>([]);
  let showPowerUserPrompt = $state(false);

  const VOICE_OPTIONS = [
    { id: "warm",     label: "Warm",     sub: "A real person on a good day" },
    { id: "brief",    label: "Brief",    sub: "Says the thing, then stops" },
    { id: "thorough", label: "Thorough", sub: "Shows their work, every time" },
    { id: "direct",   label: "Direct",   sub: "No hedging" },
    { id: "playful",  label: "Playful",  sub: "A touch of humor" },
    { id: "formal",   label: "Formal",   sub: "Reads like a memo" },
  ];

  function toggleVoice(id: string) {
    if (voiceTraits.includes(id)) {
      voiceTraits = voiceTraits.filter((v) => v !== id);
    } else if (voiceTraits.length < 3) {
      voiceTraits = [...voiceTraits, id];
    } else {
      voiceTraits = [...voiceTraits.slice(1), id];
    }
  }

  // ─── Permissions ──────────────────────────────────────────────────
  // Backed by the cybo column platform_permissions (enforced at spawn, #176).
  // Presented as role PRESETS over the same array (#444, internal docs) — the
  // fine-grained toggles live behind Customize. Off-platform capabilities
  // (file edits / bash / network / git push) were UI-only and never enforced,
  // so they were removed (post-MVP) rather than shown as a false security
  // promise. See internal docs
  let platformPermissions = $state<string[]>(presetPermissions("collaborator"));
  // Derived, never assigned: hand-tuned sets that match a preset snap back to
  // it automatically; anything else reads as Custom.
  const permissionPreset = $derived(derivePreset(platformPermissions));
  let customizeOpen = $state(false);

  function selectPermissionPreset(id: PermissionPresetId) {
    platformPermissions = presetPermissions(id);
    customizeOpen = false;
  }

  function togglePlatformPermission(id: string) {
    platformPermissions = platformPermissions.includes(id)
      ? platformPermissions.filter((v) => v !== id)
      : [...platformPermissions, id];
  }

  // Handle auto-derives from display name until the user types in the field.
  let handleDirty = $state(false);
  const derivedHandle = $derived(
    displayName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24),
  );
  $effect(() => {
    if (!handleDirty) handleName = derivedHandle;
  });

  // Avatar (URL or data URL). Set by Generate or Upload.
  let avatarUrl = $state<string | null>(null);
  let generatingAvatar = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  // Separate ref for the mobile single-column layout's file input — only one
  // branch (desktop vs mobile) renders at a time, so each owns its own input.
  let mobileFileInput: HTMLInputElement | undefined = $state();

  // Initials for the preview avatar fallback (cleaner than a generic glyph).
  const previewInitials = $derived(
    displayName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
  );

  // Built-in agent portraits (jpegs under /static/agent-avatars/).
  const AGENT_AVATARS: { src: string; label: string }[] = [
    { src: "/agent-avatars/01-tactical-cartoon.jpeg",          label: "Tactical" },
    { src: "/agent-avatars/02-two-tone-cartoon.jpeg",          label: "Two-tone" },
    { src: "/agent-avatars/03-cyborg-sage-in-tech-jacket.jpeg",label: "Cyborg sage" },
    { src: "/agent-avatars/04-cyborg-sage-with-tech-jacket.jpeg",label: "Tech sage" },
    { src: "/agent-avatars/05-elite-hacker-with-headphones.jpeg",label: "Elite hacker" },
    { src: "/agent-avatars/06-female-analyst-with-eye-patch.jpeg",label: "Eye-patch analyst" },
    { src: "/agent-avatars/07-female-strategist-arms-crossed.jpeg",label: "Strategist" },
    { src: "/agent-avatars/08-genius-engineer-in-lab-coat.jpeg",label: "Lab-coat engineer" },
    { src: "/agent-avatars/09-hacker-with-headphones-and-hood.jpeg",label: "Hooded hacker" },
    { src: "/agent-avatars/10-inventor-with-goggles.jpeg",     label: "Inventor" },
    { src: "/agent-avatars/11-samurai-coder-in-armor-focused.jpeg",label: "Samurai coder" },
    { src: "/agent-avatars/12-sly-female-analyst-with-eye.jpeg",label: "Sly analyst" },
  ];

  async function generateAvatar() {
    if (generatingAvatar) return;
    generatingAvatar = true;
    // Brief "thinking" pause so it feels like generation. Vary the delay
    // so re-rolls don't feel mechanical.
    const delay = 1400 + Math.floor(Math.random() * 1100);
    await new Promise((r) => setTimeout(r, delay));
    // Pick a random portrait that isn't the current one.
    const pool = AGENT_AVATARS.filter((a) => a.src !== avatarUrl);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? AGENT_AVATARS[0];
    avatarUrl = next.src;
    generatingAvatar = false;
  }

  function handleAvatarFile(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    // Match the onboarding flow's guardrails: images only, capped at 5MB —
    // a huge file converted to a data URL can hang or crash the tab.
    if (!file.type.startsWith("image/")) {
      error = "Please select a valid image file.";
      target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      error = "Image must be under 5MB.";
      target.value = "";
      return;
    }
    error = "";
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") avatarUrl = reader.result;
    });
    reader.readAsDataURL(file);
    target.value = "";
  }

  // Auto-generated personality prompt that updates from selected traits
  // until the user overrides it via the editor.
  let personalityPrompt = $state("");
  let personalityPromptDirty = $state(false);

  const generatedPersonalityPrompt = $derived.by(() => {
    const name = displayName.trim() || "this agent";
    const role = jobTitle.trim();
    const traits = voiceTraits
      .map((id) => VOICE_OPTIONS.find((v) => v.id === id))
      .filter((v): v is { id: string; label: string; sub: string } => !!v);

    const lines: string[] = [];
    lines.push(`You are ${name}${role ? `, ${role}` : ""}.`);
    if (traits.length > 0) {
      lines.push("");
      lines.push("Personality:");
      for (const t of traits) {
        lines.push(`- ${t.label} — ${t.sub.toLowerCase()}`);
      }
    }
    lines.push("");
    lines.push("Speak as a real teammate. Don't hedge, don't pad, don't apologize for things you didn't do.");
    return lines.join("\n");
  });

  $effect(() => {
    if (!personalityPromptDirty) {
      personalityPrompt = generatedPersonalityPrompt;
    }
  });

  function resetPersonalityPrompt() {
    personalityPromptDirty = false;
    personalityPrompt = generatedPersonalityPrompt;
  }

  // ?edit=<cyboId>: edit an existing template — same form, pre-filled from the
  // cybo, saving via update instead of create. The slug is immutable (sessions
  // and mentions reference it), so the handle field locks in edit mode.
  const editCyboId = $derived(page.url.searchParams.get("edit"));
  const isEditing = $derived(!!editCyboId);
  // Track the applied id (not a boolean) so navigating from editing one
  // template straight to another re-populates — SvelteKit reuses the page
  // component across query-param changes.
  let lastAppliedEditId = $state<string | null>(null);

  // Edit-mode load state (#442): the form is a skeleton until the saved
  // identity AND soul are in hand — editing a blind form is how souls got
  // silently replaced. A failed soul load is surfaced with a retry and keeps
  // Save blocked (saving without the soul loaded would overwrite it unseen).
  let soulLoad = $state<"idle" | "loading" | "loaded" | "error">("idle");
  let soulLoadError = $state("");

  // Rebuild the Personality trait chips from the saved soul (#442). The wizard
  // writes trait lines as "- <Label> — <sub>"; parse those back so editing
  // shows the chips that were chosen at creation (recognition over recall).
  // Decision — parse-from-soul over persisting traits as metadata: the soul is
  // the single source of truth for the persona, so there's nothing to drift;
  // hand-written souls simply yield no chips (nothing falsely highlighted).
  function traitsFromSoul(soul: string): string[] {
    return VOICE_OPTIONS.filter((v) => soul.includes(`- ${v.label} — `))
      .map((v) => v.id)
      .slice(0, 3);
  }

  function loadSoul(id: string): void {
    soulLoad = "loading";
    soulLoadError = "";
    fetchCybo(id)
      .then((full) => {
        // Guard on the LIVE edit id, not lastAppliedEditId: leaving edit mode
        // (?edit removed → "New cybo" on the same reused component) nulls
        // editCyboId but not lastAppliedEditId, and a stale resolution would
        // overwrite the fresh form (review).
        if (editCyboId !== id) return;
        if (!full) {
          soulLoad = "error";
          soulLoadError = "The daemon answered but didn't return this cybo.";
          return;
        }
        voiceTraits = traitsFromSoul(full.soul);
        // A wizard-generated soul (matches what the current traits/name/role
        // would generate) stays live: the auto-generator keeps owning it so the
        // chips remain functional in edit mode. A custom soul stays dirty so
        // nothing regenerates over it.
        if (full.soul.trim() === generatedPersonalityPrompt.trim()) {
          personalityPromptDirty = false;
        }
        personalityPrompt = full.soul;
        soulLoad = "loaded";
      })
      .catch((err) => {
        if (editCyboId !== id) return;
        soulLoad = "error";
        soulLoadError = err instanceof Error ? err.message : "Connection to the daemon failed.";
      });
  }

  $effect(() => {
    if (!editCyboId || lastAppliedEditId === editCyboId) return;
    const cybo = cyboState.list.find((c) => c.id === editCyboId);
    if (!cybo) return; // cyboState loads with the workspace; retry on next run
    lastAppliedEditId = editCyboId;
    displayName = cybo.name;
    handleName = cybo.slug;
    handleDirty = true;
    jobTitle = cybo.role ?? "";
    avatarUrl = cybo.avatar && !cybo.avatar.match(/^\p{Emoji}$/u) ? cybo.avatar : null;
    selectedProvider = cybo.provider;
    if (cybo.model) formModel = cybo.model;
    // The saved home daemon (problem 4). Treat it as the user's choice so the
    // default-tracking effect doesn't overwrite it; null = no explicit home.
    homeDaemonId = cybo.homeDaemonId ?? null;
    userPickedHomeDaemon = true;
    platformPermissions = cybo.platformPermissions ?? [];
    // Legacy [] (fail-open, see internal docs) and hand-tuned sets surface as
    // Customize — open the fine-grained toggles so the real state is visible.
    customizeOpen = derivePreset(platformPermissions) === "custom";
    // Mark dirty so the auto-generator (which fills personalityPrompt while
    // !dirty) never clobbers the soul we're about to load.
    personalityPromptDirty = true;
    personalityPrompt = "";
    // Lazy-load the full soul (fetch_cybos omits it) so editing shows the real
    // personality instead of starting blank.
    loadSoul(editCyboId);
  });

  // The skeleton condition: identity prefill not applied yet, or soul still in
  // flight. On error the form stays interactive (identity already shows) but
  // Save is blocked — see canCreate.
  const editPrefillPending = $derived(
    isEditing && (lastAppliedEditId !== editCyboId || soulLoad === "loading"),
  );
  const editingCyboName = $derived(
    displayName.trim() ||
      (editCyboId ? (cyboState.list.find((c) => c.id === editCyboId)?.name ?? "") : "") ||
      "this cybo",
  );

  const NAV_ITEMS: { id: SectionId; label: string; icon: string }[] = [
    { id: "identity", label: "Identity",        icon: "sparkle" },
    { id: "voice",    label: "Personality",     icon: "wave" },
    { id: "model",    label: "Provider",        icon: "bolt" },
    { id: "abilities",label: "What they can do", icon: "shield" },
    { id: "schedule", label: "Schedule",         icon: "clock" },
  ];

  // Editing relaxes the provider requirement: the template's provider may not
  // be detected/available on THIS machine, and that must not block e.g. an
  // avatar or name change. Provider/model are only sent when newly selected.
  const canCreate = $derived(
    displayName.trim() !== "" &&
      !!workspaceId &&
      (isEditing
        ? // Saving before the prefill applied wipes avatar/role/permissions
          // with form defaults; saving before the soul loaded replaces a
          // personality the user never saw (#442). Both gate Save.
          lastAppliedEditId === editCyboId && soulLoad === "loaded"
        : !!selectedProvider && !!selectedProviderDef?.available),
  );

  async function saveEdit(name: string): Promise<void> {
    if (!editCyboId) return;
    await updateCybo(editCyboId, {
      name,
      avatar: avatarUrl,
      role: jobTitle.trim() || null,
      // Home daemon (problem 4): nullable — sending null clears an explicit home.
      homeDaemonId: homeDaemonId ?? null,
      platformPermissions,
      // fetch_cybos doesn't return the soul, so the editor starts empty in
      // edit mode — only overwrite it if the user wrote a new one.
      ...(personalityPrompt.trim() ? { soul: personalityPrompt.trim() } : {}),
      ...(selectedProvider && selectedProviderDef?.available
        ? {
            provider: selectedProvider,
            model: formModel || null,
            // Api-key providers run on a per-daemon key (internal docs);
            // others keep the default host-login "cli" mode.
            llmAuthMode: isApiKeyProvider(selectedProvider) ? API_KEY_AUTH_MODE : "cli",
          }
        : {}),
    });
  }

  async function saveNew(name: string): Promise<void> {
    if (!selectedProvider) return;
    const rawSlug = handleName.trim() || derivedHandle || name;
    const slug =
      rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      `agent-${Date.now().toString(36)}`;
    await createCybo({
      slug,
      name,
      soul: personalityPrompt.trim() || `You are ${name}.`,
      provider: selectedProvider,
      model: formModel || undefined,
      avatar: avatarUrl || undefined,
      role: jobTitle.trim() || undefined,
      // Home daemon (problem 4): homeDaemonId already tracks targetDaemonId until
      // the user picks explicitly (the default-tracking $effect), so we send it
      // as-is. `?? undefined` only normalizes the no-daemon case — it must NOT
      // fall back to targetDaemonId, or an explicit "Auto" (null) pick would be
      // overridden and become un-selectable.
      homeDaemonId: homeDaemonId ?? undefined,
      platformPermissions,
      // Api-key providers (MiniMax/OpenRouter) run on a per-daemon key
      // (llm_auth_mode "api-key", internal docs); the key itself is set
      // separately via the credential field. Others use the default "cli" mode.
      llmAuthMode: isApiKeyProvider(selectedProvider) ? API_KEY_AUTH_MODE : undefined,
    });
  }

  async function handleSaveCybo() {
    if (creating || !canCreate) return;
    const name = displayName.trim();
    creating = true;
    error = "";
    try {
      if (isEditing) {
        await saveEdit(name);
      } else {
        await saveNew(name);
      }
      // Land on the cybos sub-tab so the new cybo is immediately visible.
      agentsPaneState.subTab = "cybos";
      goto(listPath());
    } catch (err) {
      if (err instanceof Error) {
        error = err.message;
      } else {
        error = isEditing ? "Failed to update cybo" : "Failed to create cybo";
      }
      creating = false;
    }
  }

  // Delete the cybo (edit mode only). Workspace owners/admins can remove any
  // cybo (the relay enforces manage_workspace); the whole delete path already
  // exists end to end — this page just lacked the affordance.
  let deleting = $state(false);
  async function handleDeleteCybo() {
    if (!editCyboId || deleting) return;
    const label = displayName.trim() || `@${handleName}` || "this cybo";
    if (!confirm(`Delete "${label}"? This removes it for the whole workspace and can't be undone.`)) {
      return;
    }
    deleting = true;
    error = "";
    try {
      await deleteCybo(editCyboId);
      agentsPaneState.subTab = "cybos";
      goto(listPath());
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to delete cybo";
      deleting = false;
    }
  }

  function scrollToSection(id: SectionId) {
    activeSection = id;
    const el = document.getElementById(`section-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Where the cybo editor returns to. On mobile the Agents tab was merged into
  // the Team tab (/dms), so the standalone AgentsPane (/agents) is NOT a valid
  // mobile destination — land back on the Team tab's Agents segment instead.
  function listPath(): string {
    return viewportState.isMobile
      ? `/workspace/${workspaceId}/dms?seg=agents`
      : `/workspace/${workspaceId}/agents`;
  }

  function back() {
    if (workspaceId) {
      goto(listPath());
    } else {
      history.back();
    }
  }
</script>

{#if !viewportState.isMobile}
<!-- ════════════════ DESKTOP: two-pane editor (unchanged) ════════════════ -->
<div class="flex h-full flex-col overflow-hidden" style="background: var(--bg-base); color: var(--text-primary);">
  <!-- Top header / breadcrumb -->
  <header class="flex items-center justify-between shrink-0" style="height: 56px; padding: 0 22px; border-bottom: 1px solid var(--border); background: var(--bg-base);">
    <div class="flex items-center gap-2.5">
      <button
        type="button"
        onclick={back}
        aria-label="Back to agents"
        class="inline-flex items-center justify-center cursor-pointer"
        style="width: 28px; height: 28px; border-radius: 6px; background: var(--border-dim); border: none; color: var(--text-secondary);"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="text-[12.5px]" style="color: var(--text-secondary);">
        <button
          type="button"
          onclick={back}
          class="cursor-pointer p-0 text-[12.5px]"
          style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit;"
        >
          Agents
        </button>
        <span class="mx-1.5" style="color: var(--text-muted);">›</span>
        <span class="font-semibold" style="color: var(--text-primary);">{isEditing ? "Edit cybo" : "New cybo"}</span>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <!-- Problem 4 (Part 1): the HOME daemon is now a prominent, always-visible
           wizard element — "Lives on" (edit) / "Creating on" (new) — and IS the
           picker (opens the same home-daemon Select). The machine the cybo runs
           on must never be buried under the model again. -->
      <Select.Root
        type="single"
        value={homeDaemonId ?? HOME_DAEMON_AUTO}
        onValueChange={onHomeDaemonChange}
      >
        <Select.Trigger
          class="inline-flex items-center gap-1.5 cursor-pointer"
          style="background: var(--border-dim); border: 1px solid var(--border); color: var(--text-primary); padding: 6px 11px; border-radius: 7px; font-size: 12.5px; font-weight: 600;"
          aria-label="Home daemon — the machine this cybo lives on"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <span style="color: var(--text-muted); font-weight: 500;">{isEditing ? "Lives on" : "Creating on"}</span>
          <span>{homeDaemonShortName}</span>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={HOME_DAEMON_AUTO} label="Auto (sponsor daemon)">Auto (sponsor daemon)</Select.Item>
          {#each homeDaemonChoices as d (d.id)}
            <Select.Item value={d.id} label={daemonDisplayName(d)}>{daemonDisplayName(d)}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <span class="text-[11.5px]" style="color: var(--text-muted);">A persona — nothing runs until you launch a session</span>
      <button
        type="button"
        onclick={back}
        class="cursor-pointer text-[12px] font-semibold"
        style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 6px 12px; border-radius: 6px; font-family: inherit;"
      >
        Cancel
      </button>
    </div>
  </header>

  <!-- Body: sidebar + sections -->
  <div class="flex-1 min-h-0 flex overflow-hidden">
    <!-- Left sidebar: preview card + section nav -->
    <aside class="shrink-0 overflow-y-auto" style="width: 260px; padding: 24px; border-right: 1px solid var(--border); background: var(--bg-base);">
      <!-- Preview card -->
      <div class="text-center mb-5" style="padding: 20px 16px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
        <div class="mx-auto mb-2.5 flex items-center justify-center overflow-hidden" style="width: 72px; height: 72px; border-radius: 16px; background: {avatarUrl ? 'transparent' : 'linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0)'}; color: white;">
          {#if avatarUrl}
            <img src={avatarUrl} alt={displayName || "agent avatar"} style="width: 100%; height: 100%; object-fit: cover;" />
          {:else if previewInitials}
            <!-- Initials fallback: clean + personal, updates with the name. -->
            <span class="font-bold" style="font-size: 28px; color: #fff; letter-spacing: 0.5px;">{previewInitials}</span>
          {:else}
            <!-- No name yet: a quiet "add a photo" hint. -->
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          {/if}
        </div>
        <div class="text-[15px] font-bold" style="color: var(--text-primary);">{displayName || "Unnamed"}</div>
        <div class="text-[12px]" style="color: var(--text-muted);">@{handleName || "handle"}</div>
        <span class="inline-block mt-2 text-[10px] font-bold uppercase tracking-wider" style="padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--agent-accent, #7c3aed) 16%, transparent); color: var(--agent-accent, #7c3aed);">
          • AGENT
        </span>
        <div class="text-[11px] italic mt-2" style="color: var(--text-muted);">cybo</div>
      </div>

      <!-- Section nav -->
      <nav class="flex flex-col gap-0.5">
        {#each NAV_ITEMS as item (item.id)}
          {@const active = activeSection === item.id}
          <button
            type="button"
            onclick={() => scrollToSection(item.id)}
            class="inline-flex items-center gap-2.5 text-[13px] font-semibold text-left cursor-pointer transition-colors"
            style="padding: 9px 11px; border-radius: 8px; background: {active ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, transparent)' : 'transparent'}; color: {active ? 'var(--agent-accent, #7c3aed)' : 'var(--text-secondary)'}; border: none; font-family: inherit;"
          >
            <span class="inline-flex items-center justify-center" style="width: 16px; height: 16px;">
              {#if item.icon === "sparkle"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/></svg>
              {:else if item.icon === "wave"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c2-3 3.5-3 5 0s3 3 5 0 3.5-3 5 0 3.5 3 3 0"/></svg>
              {:else if item.icon === "bolt"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>
              {:else if item.icon === "dollar"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              {:else if item.icon === "shield"}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              {/if}
            </span>
            {item.label}
          </button>
        {/each}
      </nav>
    </aside>

    <!-- Right: scrollable sections -->
    <main class="flex-1 min-w-0 overflow-y-auto" style="padding: 24px 32px 40px;">
      <div class="mx-auto" style="max-width: 880px;">

        {#if editPrefillPending}
          <div class="mb-4 flex items-center gap-2.5" role="status" style="padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-secondary); font-size: 13px;">
            <div class="rounded-full border-2 animate-spin shrink-0" style="width: 15px; height: 15px; border-color: var(--border); border-top-color: var(--text-secondary);"></div>
            Loading {editingCyboName}'s identity…
          </div>
        {:else if isEditing && soulLoad === "error"}
          <div class="mb-4 flex items-center justify-between gap-3" role="alert" style="padding: 12px 16px; border-radius: 10px; border: 1px solid var(--danger, #e5484d); background: var(--bg-surface); font-size: 13px; color: var(--text-primary);">
            <span>
              Couldn't load {editingCyboName}'s saved personality — saving is locked so you don't overwrite it blind.
              <span style="color: var(--text-secondary);">{soulLoadError}</span>
            </span>
            <button
              type="button"
              class="shrink-0 font-semibold"
              style="padding: 6px 14px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-base); color: var(--text-primary); cursor: pointer;"
              onclick={() => editCyboId && loadSoul(editCyboId)}
            >
              Retry
            </button>
          </div>
        {/if}

        <div class={editPrefillPending ? "pointer-events-none opacity-50" : undefined} aria-busy={editPrefillPending}>

        <!-- Identity section -->
        <section id="section-identity" class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">Identity</h3>
          <p class="text-[13px] mb-5" style="color: var(--text-secondary);">The bits people see in the stream.</p>

          <div class="flex gap-6">
            <div class="shrink-0 flex flex-col items-center" style="width: 130px;">
              <div class="relative flex items-center justify-center overflow-hidden" style="width: 112px; height: 112px; border-radius: 22px; background: {avatarUrl ? 'transparent' : 'linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0)'}; color: white;">
                {#if avatarUrl}
                  <img src={avatarUrl} alt={displayName || "agent avatar"} style="width: 100%; height: 100%; object-fit: cover; filter: {generatingAvatar ? 'blur(8px) brightness(0.6)' : 'none'}; transition: filter 220ms ease;" />
                {:else}
                  <span style="opacity: {generatingAvatar ? 0.35 : 1};"><CyborgIcon size={52} class="text-white" /></span>
                {/if}
                {#if generatingAvatar}
                  <div class="absolute inset-0 flex items-center justify-center" style="background: rgba(0,0,0,0.35);">
                    <div class="rounded-full border-2 animate-spin" style="width: 28px; height: 28px; border-color: rgba(255,255,255,0.25); border-top-color: #fff;"></div>
                  </div>
                {/if}
              </div>
              <button
                type="button"
                onclick={generateAvatar}
                disabled={generatingAvatar}
                class="inline-flex items-center gap-1.5 mt-3 cursor-pointer text-[12px] font-semibold"
                style="padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-secondary); font-family: inherit; opacity: {generatingAvatar ? 0.65 : 1}; cursor: {generatingAvatar ? 'progress' : 'pointer'};"
              >
                {#if generatingAvatar}
                  <span class="rounded-full border-2 animate-spin" style="width: 10px; height: 10px; border-color: var(--border); border-top-color: var(--agent-accent, #7c3aed);"></span>
                  Generating…
                {:else}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/></svg>
                  {avatarUrl ? "Regenerate" : "Generate"}
                {/if}
              </button>
              <button
                type="button"
                onclick={() => fileInput?.click()}
                class="mt-2 underline cursor-pointer text-[11.5px]"
                style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit;"
              >
                Upload photo
              </button>
              <input
                bind:this={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onchange={handleAvatarFile}
                style="display: none;"
              />
            </div>

            <div class="flex-1 min-w-0 grid grid-cols-2 gap-4">
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <Label class="text-[12.5px] font-semibold text-content" for="agent-display-name">Display name</Label>
                </div>
                <Input id="agent-display-name" type="text" bind:value={displayName} placeholder="e.g. Atlas Reed" class="text-[13px]" />
              </div>
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <Label class="text-[12.5px] font-semibold text-content" for="agent-handle">Handle</Label>
                  <span class="text-[11px]" style="color: var(--text-muted);">{isEditing ? "handles can't change" : "lowercase, letters + numbers"}</span>
                </div>
                <div class="flex items-center" style="border-radius: 8px; border: 1px solid var(--border); background: var(--bg-base); opacity: {isEditing ? 0.6 : 1};">
                  <span class="select-none pl-3 pr-1 text-[13px]" style="color: var(--text-muted);">@</span>
                  <input
                    id="agent-handle"
                    type="text"
                    bind:value={handleName}
                    oninput={() => { handleDirty = true; }}
                    placeholder="atlas"
                    disabled={isEditing}
                    class="flex-1 w-full bg-transparent outline-none"
                    style="padding: 9px 10px 9px 0; color: var(--text-primary); font-size: 13px; border: none;"
                  />
                </div>
              </div>
              <div class="col-span-2">
                <div class="flex items-center justify-between mb-1.5">
                  <Label class="text-[12.5px] font-semibold text-content" for="agent-job">Job title</Label>
                  <span class="text-[11px]" style="color: var(--text-muted);">The headline people see on hover</span>
                </div>
                <Input id="agent-job" type="text" bind:value={jobTitle} placeholder="e.g. Chief Technology Officer" class="text-[13px]" />
              </div>
            </div>
          </div>
        </section>

        <!-- Voice section -->
        <section id="section-voice" class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">Personality</h3>
          <p class="text-[13px] mb-5" style="color: var(--text-secondary);">Pick up to 3 traits. We turn these into a personality behind the scenes.</p>

          <div class="grid gap-3" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
            {#each VOICE_OPTIONS as v (v.id)}
              {@const selected = voiceTraits.includes(v.id)}
              <button
                type="button"
                onclick={() => toggleVoice(v.id)}
                class="text-left cursor-pointer transition-colors"
                style="padding: 13px 15px; border-radius: 10px; background: {selected ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {selected ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'}; font-family: inherit;"
              >
                <div class="text-[13.5px] font-bold" style="color: var(--text-primary);">{v.label}</div>
                <div class="text-[11.5px] mt-0.5" style="color: var(--text-secondary);">{v.sub}</div>
              </button>
            {/each}
          </div>

          <div class="flex items-center gap-2 mt-4 text-[12px]">
            <Switch id="power-user-view" bind:checked={showPowerUserPrompt} />
            <Label for="power-user-view" class="cursor-pointer text-[12px] text-content-dim">
              Power-user view — show the actual personality prompt
            </Label>
          </div>

          {#if showPowerUserPrompt}
            <div class="mt-3" style="border-radius: 10px; border: 1px solid var(--border); background: #0d0d0d; overflow: hidden;">
              <div class="flex items-center justify-between" style="padding: 8px 12px; border-bottom: 1px solid var(--border); background: #161616;">
                <div class="flex items-center gap-2 text-[11px]" style="color: var(--text-muted);">
                  <span class="inline-flex gap-1">
                    <span class="rounded-full" style="width: 8px; height: 8px; background: #ff5f57;"></span>
                    <span class="rounded-full" style="width: 8px; height: 8px; background: #febc2e;"></span>
                    <span class="rounded-full" style="width: 8px; height: 8px; background: #28c840;"></span>
                  </span>
                  <span class="font-mono">personality.md</span>
                  {#if personalityPromptDirty}
                    <span class="text-[10px] font-semibold uppercase tracking-wider" style="color: var(--agent-accent, #7c3aed);">edited</span>
                  {:else}
                    <span class="text-[10px] font-semibold uppercase tracking-wider" style="color: var(--text-muted);">auto-generated</span>
                  {/if}
                </div>
                <div class="flex items-center gap-2">
                  {#if personalityPromptDirty}
                    <button
                      type="button"
                      onclick={resetPersonalityPrompt}
                      class="cursor-pointer text-[11px] font-semibold"
                      style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit; padding: 0;"
                      title="Discard your edits and regenerate from the traits above"
                    >
                      Reset
                    </button>
                  {/if}
                  <button
                    type="button"
                    onclick={() => { navigator.clipboard?.writeText(personalityPrompt); }}
                    class="cursor-pointer text-[11px] font-semibold"
                    style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit; padding: 0;"
                    title="Copy prompt"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <textarea
                bind:value={personalityPrompt}
                oninput={() => { personalityPromptDirty = true; }}
                rows={10}
                spellcheck="false"
                class="w-full font-mono text-[12.5px] resize-y"
                style="padding: 14px 16px; background: transparent; color: #e6e6e6; border: none; outline: none; line-height: 1.6;"
              ></textarea>
              <div class="flex items-center justify-between text-[10.5px]" style="padding: 6px 12px; border-top: 1px solid var(--border); background: #0a0a0a; color: var(--text-muted);">
                <span class="font-mono">markdown · {personalityPrompt.length} chars · {personalityPrompt.split("\n").length} lines</span>
                <span>Edits override the trait pickers above</span>
              </div>
            </div>
          {/if}
        </section>

        <!-- Model section -->
        <section id="section-model" class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">Provider</h3>
          <p class="text-[13px] mb-4" style="color: var(--text-secondary);">Pick the provider, then the specific model your agent should use.</p>

          <!-- Plain section label — "STEP 1" implied a wizard the page isn't (#444):
               this is one long form, the provider is just another section. -->
          <div class="text-[10.5px] font-bold uppercase tracking-widest mb-3" style="color: var(--text-muted);">PROVIDER</div>

          {#if providerState.loading}
            <div class="flex items-center gap-2 py-6 justify-center">
              <div class="h-3 w-3 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
              <span class="text-sm text-content-muted">Detecting providers on your daemon...</span>
            </div>
          {:else if providers.length === 0}
            <div class="flex flex-col items-center gap-2 py-6 text-center" style="color: var(--text-muted);">
              <p class="text-sm">No providers detected.</p>
              <p class="text-xs max-w-xs">Provider detection needs a connected daemon — the cybo just records which provider it should use.</p>
              <button
                type="button"
                onclick={() => fetchProviders()}
                class="mt-1 text-xs underline cursor-pointer"
                style="background: transparent; border: none; color: var(--agent-accent, #7c3aed); font-family: inherit; padding: 0;"
              >Retry detection</button>
            </div>
          {:else}
            <div class="grid grid-cols-1 gap-2">
              {#each providers as p (p.id)}
                {@const isSelected = selectedProvider === p.id}
                {@const cap = rowCapability(p)}
                <div class="flex flex-col">
                <button
                  type="button"
                  onclick={() => { if (p.available) selectedProvider = p.id; }}
                  disabled={!p.available}
                  class={cn(
                    "flex items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors border cursor-pointer",
                    isSelected
                      ? "border-btn-primary-bg bg-raised"
                      : "border-edge hover:border-edge-light hover:bg-hover-gray",
                    !p.available && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <div class="shrink-0 flex items-center justify-center" style="width: 36px; height: 36px; border-radius: 9px; background: var(--bg-surface-alt, var(--bg-base)); color: var(--text-secondary);">
                    <ProviderIcon provider={p.id} size={20} />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-[14px] font-bold" style="color: var(--text-primary);">{p.label}</span>
                      <StatusBadge status={p.available ? "available" : "not-installed"} />
                    </div>
                    {#if p.description}
                      <p class="text-[12px] truncate mt-0.5" style="color: var(--text-secondary);">{p.description}</p>
                    {/if}
                    {#if p.models?.length > 0}
                      <span class="text-[10.5px]" style="color: var(--text-muted);">
                        {p.models.length} model{p.models.length !== 1 ? "s" : ""}
                      </span>
                    {/if}
                  </div>
                </button>
                {#if isNativeHarnessRow(p.id) && p.available}
                  <!-- internal docs: native harness — reuses this daemon's own
                       login, no runtime credentials involved. -->
                  <div class="mt-1 px-1 text-[11px] text-content-muted">
                    Runs natively on this daemon's {p.label} login — no extra setup.
                  </div>
                {/if}
                <!-- REAL per-daemon capability (internal docs item 3), collapsed to a
                     target-daemon-first summary with the rest behind a toggle (#443). -->
                <ProviderDaemonStatus {cap} {workspaceId} {targetDaemonId} />
                </div>
              {/each}
            </div>
          {/if}

          {#if selectedProvider && selectedProviderDef?.available}
            <div class="mt-6 grid gap-4" style="grid-template-columns: 1fr 1fr;">
              {#if selectedProviderDef.models.length > 0}
                <div>
                  <Label class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">Model</Label>
                  <ModelCombobox
                    models={selectedProviderDef.models}
                    value={formModel || null}
                    providerId={selectedProvider}
                    placeholder="Select a model"
                    triggerClass="w-full text-[13px]"
                    onSelect={(id) => {
                      formModel = id;
                    }}
                  />
                </div>
              {/if}
              <div>
                <Label class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">Home daemon</Label>
                <Select.Root
                  type="single"
                  value={homeDaemonId ?? HOME_DAEMON_AUTO}
                  onValueChange={onHomeDaemonChange}
                >
                  <Select.Trigger class="w-full text-[13px]">{homeDaemonLabel}</Select.Trigger>
                  <Select.Content>
                    <Select.Item value={HOME_DAEMON_AUTO} label="Auto (sponsor daemon)">Auto (sponsor daemon)</Select.Item>
                    {#each homeDaemonChoices as d (d.id)}
                      <Select.Item value={d.id} label={daemonDisplayName(d)}>{daemonDisplayName(d)}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                <p class="mt-1 text-[11px]" style="color: var(--text-muted);">The machine this cybo lives on. Auto uses the sponsor daemon.</p>
              </div>
            </div>
            {#if selectedIsApiKey}
              <ApiKeyCredentialField providerId={selectedProvider} daemonId={targetDaemonId} />
            {/if}
          {:else if selectedProvider && selectedProviderDef && !selectedProviderDef.available}
            <div class="mt-4 flex items-start gap-2 text-[12px]" style="padding: 12px 14px; border-radius: 8px; background: color-mix(in srgb, var(--error, #e01e5a) 10%, transparent); border: 1px solid color-mix(in srgb, var(--error, #e01e5a) 22%, transparent); color: var(--error, #e01e5a);">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
              <div class="flex-1">
                <p class="font-semibold">{selectedProviderDef?.label ?? selectedProvider} is not installed</p>
                <p class="mt-0.5 text-[11px]" style="color: var(--text-secondary);">Install the CLI and make sure it's on your PATH.</p>
                <button
                  type="button"
                  onclick={() => goto(`/workspace/${workspaceId}/settings/providers`)}
                  class="mt-1.5 text-[11px] underline cursor-pointer"
                  style="background: transparent; border: none; color: var(--agent-accent, #7c3aed); font-family: inherit; padding: 0;"
                >View in Settings</button>
              </div>
            </div>
          {/if}
        </section>

        <!-- What they can do -->
        <section id="section-abilities" class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">What they can do</h3>
          <p class="text-[13px] mb-4" style="color: var(--text-secondary);">Permissions: what your agent may do inside Cyborg7.</p>

          <div role="radiogroup" aria-label="Permission presets" class="grid gap-2.5" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
            {#each PERMISSION_PRESETS as preset (preset.id)}
              {@const selected = permissionPreset === preset.id}
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onclick={() => selectPermissionPreset(preset.id)}
                class="text-left cursor-pointer transition-colors flex flex-col gap-1"
                style="padding: 14px 16px; border-radius: 10px; background: {selected ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {selected ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'}; font-family: inherit;"
              >
                <span class="text-[13px] font-bold" style="color: var(--text-primary);">{preset.label}</span>
                <span class="text-[11.5px]" style="color: var(--text-secondary);">{preset.sub}</span>
              </button>
            {/each}
          </div>

          <button
            type="button"
            onclick={() => { customizeOpen = !customizeOpen; }}
            class="mt-3 flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer"
            style="background: transparent; border: none; padding: 0; color: {permissionPreset === 'custom' ? 'var(--agent-accent, #7c3aed)' : 'var(--text-muted)'}; font-family: inherit;"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({customizeOpen ? 90 : 0}deg); transition: transform 120ms;"><path d="m9 18 6-6-6-6"/></svg>
            Customize{permissionPreset === "custom" ? " · custom set" : ""}
          </button>

          {#if customizeOpen}
            {#if permissionPreset === "custom" && platformPermissions.length === 0}
              <p class="mt-2 text-[11.5px]" style="color: var(--warning, #e8a13a);">
                No explicit grants — this cybo currently runs unrestricted (legacy). Pick a preset or check what it may do.
              </p>
            {/if}
            <div class="mt-2.5 grid gap-2.5" style="grid-template-columns: repeat(2, minmax(0, 1fr));">
              {#each PLATFORM_PERMISSION_OPTIONS as o (o.id)}
                {@const checked = platformPermissions.includes(o.id)}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onclick={() => togglePlatformPermission(o.id)}
                  class="text-left cursor-pointer transition-colors flex items-start gap-2.5"
                  style="padding: 12px 14px; border-radius: 10px; background: {checked ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {checked ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'}; font-family: inherit;"
                >
                  <span class="inline-flex items-center justify-center shrink-0 mt-0.5" style="width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid {checked ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'}; background: {checked ? 'var(--agent-accent, #7c3aed)' : 'transparent'};">
                    {#if checked}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                  </span>
                  <span class="min-w-0">
                    <span class="block text-[13px] font-bold" style="color: var(--text-primary);">{o.label}</span>
                    <span class="block text-[11.5px] mt-0.5" style="color: var(--text-secondary);">{o.sub}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </section>

        <!-- Schedule -->
        <section id="section-schedule" class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">Schedule</h3>
          <p class="text-[13px] mb-4" style="color: var(--text-secondary);">When the agent runs on its own, without being asked.</p>
          <div class="text-[12.5px] italic" style="padding: 16px; border-radius: 10px; border: 1px dashed var(--border); color: var(--text-muted);">
            Coming next — cadence and triggers.
          </div>
        </section>
        <!-- Save the cybo -->
        <section class="mb-6" style="padding: 22px 24px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface);">
          <h3 class="text-[18px] font-bold mb-1" style="color: var(--text-primary);">{isEditing ? "Save changes" : "Save your cybo"}</h3>
          <p class="text-[13px] mb-4" style="color: var(--text-secondary);">
            {#if isEditing}
              Updates {displayName.trim() || "this cybo"} for everyone in the workspace. Running sessions keep their current persona — changes apply to new launches. Leave Personality empty to keep the existing one.
            {:else}
              This saves {displayName.trim() || "the agent"} as a reusable cybo in this workspace. It won't run anywhere yet — launch sessions from <strong style="color: var(--text-primary);">Agents → Create agent</strong>, where it will be listed.
            {/if}
          </p>

          {#if error}
            <p class="text-[12px] mt-2 mb-2" style="color: var(--error, #e01e5a);">{error}</p>
          {/if}

          <div class="flex items-center justify-between gap-3 mt-2">
            <div class="flex items-center gap-3 min-w-0">
              {#if isEditing}
                <button
                  type="button"
                  onclick={handleDeleteCybo}
                  disabled={deleting}
                  class="shrink-0 cursor-pointer text-[12.5px] font-semibold"
                  style="padding: 9px 14px; border-radius: 8px; background: transparent; border: 1px solid color-mix(in srgb, var(--error, #e01e5a) 45%, transparent); color: var(--error, #e01e5a); font-family: inherit; opacity: {deleting ? 0.5 : 1}; cursor: {deleting ? 'not-allowed' : 'pointer'};"
                >
                  {deleting ? "Deleting…" : "Delete cybo"}
                </button>
              {/if}
              <span class="text-[11.5px] truncate" style="color: var(--text-muted);">
                {#if !displayName.trim()}
                  Give your agent a name to continue.
                {:else if !isEditing && !selectedProvider}
                  Pick a provider above to continue.
                {:else if isEditing}
                  Saving updates @{handleName} in this workspace.
                {:else}
                  Ready. It'll appear under Agents.
                {/if}
              </span>
            </div>
            <button
              type="button"
              onclick={handleSaveCybo}
              disabled={!canCreate || creating}
              class="inline-flex items-center gap-2 cursor-pointer text-[13px] font-bold shrink-0"
              style="padding: 10px 18px; border-radius: 8px; background: var(--btn-primary-bg); color: var(--btn-primary-text); border: none; font-family: inherit; opacity: {(!canCreate || creating) ? 0.5 : 1}; cursor: {(!canCreate || creating) ? 'not-allowed' : 'pointer'};"
            >
              {creating ? "Saving…" : isEditing ? "Save changes" : "Create cybo"}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </button>
          </div>
        </section>

        </div>

      </div>
    </main>
  </div>
</div>
{:else}
<!-- ════════════════ MOBILE: single-column iOS editor ════════════════ -->
<div class="flex h-full flex-col overflow-hidden bg-surface text-content">
  <!-- Compact header: back chevron · title · Cancel/Save -->
  <header class="grid h-[44px] shrink-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-1 border-b border-edge px-1">
    <button
      type="button"
      onclick={back}
      aria-label="Back to agents"
      class="pressable flex h-[44px] w-[44px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
    </button>
    <span class="truncate text-[17px] font-semibold text-content">{isEditing ? "Edit cybo" : "New cybo"}</span>
    <div class="flex items-center gap-1 pr-1">
      <button
        type="button"
        onclick={back}
        class="pressable flex h-[44px] items-center rounded-[10px] px-2.5 text-[16px] text-content-dim focus-ring"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleSaveCybo}
        disabled={!canCreate || creating}
        class="pressable flex h-[44px] items-center rounded-[10px] px-2.5 text-[16px] font-semibold text-accent disabled:opacity-40 focus-ring"
      >
        {creating ? "Saving…" : "Save"}
      </button>
    </div>
  </header>

  <!-- Problem 4 (Part 1): prominent, always-visible HOME daemon banner directly
       under the mobile header — "Lives on" (edit) / "Creating on" (new) — and IS
       the picker (the same home-daemon Select), so the target machine is never
       buried under the model on mobile either. -->
  <div class="shrink-0 border-b border-edge px-4 py-2">
    <Select.Root
      type="single"
      value={homeDaemonId ?? HOME_DAEMON_AUTO}
      onValueChange={onHomeDaemonChange}
    >
      <Select.Trigger
        class="flex w-full items-center gap-2 rounded-[12px] bg-surface-alt px-3 py-2 text-[15px] font-semibold text-content"
        aria-label="Home daemon — the machine this cybo lives on"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span class="text-content-dim font-medium">{isEditing ? "Lives on" : "Creating on"}</span>
        <span class="truncate">{homeDaemonShortName}</span>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={HOME_DAEMON_AUTO} label="Auto (sponsor daemon)">Auto (sponsor daemon)</Select.Item>
        {#each homeDaemonChoices as d (d.id)}
          <Select.Item value={d.id} label={daemonDisplayName(d)}>{daemonDisplayName(d)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-10 pt-3 space-y-6">

    {#if editPrefillPending}
      <div class="flex items-center gap-2.5 rounded-[14px] bg-surface-alt px-[16px] py-[12px] text-[14px] text-content-dim" role="status">
        <div class="h-[15px] w-[15px] shrink-0 animate-spin rounded-full border-2 border-edge border-t-content-dim"></div>
        Loading {editingCyboName}'s identity…
      </div>
    {:else if isEditing && soulLoad === "error"}
      <div class="flex items-center justify-between gap-3 rounded-[14px] bg-surface-alt px-[16px] py-[12px] text-[14px]" role="alert">
        <span class="text-content">
          Couldn't load {editingCyboName}'s saved personality — saving is locked so you don't overwrite it blind.
          <span class="text-content-dim">{soulLoadError}</span>
        </span>
        <button
          type="button"
          class="pressable shrink-0 rounded-[10px] border border-edge px-3 py-1.5 text-[14px] font-semibold text-content focus-ring"
          onclick={() => editCyboId && loadSoul(editCyboId)}
        >
          Retry
        </button>
      </div>
    {/if}

    <div class={["space-y-6", editPrefillPending && "pointer-events-none opacity-50"]} aria-busy={editPrefillPending}>

    <!-- ── Identity card: avatar + name + @slug + AGENT pill + actions ── -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Identity</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[18px]">
        <div class="flex flex-col items-center text-center">
          <div class="relative flex items-center justify-center overflow-hidden" style="width: 96px; height: 96px; border-radius: 22px; background: {avatarUrl ? 'transparent' : 'linear-gradient(135deg, var(--agent-accent, #6366f1), #5BB5F0)'}; color: white;">
            {#if avatarUrl}
              <img src={avatarUrl} alt={displayName || "agent avatar"} style="width: 100%; height: 100%; object-fit: cover; filter: {generatingAvatar ? 'blur(8px) brightness(0.6)' : 'none'}; transition: filter 220ms ease;" />
            {:else if previewInitials}
              <span class="font-bold" style="font-size: 34px; color: #fff; letter-spacing: 0.5px;">{previewInitials}</span>
            {:else}
              <span style="opacity: {generatingAvatar ? 0.35 : 1};"><CyborgIcon size={44} class="text-white" /></span>
            {/if}
            {#if generatingAvatar}
              <div class="absolute inset-0 flex items-center justify-center" style="background: rgba(0,0,0,0.35);">
                <div class="rounded-full border-2 animate-spin" style="width: 26px; height: 26px; border-color: rgba(255,255,255,0.25); border-top-color: #fff;"></div>
              </div>
            {/if}
          </div>

          <div class="mt-3 text-[18px] font-bold text-content">{displayName || "Unnamed"}</div>
          <div class="text-[14px] text-content-muted">@{handleName || "handle"}</div>
          <span class="mt-2 inline-block text-[10px] font-bold uppercase tracking-wider" style="padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--agent-accent, #7c3aed) 16%, transparent); color: var(--agent-accent, #7c3aed);">
            • AGENT
          </span>

          <div class="mt-4 flex w-full items-center gap-2">
            <button
              type="button"
              onclick={generateAvatar}
              disabled={generatingAvatar}
              class="pressable flex h-[44px] flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-edge text-[15px] font-medium text-content disabled:opacity-60 focus-ring"
            >
              {#if generatingAvatar}
                <span class="rounded-full border-2 animate-spin" style="width: 12px; height: 12px; border-color: var(--border); border-top-color: var(--agent-accent, #7c3aed);"></span>
                Generating…
              {:else}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/></svg>
                {avatarUrl ? "Regenerate" : "Generate"}
              {/if}
            </button>
            <button
              type="button"
              onclick={() => mobileFileInput?.click()}
              class="pressable flex h-[44px] flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-edge text-[15px] font-medium text-content focus-ring"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload photo
            </button>
            <input
              bind:this={mobileFileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onchange={handleAvatarFile}
              class="hidden"
            />
          </div>
        </div>

        <!-- Identity fields -->
        <div class="mt-5 space-y-4">
          <div>
            <label class="mb-1.5 block text-[13px] font-semibold text-content" for="m-agent-display-name">Display name</label>
            <input
              id="m-agent-display-name"
              type="text"
              bind:value={displayName}
              placeholder="e.g. Atlas Reed"
              class="h-[44px] w-full rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content placeholder:text-content-muted outline-none focus:border-accent"
            />
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-[13px] font-semibold text-content" for="m-agent-handle">Handle</label>
              <span class="text-[12px] text-content-muted">{isEditing ? "handles can't change" : "lowercase, letters + numbers"}</span>
            </div>
            <div class="flex h-[44px] items-center rounded-[10px] border border-edge bg-surface" style="opacity: {isEditing ? 0.6 : 1};">
              <span class="select-none pl-3 pr-1 text-[16px] text-content-muted">@</span>
              <input
                id="m-agent-handle"
                type="text"
                bind:value={handleName}
                oninput={() => { handleDirty = true; }}
                placeholder="atlas"
                disabled={isEditing}
                class="h-full w-full flex-1 bg-transparent pr-3 text-[16px] text-content outline-none"
              />
            </div>
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-[13px] font-semibold text-content" for="m-agent-job">Job title</label>
              <span class="text-[12px] text-content-muted">Shown on hover</span>
            </div>
            <input
              id="m-agent-job"
              type="text"
              bind:value={jobTitle}
              placeholder="e.g. Chief Technology Officer"
              class="h-[44px] w-full rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content placeholder:text-content-muted outline-none focus:border-accent"
            />
          </div>
        </div>
        <p class="mt-3 text-[13px] text-content-muted">The bits people see in the stream.</p>
      </div>
    </div>

    <!-- ── Personality ── -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Personality</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
        <p class="mb-3 text-[14px] text-content-dim">Pick up to 3 traits. We turn these into a personality behind the scenes.</p>
        <div class="grid grid-cols-2 gap-2.5">
          {#each VOICE_OPTIONS as v (v.id)}
            {@const selected = voiceTraits.includes(v.id)}
            <button
              type="button"
              onclick={() => toggleVoice(v.id)}
              class="pressable text-left"
              style="padding: 12px 14px; min-height: 44px; border-radius: 10px; background: {selected ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {selected ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'};"
            >
              <div class="text-[15px] font-bold text-content">{v.label}</div>
              <div class="mt-0.5 text-[12.5px] text-content-dim">{v.sub}</div>
            </button>
          {/each}
        </div>

        <div class="mt-4 flex items-center gap-2.5">
          <Switch id="m-power-user-view" bind:checked={showPowerUserPrompt} />
          <Label for="m-power-user-view" class="cursor-pointer text-[14px] text-content-dim">
            Power-user view — show the actual personality prompt
          </Label>
        </div>

        {#if showPowerUserPrompt}
          <div class="mt-3" style="border-radius: 10px; border: 1px solid var(--border); background: #0d0d0d; overflow: hidden;">
            <div class="flex items-center justify-between" style="padding: 8px 12px; border-bottom: 1px solid var(--border); background: #161616;">
              <div class="flex items-center gap-2 text-[11px]" style="color: var(--text-muted);">
                <span class="font-mono">personality.md</span>
                {#if personalityPromptDirty}
                  <span class="text-[10px] font-semibold uppercase tracking-wider" style="color: var(--agent-accent, #7c3aed);">edited</span>
                {:else}
                  <span class="text-[10px] font-semibold uppercase tracking-wider" style="color: var(--text-muted);">auto-generated</span>
                {/if}
              </div>
              <div class="flex items-center gap-3">
                {#if personalityPromptDirty}
                  <button
                    type="button"
                    onclick={resetPersonalityPrompt}
                    class="pressable cursor-pointer text-[12px] font-semibold"
                    style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit; padding: 0;"
                    title="Discard your edits and regenerate from the traits above"
                  >
                    Reset
                  </button>
                {/if}
                <button
                  type="button"
                  onclick={() => { navigator.clipboard?.writeText(personalityPrompt); }}
                  class="pressable cursor-pointer text-[12px] font-semibold"
                  style="background: transparent; border: none; color: var(--text-secondary); font-family: inherit; padding: 0;"
                  title="Copy prompt"
                >
                  Copy
                </button>
              </div>
            </div>
            <textarea
              bind:value={personalityPrompt}
              oninput={() => { personalityPromptDirty = true; }}
              rows={10}
              spellcheck="false"
              class="w-full resize-y font-mono text-[16px]"
              style="padding: 14px 16px; background: transparent; color: #e6e6e6; border: none; outline: none; line-height: 1.6;"
            ></textarea>
            <div class="flex items-center justify-between text-[10.5px]" style="padding: 6px 12px; border-top: 1px solid var(--border); background: #0a0a0a; color: var(--text-muted);">
              <span class="font-mono">markdown · {personalityPrompt.length} chars · {personalityPrompt.split("\n").length} lines</span>
              <span>Overrides the pickers</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- ── Provider ── -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Provider</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
        <p class="mb-3 text-[14px] text-content-dim">Pick the provider, then the specific model your agent should use.</p>

        {#if providerState.loading}
          <div class="flex items-center justify-center gap-2 py-6">
            <div class="h-3 w-3 animate-spin rounded-full border-2 border-content-muted border-t-transparent"></div>
            <span class="text-[14px] text-content-muted">Detecting providers on your daemon...</span>
          </div>
        {:else if providers.length === 0}
          <div class="flex flex-col items-center gap-2 py-6 text-center text-content-muted">
            <p class="text-[14px]">No providers detected.</p>
            <p class="text-[12.5px]">Provider detection needs a connected daemon — the cybo just records which provider it should use.</p>
            <button
              type="button"
              onclick={() => fetchProviders()}
              class="pressable mt-1 text-[13px] underline text-accent"
            >Retry detection</button>
          </div>
        {:else}
          <div class="flex flex-col gap-2">
            {#each providers as p (p.id)}
              {@const isSelected = selectedProvider === p.id}
              {@const cap = rowCapability(p)}
              <div class="flex flex-col">
                <button
                  type="button"
                  onclick={() => { if (p.available) selectedProvider = p.id; }}
                  disabled={!p.available}
                  class={cn(
                    "pressable flex items-center gap-3 rounded-[10px] px-3.5 py-3 text-left transition-colors border",
                    isSelected ? "border-btn-primary-bg bg-raised" : "border-edge",
                    !p.available && "opacity-50",
                  )}
                  style="min-height: 44px;"
                >
                  <div class="flex shrink-0 items-center justify-center" style="width: 36px; height: 36px; border-radius: 9px; background: var(--bg-base); color: var(--text-secondary);">
                    <ProviderIcon provider={p.id} size={20} />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-[15px] font-bold text-content">{p.label}</span>
                      <StatusBadge status={p.available ? "available" : "not-installed"} />
                    </div>
                    {#if p.description}
                      <p class="mt-0.5 truncate text-[12.5px] text-content-dim">{p.description}</p>
                    {/if}
                    {#if p.models?.length > 0}
                      <span class="text-[11px] text-content-muted">
                        {p.models.length} model{p.models.length !== 1 ? "s" : ""}
                      </span>
                    {/if}
                  </div>
                </button>
                {#if isNativeHarnessRow(p.id) && p.available}
                  <div class="mt-1 px-1 text-[12px] text-content-muted">
                    Runs natively on this daemon's {p.label} login — no extra setup.
                  </div>
                {/if}
                <ProviderDaemonStatus {cap} {workspaceId} {targetDaemonId} />
              </div>
            {/each}
          </div>
        {/if}

        {#if selectedProvider && selectedProviderDef?.available}
          {#if selectedProviderDef.models.length > 0}
            <div class="mt-4">
              <Label class="mb-1.5 block text-[13px] font-semibold text-content">Model</Label>
              <ModelCombobox
                models={selectedProviderDef.models}
                value={formModel || null}
                providerId={selectedProvider}
                placeholder="Select a model"
                triggerClass="w-full text-[16px] h-[44px]"
                onSelect={(id) => {
                  formModel = id;
                }}
              />
            </div>
          {/if}
          <div class="mt-4">
            <Label class="mb-1.5 block text-[13px] font-semibold text-content">Home daemon</Label>
            <Select.Root
              type="single"
              value={homeDaemonId ?? HOME_DAEMON_AUTO}
              onValueChange={onHomeDaemonChange}
            >
              <Select.Trigger class="w-full text-[16px] h-[44px]">{homeDaemonLabel}</Select.Trigger>
              <Select.Content>
                <Select.Item value={HOME_DAEMON_AUTO} label="Auto (sponsor daemon)">Auto (sponsor daemon)</Select.Item>
                {#each homeDaemonChoices as d (d.id)}
                  <Select.Item value={d.id} label={daemonDisplayName(d)}>{daemonDisplayName(d)}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <p class="mt-1 text-[12px] text-content-muted">The machine this cybo lives on. Auto uses the sponsor daemon.</p>
          </div>
          {#if selectedIsApiKey}
            <ApiKeyCredentialField providerId={selectedProvider} daemonId={targetDaemonId} />
          {/if}
        {:else if selectedProvider && selectedProviderDef && !selectedProviderDef.available}
          <div class="mt-4 flex items-start gap-2 text-[13px]" style="padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--error, #e01e5a) 10%, transparent); border: 1px solid color-mix(in srgb, var(--error, #e01e5a) 22%, transparent); color: var(--error, #e01e5a);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="mt-0.5 shrink-0" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
            <div class="flex-1">
              <p class="font-semibold">{selectedProviderDef?.label ?? selectedProvider} is not installed</p>
              <p class="mt-0.5 text-[12px] text-content-dim">Install the CLI and make sure it's on your PATH.</p>
              <button
                type="button"
                onclick={() => goto(`/workspace/${workspaceId}/settings/providers`)}
                class="pressable mt-1.5 text-[12px] underline text-accent"
              >View in Settings</button>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- ── What they can do ── -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">What they can do</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
        <p class="mb-3 text-[14px] text-content-dim">Permissions: what your agent may do inside Cyborg7.</p>
        <div role="radiogroup" aria-label="Permission presets" class="flex flex-col gap-2.5">
          {#each PERMISSION_PRESETS as preset (preset.id)}
            {@const selected = permissionPreset === preset.id}
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onclick={() => selectPermissionPreset(preset.id)}
              class="pressable flex flex-col gap-1 text-left"
              style="padding: 13px 15px; min-height: 44px; border-radius: 10px; background: {selected ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {selected ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'};"
            >
              <span class="text-[15px] font-bold text-content">{preset.label}</span>
              <span class="text-[12.5px] text-content-dim">{preset.sub}</span>
            </button>
          {/each}
        </div>

        <button
          type="button"
          onclick={() => { customizeOpen = !customizeOpen; }}
          class="pressable mt-3 flex items-center gap-1.5 text-[13px] font-semibold"
          style="background: transparent; border: none; padding: 4px 0; color: {permissionPreset === 'custom' ? 'var(--agent-accent, #7c3aed)' : 'var(--text-muted)'};"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({customizeOpen ? 90 : 0}deg); transition: transform 120ms;" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          Customize{permissionPreset === "custom" ? " · custom set" : ""}
        </button>

        {#if customizeOpen}
          {#if permissionPreset === "custom" && platformPermissions.length === 0}
            <p class="mt-2 text-[12px]" style="color: var(--warning, #e8a13a);">
              No explicit grants — this cybo currently runs unrestricted (legacy). Pick a preset or check what it may do.
            </p>
          {/if}
          <div class="mt-2.5 flex flex-col gap-2.5">
            {#each PLATFORM_PERMISSION_OPTIONS as o (o.id)}
              {@const checked = platformPermissions.includes(o.id)}
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onclick={() => togglePlatformPermission(o.id)}
                class="pressable flex items-start gap-3 text-left"
                style="padding: 12px 14px; min-height: 44px; border-radius: 10px; background: {checked ? 'color-mix(in srgb, var(--agent-accent, #7c3aed) 12%, var(--bg-base))' : 'var(--bg-base)'}; border: 1px solid {checked ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'};"
              >
                <span class="mt-0.5 inline-flex shrink-0 items-center justify-center" style="width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid {checked ? 'var(--agent-accent, #7c3aed)' : 'var(--border)'}; background: {checked ? 'var(--agent-accent, #7c3aed)' : 'transparent'};">
                  {#if checked}<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                </span>
                <span class="min-w-0">
                  <span class="block text-[15px] font-bold text-content">{o.label}</span>
                  <span class="mt-0.5 block text-[12.5px] text-content-dim">{o.sub}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- ── Schedule ── -->
    <div>
      <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Schedule</p>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
        <p class="mb-3 text-[14px] text-content-dim">When the agent runs on its own, without being asked.</p>
        <div class="rounded-[10px] px-4 py-4 text-[14px] italic text-content-muted" style="border: 1px solid var(--border);">
          Coming next — cadence and triggers.
        </div>
      </div>
    </div>

    <!-- ── Save / Delete ── -->
    <div>
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
        <p class="mb-3 text-[14px] text-content-dim">
          {#if isEditing}
            Updates {displayName.trim() || "this cybo"} for everyone in the workspace. Running sessions keep their current persona — changes apply to new launches. Leave Personality empty to keep the existing one.
          {:else}
            This saves {displayName.trim() || "the agent"} as a reusable cybo in this workspace. It won't run anywhere yet — launch sessions from <strong class="text-content">Agents → Create agent</strong>, where it will be listed.
          {/if}
        </p>

        {#if error}
          <p class="mb-3 text-[13px] text-error">{error}</p>
        {/if}

        <button
          type="button"
          onclick={handleSaveCybo}
          disabled={!canCreate || creating}
          class="pressable flex h-[48px] w-full items-center justify-center gap-2 rounded-[12px] bg-btn-primary-bg text-[16px] font-bold text-btn-primary-text disabled:opacity-40 focus-ring"
        >
          {creating ? "Saving…" : isEditing ? "Save changes" : "Create cybo"}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </button>

        <p class="mt-2.5 text-center text-[13px] text-content-muted">
          {#if !displayName.trim()}
            Give your agent a name to continue.
          {:else if !isEditing && !selectedProvider}
            Pick a provider above to continue.
          {:else if isEditing}
            Saving updates @{handleName} in this workspace.
          {:else}
            Ready. It'll appear under Agents.
          {/if}
        </p>
      </div>

      {#if isEditing}
        <button
          type="button"
          onclick={handleDeleteCybo}
          disabled={deleting}
          class="pressable mt-4 flex h-[48px] w-full items-center justify-center rounded-[12px] text-[16px] font-semibold text-error disabled:opacity-50 focus-ring"
          style="border: 1px solid color-mix(in srgb, var(--error, #e01e5a) 45%, transparent);"
        >
          {deleting ? "Deleting…" : "Delete cybo"}
        </button>
      {/if}
    </div>

    </div>

  </div>
</div>
{/if}
