import { z } from "zod";
import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { access, constants as fsConstants, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CyborgAuthContext, CyborgAuth } from "./auth.js";
import type { MessageRouter } from "./message-router.js";
import { rewriteAgentImageUrls } from "./agent-image-url-map.js";
import { buildAgentPrompt } from "./agent-attachments.js";
import {
  generateWebhookSecret,
  newOutgoingWebhookId,
  normalizeEventFlags,
  validateWebhookUrl,
} from "./outgoing-webhook-delivery.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import type { DualStorage } from "./dual-storage.js";
import type { StoredAgentBinding, StoredArchivedSession, StoredTask } from "./storage.js";
import { isPageRestrictedFromUser, pageBroadcastPayload, PageCycleError } from "./page-access.js";
import { taskActivityEvents } from "./task-activity.js";
import { dispatchTaskToAgent, spawnNextRecurrence } from "./task-dispatch.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
// Exported Paseo helper (agent/ is read-only for us): clears a locally-archived
// agent record so a #593 override-aware restore re-registers it cleanly.
import { unarchiveAgentState } from "../agent/agent-prompt.js";
// Validates the cloud FORWARD-path local-import scan (handleForwardedRecentProviderSessions).
import { FetchRecentProviderSessionsRequestMessageSchema } from "@getpaseo/protocol/messages";
import { buildResumeOverrides, hasResumeConfigOverrides } from "./resume-overrides.js";
import type { Logger } from "pino";
import {
  CyborgChannelMessageSchema,
  CyborgDmSchema,
  CyborgTypingSchema,
  CyborgReactionSchema,
  CyborgFetchMessagesRequestSchema,
  CyborgFetchThreadRequestSchema,
  CyborgSearchSchema,
  CyborgPinMessageSchema,
  CyborgSaveMessageSchema,
  CyborgListSavedRequestSchema,
  CyborgEditMessageSchema,
  CyborgDeleteMessageSchema,
  CyborgMarkReadSchema,
  CyborgMessageActionSchema,
  CyborgStartTerminalRequestSchema,
  CyborgTerminalInputSchema,
  CyborgTerminalResizeSchema,
  CyborgKillTerminalSchema,
  CyborgSubscribeTerminalSchema,
  CyborgUnsubscribeTerminalSchema,
  CyborgForgetTerminalSchema,
  CyborgListTerminalsRequestSchema,
  CyborgMarkChannelUnreadSchema,
  CyborgFetchUnreadSchema,
  CyborgWorkspaceStatsSchema,
  CyborgFetchActivitySchema,
  CyborgMarkActivityReadSchema,
  CyborgSetNotificationPrefSchema,
  CyborgFetchNotificationPrefsSchema,
  CyborgDraftSetSchema,
  CyborgDraftClearSchema,
  CyborgFetchDraftsSchema,
  CyborgSyncRequestSchema,
  CyborgCreateChannelRequestSchema,
  CyborgCreateGroupDmRequestSchema,
  CyborgFetchChannelsRequestSchema,
  CyborgCreateWorkspaceRequestSchema,
  CyborgUpdateWorkspaceRequestSchema,
  CyborgDeleteWorkspaceRequestSchema,
  CyborgFetchWorkspacesRequestSchema,
  CyborgInviteMemberRequestSchema,
  CyborgRemoveMemberRequestSchema,
  CyborgUpdateRoleRequestSchema,
  CyborgCreateTaskRequestSchema,
  CyborgUpdateTaskRequestSchema,
  CyborgFetchTasksRequestSchema,
  CyborgFetchTasksProjectsRequestSchema,
  CyborgReorderTaskRequestSchema,
  CyborgBulkUpdateTasksRequestSchema,
  CyborgDeleteTaskRequestSchema,
  CyborgArchiveTaskRequestSchema,
  CyborgFetchProjectStatesRequestSchema,
  CyborgFetchProjectLabelsRequestSchema,
  CyborgFetchCyclesRequestSchema,
  CyborgFetchModulesRequestSchema,
  CyborgCreateCycleRequestSchema,
  CyborgUpdateCycleRequestSchema,
  CyborgDeleteCycleRequestSchema,
  CyborgFetchPagesRequestSchema,
  CyborgFetchPageRequestSchema,
  CyborgCreatePageRequestSchema,
  CyborgUpdatePageRequestSchema,
  CyborgSetPageArchivedRequestSchema,
  CyborgDeletePageRequestSchema,
  CyborgCreateModuleRequestSchema,
  CyborgUpdateModuleRequestSchema,
  CyborgDeleteModuleRequestSchema,
  CyborgFetchTaskActivityRequestSchema,
  CyborgAddTaskLinkRequestSchema,
  CyborgRemoveTaskLinkRequestSchema,
  CyborgFetchTaskLinksRequestSchema,
  CyborgAddTaskAttachmentRequestSchema,
  CyborgRemoveTaskAttachmentRequestSchema,
  CyborgFetchTaskAttachmentsRequestSchema,
  CyborgCreateAgentRequestSchema,
  CyborgListAgentsRequestSchema,
  CyborgListDaemonSessionsRequestSchema,
  CyborgSendAgentPromptRequestSchema,
  CyborgListProvidersRequestSchema,
  CyborgListMembersRequestSchema,
  CyborgAgentPermissionResponseSchema,
  CyborgCancelAgentSchema,
  CyborgClearAttentionSchema,
  CyborgSetAgentModelSchema,
  CyborgReloadSessionSchema,
  CyborgSetAgentModeSchema,
  CyborgSetAgentThinkingSchema,
  CyborgRewindAgentSchema,
  CyborgListCommandsSchema,
  CyborgDirectorySuggestionsSchema,
  CyborgListDaemonsRequestSchema,
  CyborgSetWorkspaceSlashConfigRequestSchema,
  CyborgGetWorkspaceSlashConfigRequestSchema,
  CyborgCreateCyboRequestSchema,
  CyborgSetCyboCredentialRequestSchema,
  CyborgRemoveCyboCredentialRequestSchema,
  CyborgListProviderAuthRequestSchema,
  CyborgFetchCybosRequestSchema,
  CyborgFetchCyboRequestSchema,
  CyborgImportCyboRequestSchema,
  CyborgCyboCliStatusRequestSchema,
  CyborgCyboCliUpdateRequestSchema,
  CyborgRefreshProvidersRequestSchema,
  CyborgCyboCliLatestRequestSchema,
  CyborgUpdateDaemonRequestSchema,
  CyborgDaemonUpdateLatestRequestSchema,
  CyborgUpdateCyboRequestSchema,
  CyborgDeleteCyboRequestSchema,
  CyborgSpawnCyboRequestSchema,
  CyborgCreateScheduleRequestSchema,
  CyborgListSchedulesRequestSchema,
  CyborgUpdateScheduleRequestSchema,
  CyborgSetScheduleEnabledRequestSchema,
  CyborgDeleteScheduleRequestSchema,
  CyborgRunScheduleOnceRequestSchema,
  CyborgListScheduleRunsRequestSchema,
  CyborgScheduleMessageCreateRequestSchema,
  CyborgScheduleMessageListRequestSchema,
  CyborgScheduleMessageCancelRequestSchema,
  CyborgCreateOutgoingWebhookRequestSchema,
  CyborgUpdateOutgoingWebhookRequestSchema,
  CyborgDeleteOutgoingWebhookRequestSchema,
  CyborgFetchOutgoingWebhooksRequestSchema,
  CyborgCreatePromptTemplateRequestSchema,
  CyborgUpdatePromptTemplateRequestSchema,
  CyborgDeletePromptTemplateRequestSchema,
  CyborgListPromptTemplatesRequestSchema,
  CyborgInvokeCyboMentionRequestSchema,
  CyborgInvokeChannelWatchRequestSchema,
  CyborgSlashCommandRequestSchema,
  CyborgFetchAgentStateRequestSchema,
  CyborgFetchAgentTimelineRequestSchema,
  CyborgFetchSessionContextRequestSchema,
  CyborgGetPairingInfoSchema,
  CyborgDevTokenRequestSchema,
  CyborgListRecentCwdsRequestSchema,
  CyborgArchiveAgentRequestSchema,
  CyborgListArchivedSessionsRequestSchema,
  CyborgRestoreSessionRequestSchema,
  CyborgImportSessionRequestSchema,
  CyborgCreateProjectRequestSchema,
  CyborgFetchProjectsRequestSchema,
  CyborgUpdateProjectRequestSchema,
  CyborgDeleteProjectRequestSchema,
  CyborgSetChannelProjectRequestSchema,
  CyborgSetChannelAutoTasksRequestSchema,
  CyborgFetchDaemonInfoRequestSchema,
  CyborgGrantDaemonAccessRequestSchema,
  CyborgSetDaemonAccessRequestSchema,
  CyborgRevokeDaemonAccessRequestSchema,
  CyborgRenameDaemonRequestSchema,
  CyborgFetchDaemonAccessRequestSchema,
  CyborgRequestDaemonAccessRequestSchema,
  CyborgResolveDaemonAccessRequestRequestSchema,
  CyborgFetchDaemonAccessRequestsRequestSchema,
  CyborgSetTerminalAliasRequestSchema,
  CyborgGetTerminalAliasesRequestSchema,
  serializeDaemonAccessRequest,
} from "./cyborg-messages.js";
import { normalizeScopes, roleForScopes, type DaemonScope } from "./daemon-scopes.js";
import type { CyborgSlashCommand } from "./cyborg-messages.js";
import { searchWorkspaceEntries } from "../../utils/directory-suggestions.js";
import { expandTilde } from "../../utils/path.js";
import {
  spawnCybo,
  CyboNotFoundError,
  describeSpawnCyboNotFound,
  scanLocalCybos,
  resolveCybo,
  resolveCyboHarness,
  resolveLocalCybo,
} from "./cybo-manager.js";
import { mentionInvocationGuard, watchInvocationGuard } from "./cybo-mention-invoke.js";
import { agentBindingVisibleCore } from "./relay-offline-agent-rows.js";
import {
  runDaemonSelfUpdate,
  latestDaemonVersion,
  defaultDaemonSelfUpdateDeps,
} from "./daemon-self-update.js";
import { getActionHandler, verifyAction } from "./signed-actions.js";
import { CyborgTerminalController } from "./terminal-controller.js";
import { resolvePersistEnabled, TerminalPersistenceStore } from "./terminal-persistence.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { isPtyHostEnabled } from "../../terminal/terminal-manager-factory.js";
import { computeNextRunAt, validateScheduleCadence } from "../schedule/cron.js";
import type { ScheduleRunner } from "./schedule-runner.js";
import type {
  StoredSchedule,
  StoredScheduleRun,
  StoredScheduledMessage,
  StoredPromptTemplate,
} from "./storage.js";
import { scheduledMessageView } from "./scheduled-message-runner.js";
import { promptTemplateView, validatePromptTemplate } from "./prompt-template-expand.js";
import type { CyborgScheduleView, CyborgScheduleRunView } from "./cyborg-messages.js";
import type { CyborgOutgoingWebhookView } from "./cyborg-messages.js";
import {
  cyboRequiredBackend,
  findBackendGap,
  nativeHarnessGapMessage,
  spawnBackendGapMessage,
} from "./cybo-runtime-profile.js";
import { classifyProviderError } from "./provider-error-classify.js";
import { isNativeHarnessProvider, probeNativeHarnessLogin } from "./native-harness-login.js";
import { CYBO_CODEX_APPROVAL_POLICY } from "./cybo-types.js";
import type { StoredCybo } from "./cybo-types.js";
import {
  describeCountArgWarnings,
  getSlashCommand,
  parseCountArgDetailed,
  unknownSlashTriggerError,
} from "./slash-commands.js";
import { findInaccessibleSlashDaemon, slashDaemonAccessError } from "./slash-daemon-access.js";
import { toRedactedSessionContext } from "./session-context-redact.js";
import { catchupDigestSystem, formatTranscript, summarizeTranscript } from "./summarization.js";
import { createAgentSummaryCompleter } from "./summarization-runner.js";
import { resolveSlashModelSelection } from "./slash-model-selection.js";
import {
  recheckProviders,
  reconcilePiSnapshotOnStatus,
  refreshPiSnapshotAfterInstall,
  reprobePiBeforeSpawn,
} from "./cybo-provider-refresh.js";
import { CyboCredentialStore } from "./cybo-credentials.js";
import { type ComposioDeps, createComposioDeps } from "./composio-deps.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { extractActionItems, generateStandup, translateMessages } from "./channel-ai-commands.js";
import type { ProviderDefinition } from "../agent/provider-registry.js";
import { RateLimiter } from "./rate-limiter.js";
import type { AgentTimelineStore } from "../agent/agent-timeline-store-types.js";

type EmitFn = (msg: unknown) => void;
type SubscribeWorkspaceFn = (workspaceId: string) => void;

const execFileAsync = promisify(execFile);

// StoredTask (snake_case) → the camelCase shape the cyborg:tasks_changed payload
// carries, matching the relay's mapTask so both deployment modes emit one wire
// shape for the broadcast (see CyborgTasksChangedSchema).
function mapTaskForBroadcast(t: StoredTask) {
  return {
    id: t.id,
    workspaceId: t.workspace_id,
    title: t.title,
    description: t.description,
    status: t.status,
    assigneeId: t.assignee_id,
    createdBy: t.created_by,
    dueAt: t.due_at,
    result: t.result ?? null,
    channelId: t.channel_id ?? null,
    priority: t.priority ?? null,
    // Phase 0 — lane ordering, planned start, soft-archive, draft. The board/list/
    // gantt layouts read these; carried on every broadcast + fetch so the client
    // never needs a second round-trip.
    sortOrder: t.sort_order ?? null,
    startDate: t.start_date ?? null,
    archivedAt: t.archived_at ?? null,
    isDraft: (t.is_draft ?? 0) === 1,
    // Tasks Redesign readback — snake_case to MATCH the relay's mapTask (the cloud
    // path's broadcast/response contract). Optional so an old row (no Plane columns)
    // maps to null/[]. The denormalized label/module id arrays come off the join
    // tables (populated by the storage satellite-loader).
    project_id: t.project_id ?? null,
    parent_id: t.parent_id ?? null,
    state_id: t.state_id ?? null,
    sequence_id: t.sequence_id ?? null,
    cycle_id: t.cycle_id ?? null,
    label_ids: t.label_ids ?? [],
    module_ids: t.module_ids ?? [],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// Probe one CLI by running `<bin> --version` directly. No `which`/`where` locate
// step: on Windows that returns the extensionless bash shim first (which cmd.exe
// can't run), it's absent in minimal environments, and it doubles the spawns. With
// shell:true on win32, cmd.exe resolves `<bin>.cmd` via PATHEXT. Timeout-bounded.
async function probeCliVersion(bin: string): Promise<string | null> {
  const { stdout } = await execFileAsync(bin, ["--version"], {
    timeout: 4000,
    shell: process.platform === "win32",
  });
  return stdout.trim() || null;
}

// Detect the host cybo/PI runtime, mirroring the daemon's capability flag in
// bootstrap (`cybo || pi`): `cybo` is the persona wrapper, `pi` the underlying
// runtime, and a cybo can be spawned if EITHER is on PATH (a provider:"pi" agent
// runs `process.env.PI_COMMAND ?? "pi"`). Probing only `cybo` lied both ways: a
// false negative on a daemon that has `pi` but not `cybo`, and a false positive
// right after `npm i -g @cyborg7/cybo` (which links only the `cybo` bin — its
// bundled pi is a nested dep, so `pi` isn't on PATH) where a provider:"pi" spawn
// would then ENOENT. Try `cybo` first (it's the install target / canonical
// surface), fall back to `pi`; installed=true if EITHER answers, and `path`
// records which one. Failure-tolerant — neither present resolves to not-installed.
async function detectPiCli(): Promise<{
  installed: boolean;
  version: string | null;
  path: string | null;
}> {
  for (const bin of ["cybo", "pi"] as const) {
    try {
      const version = await probeCliVersion(bin);
      return { installed: true, version, path: bin };
    } catch {
      // not this one — try the next
    }
  }
  return { installed: false, version: null, path: null };
}

// npm refuses to overwrite an existing global bin and fails with EEXIST, naming the
// conflicting path and telling you to "run npm with --force to overwrite". cybo 0.2.5
// ships a `pi` bin (Option A, internal docs) that is a shim to its bundled Pi, so when
// a user already has a separate / stale `pi` link, the Update button hit this. The
// remedy npm itself prints is --force, and overwriting the stale link with cybo's
// managed shim is exactly the desired outcome (the daemon should use cybo's pi).
const NPM_EEXIST_RE = /EEXIST/i;
// npm prints e.g. "File exists: /Users/rodri/.proto/tools/node/25.6.1/bin/pi".
function parseEexistConflictPath(text: string): string | null {
  const m = text.match(/File exists:\s*(\S+)/i);
  return m ? m[1] : null;
}
// execFile rejections carry the npm output on `.stderr` (and usually `.message`);
// fold both so EEXIST detection doesn't depend on which one npm wrote to.
function execErrorText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; stderr?: unknown };
    const parts = [
      typeof e.message === "string" ? e.message : "",
      e.stderr != null ? String(e.stderr) : "",
    ].filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return String(err);
}

// Locate every `bin` on the daemon's PATH, PATH-order first (posix `which -a`).
// Best-effort: on win32 (where the extensionless bash shim makes `which`/`where`
// output unreliable — see probeCliVersion) and on any failure this resolves to [],
// which callers treat as "couldn't locate" and skip prefix reasoning.
async function locateOnPath(bin: string): Promise<string[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("which", ["-a", bin], { timeout: 4000 });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The global-bin directory of a specific npm binary (`npm prefix -g` → `<prefix>/bin`
// on posix). This is where THAT npm links global package bins — which, with multiple
// node installs (proto, homebrew, nvm, ~/.npm-global), is not necessarily a directory
// the daemon's PATH ever consults. null on failure or win32 (no prefix reasoning).
async function npmGlobalBinDir(npmBin: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync(npmBin, ["prefix", "-g"], { timeout: 20_000 });
    const prefix = stdout.trim();
    return prefix ? join(prefix, "bin") : null;
  } catch {
    return null;
  }
}

// Install/upgrade the host cybo CLI to the latest, then re-detect. Fixed command
// (no user input), generously timeout-bounded (a global npm install is slow), and
// failure-tolerant — the daemon-access gate already required to reach this daemon
// is the security boundary (daemon access = running code here, per #35).
//
// On a `pi`-bin EEXIST conflict, retry ONCE with --force (npm's own remedy) and, if
// that also fails, return a SHORT readable error (the full npm wall goes to the log).
//
// MULTI-PREFIX HOSTS (proto/homebrew/nvm): `npm i -g` installs into the prefix of
// whichever npm runs, while detection probes whichever `cybo` the PATH resolves —
// two different prefixes means the install "succeeds" but the detected version never
// changes, so the UI shows "update available" forever with no error. Two defenses:
//   1. Prefer the npm that lives NEXT TO the PATH-resolved cybo, so the install
//      lands in the prefix detection actually looks at.
//   2. After installing, probe the copy at the installing npm's global-bin dir and
//      compare with what the PATH resolves — on mismatch, report BOTH locations
//      clearly instead of silently returning the stale version as success.
// `run`/`detect`/`log`/`locate`/`globalBinDir`/`probe` are injectable for tests;
// defaults hit real npm + detection.
// ─── Owning-package-manager detection (the pnpm/proto dead-end fix) ─────────
//
// `npm i -g` always installs into NPM's prefix — but when the cybo the PATH
// resolves is owned by ANOTHER manager (pnpm shim in ~/Library/pnpm, bun in
// ~/.bun), the freshly installed copy loses to the old one on every probe:
// "Installed 0.2.6 at <npm prefix>, but the daemon's PATH resolves a different
// cybo at ~/Library/pnpm/cybo (0.2.5)" — an update loop with no exit from the
// UI. The fix: update WITH the manager that owns the PATH-resolved binary, so
// the copy that wins is the copy that gets updated.

export type GlobalBinManager = "npm" | "pnpm" | "bun";

const MANAGER_INSTALL: Record<GlobalBinManager, { bin: string; args: readonly string[] }> = {
  npm: { bin: "npm", args: ["install", "-g", "@cyborg7/cybo@latest"] },
  pnpm: { bin: "pnpm", args: ["add", "-g", "@cyborg7/cybo@latest"] },
  bun: { bin: "bun", args: ["add", "-g", "@cyborg7/cybo@latest"] },
};

// The exact remedial command for a manager — surfaced to the client so "Show
// command" shows something that actually works on that host.
export function managerInstallCommand(manager: GlobalBinManager): string {
  const { bin, args } = MANAGER_INSTALL[manager];
  return `${bin} ${args.join(" ")}`;
}

// Which manager owns a binary, from its REAL path (resolve symlinks first —
// pnpm/bun link their shims). PNPM_HOME / BUN_INSTALL are authoritative when
// set; otherwise the managers' conventional homes (~/Library/pnpm on macOS,
// ~/.local/share/pnpm on Linux, ~/.bun). Everything else (npm prefixes, proto
// shims, homebrew) updates via npm exactly as before.
export function detectBinaryManager(
  realPath: string,
  env: { PNPM_HOME?: string; BUN_INSTALL?: string } = process.env,
): GlobalBinManager {
  const p = realPath.replaceAll("\\", "/");
  const under = (home: string | undefined): boolean => {
    if (!home) return false;
    const h = home.replaceAll("\\", "/").replace(/\/+$/, "");
    return p === h || p.startsWith(`${h}/`);
  };
  if (under(env.PNPM_HOME) || /\/(Library\/pnpm|\.local\/share\/pnpm)\//.test(p)) return "pnpm";
  if (under(env.BUN_INSTALL) || /\/\.bun\//.test(p)) return "bun";
  return "npm";
}

interface UpdateCyboCliHooks {
  run: (npmBin: string, args: readonly string[]) => Promise<unknown>;
  detect: () => Promise<{ installed: boolean; version: string | null; path?: string | null }>;
  log: (msg: string) => void;
  locate: (bin: string) => Promise<string[]>;
  globalBinDir: (npmBin: string) => Promise<string | null>;
  probe: (bin: string) => Promise<string | null>;
  fileExists: (path: string) => Promise<boolean>;
  // Symlink-resolved path of a binary (pnpm/bun shims are links into their
  // stores); falls back to the input on failure.
  realpath: (path: string) => Promise<string>;
}

interface UpdateCyboCliResult {
  ok: boolean;
  installed: boolean;
  version: string | null;
  error: string | null;
  // The exact remedial command for THIS host's owning manager, for the
  // client's "Show command" fallback (npm's command is useless on a
  // pnpm/bun-owned install). Present on failures; omitted on success.
  command?: string;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Defense 1: pick the npm of the SAME prefix as the PATH-resolved cybo (its
// bin-dir sibling), so the upgrade replaces the copy detection probes. On a
// single-prefix host this resolves to the same npm as bare `npm`; when there's
// no cybo on PATH (fresh install) or no sibling npm, fall back to PATH `npm`.
async function chooseInstallNpm(
  cyboOnPath: string | null,
  hooks: UpdateCyboCliHooks,
): Promise<string> {
  if (!cyboOnPath) return "npm";
  const siblingNpm = join(dirname(cyboOnPath), "npm");
  if (!(await hooks.fileExists(siblingNpm))) return "npm";
  hooks.log(`[cybo_cli_update] using ${siblingNpm} (same prefix as PATH cybo ${cyboOnPath})`);
  return siblingNpm;
}

// `npm i -g @cyborg7/cybo@latest` with the EEXIST → --force retry (#357). Returns
// null on success, or the failure result to surface to the caller.
async function runNpmInstall(
  npmBin: string,
  hooks: UpdateCyboCliHooks,
): Promise<UpdateCyboCliResult | null> {
  const INSTALL_ARGS = ["install", "-g", "@cyborg7/cybo@latest"] as const;
  const FORCE_ARGS = ["install", "-g", "--force", "@cyborg7/cybo@latest"] as const;
  try {
    await hooks.run(npmBin, INSTALL_ARGS);
    return null;
  } catch (firstErr) {
    const firstText = execErrorText(firstErr);
    hooks.log(`[cybo_cli_update] npm install failed: ${firstText}`);
    if (!NPM_EEXIST_RE.test(firstText)) {
      // Not an overwrite conflict — surface the original message unchanged.
      return {
        ok: false,
        installed: false,
        version: null,
        error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      };
    }
    const conflictPath = parseEexistConflictPath(firstText);
    hooks.log(
      `[cybo_cli_update] npm EEXIST${conflictPath ? ` on "${conflictPath}"` : ""} — retrying with --force`,
    );
    try {
      await hooks.run(npmBin, FORCE_ARGS);
    } catch (forceErr) {
      hooks.log(`[cybo_cli_update] --force install also failed: ${execErrorText(forceErr)}`);
      return {
        ok: false,
        installed: false,
        version: null,
        error: `Install conflict: another Cybo runtime binary already exists${conflictPath ? ` at ${conflictPath}` : ""}. Remove it or run: npm i -g --force @cyborg7/cybo@latest`,
      };
    }
    hooks.log("[cybo_cli_update] --force install succeeded");
    return null;
  }
}

// Defense 2: verify the PATH actually sees what we just installed. Probe the
// cybo at the installing npm's global-bin dir; if it answers with a DIFFERENT
// version than the PATH-resolved cybo, the host has two copies in different
// prefixes — report both locations instead of returning the stale version as
// success (the silent "update available forever" loop). Best-effort: when the
// bin dir / probe / locate are unavailable (win32, odd setups), return null and
// keep the plain detect() result. Only compares when detection answered via the
// `cybo` bin — a `pi` fallback's version is a different program's.
async function detectPrefixConflict(args: {
  npmBin: string;
  cyboOnPath: string | null;
  status: { installed: boolean; version: string | null; path?: string | null };
  hooks: UpdateCyboCliHooks;
}): Promise<UpdateCyboCliResult | null> {
  const { npmBin, cyboOnPath, status, hooks } = args;
  const installBinDir = await hooks.globalBinDir(npmBin);
  const installedBin = installBinDir ? join(installBinDir, "cybo") : null;
  if (!installedBin || !(await hooks.fileExists(installedBin))) return null;
  // A failed probe means "version unknown", which the null-guard below treats the
  // same as "no conflict detected".
  // intentional: best-effort version probe.
  const installedVersion = await hooks.probe(installedBin).catch(() => null);
  if (!installedVersion) return null;

  const pathSeesStaleCybo =
    status.installed &&
    status.path === "cybo" &&
    !!status.version &&
    status.version !== installedVersion;
  if (pathSeesStaleCybo) {
    const staleAt = cyboOnPath && cyboOnPath !== installedBin ? ` at ${cyboOnPath}` : "";
    const error =
      `Installed ${installedVersion} at ${installedBin}, but the daemon's PATH resolves ` +
      `a different cybo${staleAt} (${status.version}). Fix your PATH order or remove the ` +
      `old copy (see \`which -a cybo\`).`;
    hooks.log(`[cybo_cli_update] prefix mismatch: ${error}`);
    return { ok: false, installed: true, version: status.version, error };
  }

  if (!status.installed) {
    const error =
      `Installed ${installedVersion} at ${installedBin}, but that directory isn't on the ` +
      `daemon's PATH — add ${installBinDir} to PATH (or restart the daemon) so it can be used.`;
    hooks.log(`[cybo_cli_update] installed outside PATH: ${error}`);
    return { ok: false, installed: false, version: null, error };
  }

  return null;
}

// oxlint-disable-next-line eslint/complexity -- manager-detection + install + verify decision tree
export async function updateCyboCli(
  opts?: Partial<UpdateCyboCliHooks>,
): Promise<UpdateCyboCliResult> {
  const hooks: UpdateCyboCliHooks = {
    run:
      opts?.run ??
      ((npmBin: string, args: readonly string[]) =>
        execFileAsync(npmBin, [...args], {
          timeout: 180_000,
          shell: process.platform === "win32",
        })),
    detect: opts?.detect ?? detectPiCli,
    log: opts?.log ?? ((m: string) => console.error(m)),
    locate: opts?.locate ?? locateOnPath,
    globalBinDir: opts?.globalBinDir ?? npmGlobalBinDir,
    probe: opts?.probe ?? probeCliVersion,
    fileExists: opts?.fileExists ?? executableExists,
    realpath: opts?.realpath ?? ((path: string) => realpath(path).catch(() => path)),
  };

  const cyboOnPath = (await hooks.locate("cybo"))[0] ?? null;
  // Update WITH the manager that OWNS the PATH-resolved copy (real path —
  // pnpm/bun shims are symlinks). npm installing next to a pnpm-owned cybo
  // lands in the wrong prefix and the old copy keeps winning (the
  // ~/Library/pnpm 0.2.5 dead-end).
  const realCybo = cyboOnPath ? await hooks.realpath(cyboOnPath) : null;
  const manager: GlobalBinManager = realCybo ? detectBinaryManager(realCybo) : "npm";

  if (manager !== "npm") {
    const { bin, args } = MANAGER_INSTALL[manager];
    const command = managerInstallCommand(manager);
    // null just means "pre-install version unknown", surfaced as-is in the
    // result's `version` field below.
    // intentional: best-effort version probe.
    const preVersion = cyboOnPath ? await hooks.probe(cyboOnPath).catch(() => null) : null;
    const managerOnPath = (await hooks.locate(bin))[0] ?? null;
    if (!managerOnPath) {
      hooks.log(
        `[cybo_cli_update] PATH cybo is ${manager}-owned (${realCybo}) but ${bin} isn't on the daemon's PATH`,
      );
      return {
        ok: false,
        installed: true,
        version: preVersion,
        error:
          `This daemon's cybo is managed by ${manager}, which isn't available to the daemon — ` +
          `run this on the daemon's machine: ${command}`,
        command,
      };
    }
    hooks.log(
      `[cybo_cli_update] PATH cybo is ${manager}-owned (${realCybo}) — updating via ${bin}`,
    );
    try {
      await hooks.run(bin, args);
    } catch (err) {
      hooks.log(`[cybo_cli_update] ${bin} install failed: ${execErrorText(err)}`);
      return {
        ok: false,
        installed: true,
        version: preVersion,
        error: `${manager} update failed — run this on the daemon's machine: ${command}`,
        command,
      };
    }
    // Verify the PATH-resolved copy actually changed (the #368 bar): the owner
    // manager updates the copy the PATH wins with, so a plain re-detect IS the
    // verification — no npm-prefix cross-check applies here.
    const after = await hooks.detect();
    if (after.installed && after.version && preVersion && after.version === preVersion) {
      hooks.log(
        `[cybo_cli_update] ${bin} ran but the PATH-resolved version is still ${preVersion} (already latest, or a second copy shadows it)`,
      );
    }
    return {
      ok: after.installed,
      installed: after.installed,
      version: after.version,
      error: after.installed ? null : "Install ran but the CLI wasn't detected afterwards.",
      ...(after.installed ? {} : { command }),
    };
  }

  const npmBin = await chooseInstallNpm(cyboOnPath, hooks);

  const installFailure = await runNpmInstall(npmBin, hooks);
  if (installFailure) return installFailure;

  const status = await hooks.detect();
  const conflict = await detectPrefixConflict({ npmBin, cyboOnPath, status, hooks });
  if (conflict) return conflict;

  return {
    ok: status.installed,
    installed: status.installed,
    version: status.version,
    error: status.installed ? null : "Install ran but the CLI wasn't detected afterwards.",
  };
}

// Query the latest published @cyborg7/cybo version via the DAEMON's own npm — the
// same npm (and registry/config) `npm i -g @cyborg7/cybo@latest` would use — so an
// "update available?" check reflects what THIS daemon would actually install, not a
// guess from a public-registry fetch. Read-only; timeout-bounded.
async function latestCyboCliVersion(): Promise<{
  ok: boolean;
  latest: string | null;
  error: string | null;
}> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", "@cyborg7/cybo@latest", "version"], {
      timeout: 20_000,
      shell: process.platform === "win32",
    });
    const latest = stdout.trim() || null;
    return latest
      ? { ok: true, latest, error: null }
      : { ok: false, latest: null, error: "npm returned no version" };
  } catch (err) {
    return { ok: false, latest: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// Cybo permission columns are stored as JSON-text arrays in SQLite. Parse
// defensively so a malformed/legacy value never breaks the fetch response.
function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ONE time budget for an AI slash command (/summarize, /standup, …). 30s was too
// tight: a slow model (e.g. Pi opencode-go/glm-5.1) plus the completer's contention
// wait — for a live Pi session to free the shared model backend (#294) — routinely
// blew past it, surfacing a raw "timed out after 30s". 120s gives a slow model
// ample room for a few chunks AND a couple of contention waits, while still capping
// a genuinely stuck command. The completer's retry budget is derived from this same
// constant (minus the margin) so the hard timeout and the retry can't drift, and so
// contention fails with a clean "busy" message ~10s BEFORE the hard timeout fires.
const SLASH_AI_COMMAND_TIMEOUT_MS = 120_000;
const SLASH_AI_CONTENTION_MARGIN_MS = 10_000;

// Human-facing labels for the providers the slash AI commands can run on.
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Cybo",
  opencode: "OpenCode",
  copilot: "Copilot",
  gemini: "Gemini",
  qwen: "Qwen",
  openai: "OpenAI",
  deepseek: "DeepSeek",
};

// Pull a readable model family out of a model id ("claude-haiku-4-5" → "Haiku",
// "anthropic/claude-3-5-sonnet" → "Sonnet"). Falls back to the last path segment.
// Either way the result is capitalized so an unmatched id (e.g. "deepseek-chat")
// reads consistently with the matched families.
function shortModelLabel(model: string): string {
  const base = model.split("/").pop() ?? model;
  const family = base.match(/(haiku|sonnet|opus|gpt[\w.-]*|gemini[\w.-]*|qwen[\w.-]*|mini)/i);
  const label = family ? family[1] : base;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Attribution label for a slash AI command result: provider + optional model,
// e.g. "Claude (Haiku)", "Codex", "Pi".
function formatResponder(provider: string, model?: string | null): string {
  const label = PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  const short = model ? shortModelLabel(model) : null;
  return short ? `${label} (${short})` : label;
}

interface CyborgMsg {
  type: string;
  [key: string]: unknown;
}

interface StorageMessage {
  id: string;
  channel_id: string | null;
  from_id: string;
  from_type: string;
  from_name: string | null;
  to_id: string | null;
  text: string;
  mentions: string | string[] | null;
  parent_id: string | null;
  attachments?: string | unknown[] | null;
  pinned_at?: number | null;
  pinned_by?: string | null;
  updated_at?: number | null;
  reply_count?: number;
  last_reply_at?: number | null;
  seq: number;
  created_at: number;
}

export interface CyborgAuthSetter {
  (ctx: CyborgAuthContext): void;
}

export class CyborgDispatcher {
  private agentManager: AgentManager | null = null;
  private agentStorage: AgentStorage | null = null;
  private logger: Logger | null = null;
  private providerRegistry: Record<string, ProviderDefinition> | null = null;
  private readonly rateLimiter = new RateLimiter();
  // In-flight import guard (Gemini review): two concurrent imports of the SAME
  // (workspace, provider, providerHandleId) both clear the idempotent "already
  // live" short-circuit and each spawn a DUPLICATE agent. Single-flight by that
  // key so concurrent callers share ONE import+archive and the same result;
  // DIFFERENT keys never block each other. The entry is cleared on settle
  // (success AND error) so a failed import can be retried.
  private readonly importSessionInFlight = new Map<
    string,
    Promise<{ agentId: string; sessionId: string }>
  >();
  private cyborgAuth: CyborgAuth | null = null;
  private serverId: string | null = null;
  // Daemon-scoped terminal sessions (#654). Null until bootstrap wires the
  // inherited TerminalManager via setTerminalManager.
  private terminalController: CyborgTerminalController | null = null;
  private durableTimelineStore: AgentTimelineStore | null = null;
  private cyborg7McpBaseUrl: string | null = null;
  private daemonOwnerId: string | null = null;
  private onClaimDaemon: ((userId: string) => void) | null = null;
  // For resolving real structured-generation providers for the channel AI
  // commands (/summarize etc.) — without these the completer had no providers
  // and failed with "Structured generation failed for all providers".
  private providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "listProviders" | "refreshSnapshotForCwd" | "getProviderDiagnostic"
  > | null = null;
  private daemonConfigStore: DaemonConfigStore | null = null;
  // The per-daemon cron runner — only needed for the run_once RPC ("Run now"),
  // which delegates to it so the fire logic stays in one place (the runner).
  private scheduleRunner: ScheduleRunner | null = null;
  private pairingOffer: {
    serverId: string;
    daemonPublicKeyB64: string;
    relay: { endpoint: string; useTls?: boolean };
  } | null = null;
  // Per-daemon encrypted credential store (internal docs Phase 1). Lazily built so
  // it picks up $PASEO_HOME at first use and so daemons that never touch credentials
  // pay nothing. SHIPS DARK: nothing resolves from it at spawn yet — only the
  // set/remove/list RPCs below read/write it.
  private credentialStoreInstance: CyboCredentialStore | null = null;

  private get credentialStore(): CyboCredentialStore {
    if (!this.credentialStoreInstance) {
      this.credentialStoreInstance = new CyboCredentialStore({
        logger: this.logger ?? undefined,
      });
    }
    return this.credentialStoreInstance;
  }

  // Composio third-party tools (knowledge: composio-ownership-and-permissions).
  // Built once from COMPOSIO_API_KEY; `undefined` (feature off) when unset, so the
  // spawn path's injectComposioMcpServers is a strict no-op and every spawn stays
  // byte-identical. SHIPS DARK until an operator sets the key.
  private composioDepsResolved = false;
  private composioDepsInstance: ComposioDeps | undefined;

  private get composio(): ComposioDeps | undefined {
    if (!this.composioDepsResolved) {
      this.composioDepsInstance = createComposioDeps(this.storage);
      this.composioDepsResolved = true;
    }
    return this.composioDepsInstance;
  }

  // This daemon's human-readable label (host name) — woven into the native
  // harness gap message so the user knows WHICH machine to sign in (internal docs
  // PART 1). Same source the workspace-daemon row uses as its display label.
  private daemonLabelCache: string | null = null;
  private get daemonLabel(): string {
    if (this.daemonLabelCache === null) {
      try {
        this.daemonLabelCache = osHostname();
      } catch {
        this.daemonLabelCache = "";
      }
    }
    return this.daemonLabelCache;
  }

  constructor(
    private messageRouter: MessageRouter,
    private workspaceManager: WorkspaceManager,
    private storage: DualStorage,
  ) {}

  setServerId(id: string): void {
    this.serverId = id;
  }

  setCyborg7McpBaseUrl(url: string | null): void {
    this.cyborg7McpBaseUrl = url;
  }

  // Wire the inherited terminal engine (#654). bootstrap passes the same
  // TerminalManager Paseo uses; the controller holds the daemon-scoped sessions.
  setTerminalManager(terminalManager: TerminalManager, defaultCwd: string): void {
    // Dispose a prior controller (kill its sessions/timers/listeners) before
    // replacing it — a second call would otherwise orphan the old terminals.
    this.terminalController?.dispose();
    // PtyHost mode (internal docs PART A, flag CYBORG7_PTY_HOST): when bootstrap
    // launched the cyborg PtyHost, the manager is host-capable and ptys survive a
    // restart. The controller then DETACHES on dispose (instead of killing) and
    // RE-WRAPS the host's surviving ptys as live sessions on boot.
    const ptyHostMode = isPtyHostEnabled();
    // Cross-restart scrollback persistence (#750, internal docs). PERSISTENCE
    // FOLLOWS PTYHOST (#856 fix): when PtyHost is on, live ptys survive a daemon
    // restart, so rehydrate MUST be able to restore each session's OWNER — which
    // lives ONLY in the persisted #750 sidecar. With persistence off, the sidecar
    // is never written, rehydrate falls back to syntheticMeta (ownerUserId ""), and
    // the owner-lock then rejects the real owner's re-subscribe → "this terminal
    // session is no longer available". So default persistence to track PtyHost.
    // resolvePersistEnabled keeps CYBORG7_PERSIST_TERMINALS as an explicit override
    // (set it to 0/false to FORCE-disable disk persistence even with PtyHost on).
    const persistence = new TerminalPersistenceStore({
      enabled: resolvePersistEnabled(ptyHostMode),
      logger: this.logger ?? undefined,
    });
    this.terminalController = new CyborgTerminalController(
      terminalManager,
      defaultCwd,
      persistence,
      {
        ptyHostMode,
        // Push a fresh workspace directory snapshot to the owner on every start/
        // exit so a terminal opened (or killed) out-of-band — CLI, another client —
        // appears/disappears in the UI sidebar live (owner-scoped broadcast).
        onDirectoryChanged: ({ workspaceId, ownerUserId }) => {
          this.broadcastTerminalDirectory(workspaceId, ownerUserId);
        },
        // Owner-lock diagnostics (#876 cloud follow-up): trace create/subscribe/
        // rehydrate owner identity so a cloud re-attach that dead-ends is debuggable
        // from the daemon log (non-secret ids/emails only — never tokens).
        logger: this.logger ?? undefined,
      },
    );
    // Reattach to ptys that survived a daemon restart (no-op unless ptyHostMode +
    // a host-capable manager). The next client subscribe then returns live:true.
    const rehydrated = this.terminalController.rehydrateLiveSessions();
    if (rehydrated > 0) {
      this.logger?.info(
        { event: "pty_host_rehydrate", count: rehydrated },
        "pty-host: reattached to surviving live terminals",
      );
    }
  }

  // Tear down all terminals on daemon shutdown.
  disposeTerminals(): void {
    this.terminalController?.dispose();
  }

  setScheduleRunner(runner: ScheduleRunner): void {
    this.scheduleRunner = runner;
  }

  setPairingOffer(offer: {
    serverId: string;
    daemonPublicKeyB64: string;
    relay: { endpoint: string; useTls?: boolean };
  }): void {
    this.pairingOffer = offer;
  }

  setProviderRegistry(registry: Record<string, ProviderDefinition>): void {
    this.providerRegistry = registry;
  }

  setCyborgAuth(auth: CyborgAuth): void {
    this.cyborgAuth = auth;
  }

  setAgentManager(agentManager: AgentManager): void {
    this.agentManager = agentManager;
  }

  // Wire the live provider catalog + daemon config so the channel AI commands
  // resolve real structured-generation providers (haiku-first, then fallbacks).
  setProviderSnapshotManager(
    manager: Pick<
      ProviderSnapshotManager,
      "listProviders" | "refreshSnapshotForCwd" | "getProviderDiagnostic"
    >,
  ): void {
    this.providerSnapshotManager = manager;
  }

  setDaemonConfigStore(store: DaemonConfigStore): void {
    this.daemonConfigStore = store;
  }

  setAgentStorage(agentStorage: AgentStorage, logger: Logger): void {
    this.agentStorage = agentStorage;
    this.logger = logger;
  }

  setDurableTimelineStore(store: AgentTimelineStore): void {
    this.durableTimelineStore = store;
  }

  setDaemonOwnerId(ownerId: string | null): void {
    this.daemonOwnerId = ownerId;
  }

  setOnClaimDaemon(fn: (userId: string) => void): void {
    this.onClaimDaemon = fn;
  }

  private async ensureAgentLoaded(agentId: string): Promise<ManagedAgent | null> {
    if (!this.agentManager) return null;
    const existing = this.agentManager.getAgent(agentId);
    if (existing) return existing;
    if (!this.agentStorage || !this.logger) return null;
    try {
      const { ensureAgentLoaded } = await import("../agent/agent-loading.js");
      return await ensureAgentLoaded(agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      });
    } catch {
      return null;
    }
  }

  private subscribeWorkspace: SubscribeWorkspaceFn = () => {};

  dispatch(
    msg: CyborgMsg,
    auth: CyborgAuthContext | null,
    emit: EmitFn,
    setAuth?: CyborgAuthSetter,
    subscribeWorkspace?: SubscribeWorkspaceFn,
  ): Promise<void> | undefined {
    // The local-import SCAN (#resume picker "Local import" tab) is the ONE Paseo-
    // native (non-`cyborg:`) message the cloud relay forwards into the dispatcher
    // (relay_rpc.inner): its scan of the daemon's on-disk provider transcripts
    // (~/.claude/projects, …) must run ON the daemon, and the UI sends the Paseo-
    // native name (we don't rename client messages). session.ts still serves the
    // DIRECT (local-daemon) path; this dispatcher branch serves the cloud FORWARD
    // path. Let it past the `cyborg:` prefix gate; it's routed (with auth) below,
    // before route()'s cyborg-only switch.
    const isLocalSessionScan = msg.type === "fetch_recent_provider_sessions_request";
    if (!msg.type.startsWith("cyborg:") && !isLocalSessionScan) return undefined;

    if (subscribeWorkspace) {
      this.subscribeWorkspace = subscribeWorkspace;
    }

    if (msg.type === "cyborg:auth") {
      return this.handleAuth(msg, emit, setAuth);
    }

    if (msg.type === "cyborg:dev_token") {
      return this.handleDevToken(msg, emit);
    }

    if (!auth) {
      emit({
        type: "cyborg:error",
        payload: {
          code: "unauthenticated",
          message: "Cyborg7 requires JWT auth. Send cyborg:auth first.",
        },
      });
      return undefined;
    }

    if (isLocalSessionScan) {
      return this.handleForwardedRecentProviderSessions(msg, emit);
    }

    try {
      const result = this.route(msg, auth, emit);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          this.emitZodOrRethrow(err, msg, emit);
        });
      }
      return result;
    } catch (err) {
      this.emitZodOrRethrow(err, msg, emit);
      return undefined;
    }
  }

  private emitZodOrRethrow(err: unknown, msg: CyborgMsg, emit: EmitFn): void {
    if (err instanceof z.ZodError) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
      emit({
        type: "cyborg:error",
        payload: {
          requestId,
          code: "validation_error",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      });
      return;
    }
    throw err;
  }

  // Surface a caught NON-Zod Error from a task handler (e.g. a storage resolver
  // throw like "provide projectId or channelId" / "project not found") to the
  // caller as a cyborg:error carrying the real message + the request's requestId —
  // the same shape the relay's respondError uses. Without this the throw escapes to
  // emitZodOrRethrow, which rethrows non-Zod errors; the rethrow becomes a non-
  // cyborg `rpc_error` the cyborg CLI client can't match by requestId, so it hangs
  // to its ~15s timeout instead of failing fast with the message. Zod-validation
  // errors are unaffected — they're parsed before these try/catches and still flow
  // through emitZodOrRethrow.
  private emitTaskOpError(requestId: string, err: unknown, emit: EmitFn): void {
    emit({
      type: "cyborg:error",
      payload: {
        requestId,
        code: "invalid_request",
        message: err instanceof Error ? err.message : "task operation failed",
      },
    });
  }

  private handleAuth(msg: CyborgMsg, emit: EmitFn, setAuth?: CyborgAuthSetter): undefined {
    // Correlate every reply (success OR error) with the caller's requestId.
    // A cyborg CLI talking directly to a headless daemon resolves/rejects its
    // pending request by requestId; an error without it can't be matched and the
    // client hangs until its own 15s timeout instead of surfacing the failure.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    if (!this.cyborgAuth) {
      emit({
        type: "cyborg:error",
        payload: { requestId, code: "internal", message: "Auth service not configured" },
      });
      return undefined;
    }
    const token = typeof msg.token === "string" ? msg.token : "";
    const authCtx = this.cyborgAuth.validateToken(token);
    if (!authCtx) {
      emit({
        type: "cyborg:error",
        payload: { requestId, code: "unauthenticated", message: "Invalid or expired token" },
      });
      return undefined;
    }
    setAuth?.(authCtx);
    if (!this.daemonOwnerId) {
      this.daemonOwnerId = authCtx.user.id;
    }
    this.onClaimDaemon?.(authCtx.user.id);
    emit({
      type: "cyborg:auth_response",
      payload: {
        requestId,
        user: authCtx.user,
        workspaces: authCtx.workspaces,
        daemonId: this.serverId,
      },
    });
    return undefined;
  }

  // oxlint-disable-next-line eslint/complexity -- dispatch table, each case is a single call
  private route(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): Promise<void> | undefined {
    switch (msg.type) {
      case "cyborg:channel_message":
        return this.handleChannelMessage(msg, auth);
      case "cyborg:slash_command":
        return this.handleSlashCommand(msg, auth, emit);
      case "cyborg:dm":
        return this.handleDm(msg, auth);
      case "cyborg:typing":
        return this.handleTyping(msg, auth);
      case "cyborg:reaction":
        return this.handleReaction(msg, auth);
      case "cyborg:fetch_messages":
        return this.handleFetchMessages(msg, auth, emit);
      case "cyborg:fetch_thread":
        return this.handleFetchThread(msg, auth, emit);
      case "cyborg:search":
        return this.handleSearch(msg, auth, emit);
      case "cyborg:pin_message":
        return this.handlePinMessage(msg, auth, emit);
      case "cyborg:save_message":
        return this.handleSaveMessage(msg, auth, emit);
      case "cyborg:list_saved":
        return this.handleListSaved(msg, auth, emit);
      case "cyborg:message_action":
        return this.handleMessageAction(msg, auth, emit);
      case "cyborg:start_terminal":
        return this.handleStartTerminal(msg, auth, emit);
      case "cyborg:terminal_input": {
        this.handleTerminalInput(msg, auth);
        return undefined;
      }
      case "cyborg:terminal_resize": {
        this.handleTerminalResize(msg, auth);
        return undefined;
      }
      case "cyborg:kill_terminal": {
        this.handleKillTerminal(msg, auth);
        return undefined;
      }
      case "cyborg:subscribe_terminal": {
        this.handleSubscribeTerminal(msg, auth, emit);
        return undefined;
      }
      case "cyborg:unsubscribe_terminal": {
        this.handleUnsubscribeTerminal(msg, auth);
        return undefined;
      }
      case "cyborg:forget_terminal": {
        this.handleForgetTerminal(msg, auth, emit);
        return undefined;
      }
      case "cyborg:list_terminals": {
        this.handleListTerminals(msg, auth, emit);
        return undefined;
      }
      case "cyborg:edit_message":
        return this.handleEditMessage(msg, auth, emit);
      case "cyborg:delete_message":
        return this.handleDeleteMessage(msg, auth, emit);
      case "cyborg:mark_read":
        return this.handleMarkRead(msg, auth, emit);
      case "cyborg:mark_channel_unread":
        return this.handleMarkChannelUnread(msg, auth, emit);
      case "cyborg:fetch_unread":
        return this.handleFetchUnread(msg, auth, emit);
      case "cyborg:fetch_activity":
        return this.handleFetchActivity(msg, auth, emit);
      case "cyborg:mark_activity_read":
        return this.handleMarkActivityRead(msg, auth, emit);
      case "cyborg:set_notification_pref":
        return this.handleSetNotificationPref(msg, auth, emit);
      case "cyborg:fetch_notification_prefs":
        return this.handleFetchNotificationPrefs(msg, auth, emit);
      case "cyborg:draft_set":
        return this.handleDraftSet(msg, auth, emit);
      case "cyborg:draft_clear":
        return this.handleDraftClear(msg, auth, emit);
      case "cyborg:fetch_drafts":
        return this.handleFetchDrafts(msg, auth, emit);
      case "cyborg:sync":
        return this.handleSync(msg, auth, emit);
      case "cyborg:create_channel":
        return this.handleCreateChannel(msg, auth, emit);
      case "cyborg:create_group_dm":
        return this.handleCreateGroupDm(msg, auth, emit);
      case "cyborg:fetch_channels":
        return this.handleFetchChannels(msg, auth, emit);
      case "cyborg:create_workspace":
        return this.handleCreateWorkspace(msg, auth, emit);
      case "cyborg:update_workspace":
        return this.handleUpdateWorkspace(msg, auth, emit);
      case "cyborg:delete_workspace":
        return this.handleDeleteWorkspace(msg, auth, emit);
      case "cyborg:fetch_workspaces":
        return this.handleFetchWorkspaces(msg, auth, emit);
      case "cyborg:invite_member":
        return this.handleInviteMember(msg, auth, emit);
      case "cyborg:remove_member":
        return this.handleRemoveMember(msg, auth, emit);
      case "cyborg:update_role":
        return this.handleUpdateRole(msg, auth, emit);
      case "cyborg:create_task":
        return this.handleCreateTask(msg, auth, emit);
      case "cyborg:update_task":
        return this.handleUpdateTask(msg, auth, emit);
      case "cyborg:fetch_tasks":
        return this.handleFetchTasks(msg, auth, emit);
      case "cyborg:fetch_tasks_projects":
        return this.handleFetchTasksProjects(msg, auth, emit);
      case "cyborg:reorder_task":
        return this.handleReorderTask(msg, auth, emit);
      case "cyborg:bulk_update_tasks":
        return this.handleBulkUpdateTasks(msg, auth, emit);
      case "cyborg:delete_task":
        return this.handleDeleteTask(msg, auth, emit);
      case "cyborg:archive_task":
        return this.handleArchiveTask(msg, auth, emit);
      case "cyborg:fetch_project_states":
        return this.handleFetchProjectStates(msg, auth, emit);
      case "cyborg:fetch_project_labels":
        return this.handleFetchProjectLabels(msg, auth, emit);
      case "cyborg:fetch_cycles":
        return this.handleFetchCycles(msg, auth, emit);
      case "cyborg:fetch_modules":
        return this.handleFetchModules(msg, auth, emit);
      case "cyborg:create_cycle":
        return this.handleCreateCycle(msg, auth, emit);
      case "cyborg:update_cycle":
        return this.handleUpdateCycle(msg, auth, emit);
      case "cyborg:delete_cycle":
        return this.handleDeleteCycle(msg, auth, emit);
      case "cyborg:fetch_pages":
        return this.handleFetchPages(msg, auth, emit);
      case "cyborg:fetch_page":
        return this.handleFetchPage(msg, auth, emit);
      case "cyborg:create_page":
        return this.handleCreatePage(msg, auth, emit);
      case "cyborg:update_page":
        return this.handleUpdatePage(msg, auth, emit);
      case "cyborg:set_page_archived":
        return this.handleSetPageArchived(msg, auth, emit);
      case "cyborg:delete_page":
        return this.handleDeletePage(msg, auth, emit);
      case "cyborg:create_module":
        return this.handleCreateModule(msg, auth, emit);
      case "cyborg:update_module":
        return this.handleUpdateModule(msg, auth, emit);
      case "cyborg:delete_module":
        return this.handleDeleteModule(msg, auth, emit);
      case "cyborg:fetch_task_activity":
        return this.handleFetchTaskActivity(msg, auth, emit);
      case "cyborg:add_task_link":
        return this.handleAddTaskLink(msg, auth, emit);
      case "cyborg:remove_task_link":
        return this.handleRemoveTaskLink(msg, auth, emit);
      case "cyborg:fetch_task_links":
        return this.handleFetchTaskLinks(msg, auth, emit);
      case "cyborg:add_task_attachment":
        return this.handleAddTaskAttachment(msg, auth, emit);
      case "cyborg:remove_task_attachment":
        return this.handleRemoveTaskAttachment(msg, auth, emit);
      case "cyborg:fetch_task_attachments":
        return this.handleFetchTaskAttachments(msg, auth, emit);
      case "cyborg:create_agent":
        return this.handleCreateAgent(msg, auth, emit);
      case "cyborg:list_agents":
        return this.handleListAgents(msg, auth, emit);
      case "cyborg:list_daemon_sessions":
        return this.handleListDaemonSessions(msg, auth, emit);
      case "cyborg:send_agent_prompt":
        return this.handleSendAgentPrompt(msg, auth, emit);
      case "cyborg:list_providers":
        return this.handleListProviders(msg, emit);
      case "cyborg:list_members":
        return this.handleListMembers(msg, auth, emit);
      case "cyborg:agent_permission_response":
        return this.handleAgentPermissionResponse(msg, auth, emit);
      case "cyborg:cancel_agent":
        return this.handleCancelAgent(msg, auth, emit);
      case "cyborg:clear_attention":
        return this.handleClearAttention(msg, auth, emit);
      case "cyborg:set_agent_model":
        return this.handleSetAgentModel(msg, auth, emit);
      case "cyborg:reload_session":
        return this.handleReloadSession(msg, auth, emit);
      case "cyborg:set_agent_mode":
        return this.handleSetAgentMode(msg, auth, emit);
      case "cyborg:set_agent_thinking":
        return this.handleSetAgentThinking(msg, auth, emit);
      case "cyborg:rewind_agent":
        return this.handleRewindAgent(msg, auth, emit);
      case "cyborg:list_commands":
        return this.handleListCommands(msg, auth, emit);
      case "cyborg:directory_suggestions":
        return this.handleDirectorySuggestions(msg, auth, emit);
      case "cyborg:list_daemons":
        return this.handleListDaemons(msg, auth, emit);
      case "cyborg:set_workspace_slash_config":
        return this.handleSetWorkspaceSlashConfig(msg, auth, emit);
      case "cyborg:get_workspace_slash_config":
        return this.handleGetWorkspaceSlashConfig(msg, auth, emit);
      case "cyborg:create_cybo":
        return this.handleCreateCybo(msg, auth, emit);
      case "cyborg:set_cybo_credential":
        return this.handleSetCyboCredential(msg, auth, emit);
      case "cyborg:remove_cybo_credential":
        return this.handleRemoveCyboCredential(msg, auth, emit);
      case "cyborg:list_provider_auth":
        return this.handleListProviderAuth(msg, auth, emit);
      case "cyborg:fetch_cybos":
        return this.handleFetchCybos(msg, auth, emit);
      case "cyborg:fetch_cybo":
        return this.handleFetchCybo(msg, auth, emit);
      case "cyborg:import_cybo":
        return this.handleImportCybo(msg, auth, emit);
      case "cyborg:cybo_cli_status":
        return this.handleCyboCliStatus(msg, auth, emit);
      case "cyborg:cybo_cli_update":
        return this.handleCyboCliUpdate(msg, auth, emit);
      case "cyborg:cybo_cli_latest":
        return this.handleCyboCliLatest(msg, auth, emit);
      case "cyborg:update_daemon":
        return this.handleUpdateDaemon(msg, auth, emit);
      case "cyborg:daemon_update_latest":
        return this.handleDaemonUpdateLatest(msg, auth, emit);
      case "cyborg:refresh_providers":
        return this.handleRefreshProviders(msg, auth, emit);
      case "cyborg:update_cybo":
        return this.handleUpdateCybo(msg, auth, emit);
      case "cyborg:delete_cybo":
        return this.handleDeleteCybo(msg, auth, emit);
      case "cyborg:spawn_cybo":
        return this.handleSpawnCybo(msg, auth, emit);
      case "cyborg:create_schedule":
        return this.handleCreateSchedule(msg, auth, emit);
      case "cyborg:list_schedules":
        return this.handleListSchedules(msg, auth, emit);
      case "cyborg:update_schedule":
        return this.handleUpdateSchedule(msg, auth, emit);
      case "cyborg:set_schedule_enabled":
        return this.handleSetScheduleEnabled(msg, auth, emit);
      case "cyborg:delete_schedule":
        return this.handleDeleteSchedule(msg, auth, emit);
      case "cyborg:run_schedule_once":
        return this.handleRunScheduleOnce(msg, auth, emit);
      case "cyborg:list_schedule_runs":
        return this.handleListScheduleRuns(msg, auth, emit);
      case "cyborg:schedule_message_create":
        return this.handleScheduleMessageCreate(msg, auth, emit);
      case "cyborg:schedule_message_list":
        return this.handleScheduleMessageList(msg, auth, emit);
      case "cyborg:schedule_message_cancel":
        return this.handleScheduleMessageCancel(msg, auth, emit);
      case "cyborg:create_outgoing_webhook":
        return this.handleCreateOutgoingWebhook(msg, auth, emit);
      case "cyborg:update_outgoing_webhook":
        return this.handleUpdateOutgoingWebhook(msg, auth, emit);
      case "cyborg:delete_outgoing_webhook":
        return this.handleDeleteOutgoingWebhook(msg, auth, emit);
      case "cyborg:fetch_outgoing_webhooks":
        return this.handleFetchOutgoingWebhooks(msg, auth, emit);
      case "cyborg:create_prompt_template":
        return this.handleCreatePromptTemplate(msg, auth, emit);
      case "cyborg:update_prompt_template":
        return this.handleUpdatePromptTemplate(msg, auth, emit);
      case "cyborg:delete_prompt_template":
        return this.handleDeletePromptTemplate(msg, auth, emit);
      case "cyborg:list_prompt_templates":
        return this.handleListPromptTemplates(msg, auth, emit);
      case "cyborg:invoke_cybo_mention":
        return this.handleInvokeCyboMention(msg, auth, emit);
      case "cyborg:invoke_channel_watch":
        return this.handleInvokeChannelWatch(msg, auth);
      case "cyborg:fetch_agent_state":
        return this.handleFetchAgentState(msg, auth, emit);
      case "cyborg:fetch_agent_timeline":
        return this.handleFetchAgentTimeline(msg, auth, emit);
      case "cyborg:fetch_session_context":
        return this.handleFetchSessionContext(msg, auth, emit);
      case "cyborg:get_pairing_info":
        return this.handleGetPairingInfo(msg, emit);
      case "cyborg:list_recent_cwds":
        return this.handleListRecentCwds(msg, emit);
      case "cyborg:archive_agent":
        return this.handleArchiveAgent(msg, auth, emit);
      case "cyborg:list_archived_sessions":
        return this.handleListArchivedSessions(msg, auth, emit);
      case "cyborg:restore_session":
        return this.handleRestoreSession(msg, auth, emit);
      case "cyborg:import_session":
        return this.handleImportSession(msg, auth, emit);
      case "cyborg:create_project":
        return this.handleCreateProject(msg, auth, emit);
      case "cyborg:fetch_projects":
        return this.handleFetchProjects(msg, auth, emit);
      case "cyborg:update_project":
        return this.handleUpdateProject(msg, auth, emit);
      case "cyborg:delete_project":
        return this.handleDeleteProject(msg, auth, emit);
      case "cyborg:set_channel_project":
        return this.handleSetChannelProject(msg, auth, emit);
      case "cyborg:set_channel_auto_tasks":
        return this.handleSetChannelAutoTasks(msg, auth, emit);
      case "cyborg:fetch_daemon_info":
        return this.handleFetchDaemonInfo(msg, emit);
      case "cyborg:grant_daemon_access":
        return this.handleGrantDaemonAccess(msg, auth, emit);
      case "cyborg:set_daemon_access":
        return this.handleSetDaemonAccess(msg, auth, emit);
      case "cyborg:revoke_daemon_access":
        return this.handleRevokeDaemonAccess(msg, auth, emit);
      case "cyborg:fetch_daemon_access":
        return this.handleFetchDaemonAccess(msg, auth, emit);
      case "cyborg:request_daemon_access":
        return this.handleRequestDaemonAccess(msg, auth, emit);
      case "cyborg:resolve_daemon_access_request":
        return this.handleResolveDaemonAccessRequest(msg, auth, emit);
      case "cyborg:fetch_daemon_access_requests":
        return this.handleFetchDaemonAccessRequests(msg, auth, emit);
      case "cyborg:rename_daemon":
        return this.handleRenameDaemon(msg, auth, emit);
      case "cyborg:workspace_stats":
        return this.handleWorkspaceStats(msg, auth, emit);
      case "cyborg:set_terminal_alias":
        return this.handleSetTerminalAlias(msg, auth, emit);
      case "cyborg:get_terminal_aliases":
        return this.handleGetTerminalAliases(msg, auth, emit);
      default:
        return undefined;
    }
  }

  // Home "This week" aggregate. In cloud mode the relay answers this RPC; a
  // local CONNECTED daemon (its own UI, DATABASE_URL set) must answer it too, or
  // the Home panels hang on a never-resolved request. Solo daemons have no PG —
  // they return an empty aggregate so the panels show their "collecting data"
  // empty states instead of timing out.
  private async handleWorkspaceStats(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgWorkspaceStatsSchema.parse(msg);
    const workspaceId = parsed.workspaceId;
    const requestId = parsed.requestId;
    let stats = {
      sessionsThisWeek: 0,
      tokensThisWeek: 0,
      agentHoursThisWeek: 0,
      tasksShippedThisWeek: 0,
      dailyActivity: [] as { day: string; count: number }[],
      topAgents: [] as {
        provider: string | null;
        cyboId: string | null;
        sessions: number;
        tokens: number;
      }[],
    };
    if (workspaceId && this.storage.pg) {
      try {
        stats = await this.storage.pg.getWorkspaceHomeStats(workspaceId, parsed.range);
      } catch (err) {
        this.logger?.warn({ err, workspaceId }, "getWorkspaceHomeStats failed — returning empty");
      }
    }
    emit({
      type: "cyborg:workspace_stats_response",
      payload: { requestId, ...stats },
    });
  }

  // ─── Terminal aliases (per-user, display-only, cross-device synced) ──
  // Local-daemon mirror of the relay's set/get handlers. PG-backed (per-user via
  // auth.user.id, never shared). A solo daemon has no PG — set is a no-op ack and
  // get returns {} so the UI keeps its localStorage fallback. On a connected
  // daemon, after the write we fan the change out to the user's other clients
  // (owner-scoped, like terminals_changed) so a rename shows live everywhere.
  private async handleSetTerminalAlias(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetTerminalAliasRequestSchema.parse(msg);
    const pg = this.storage.pg;
    const alias = parsed.alias.trim();
    if (pg) {
      if (alias) {
        await pg.setTerminalAlias(auth.user.id, parsed.terminalId, alias);
      } else {
        await pg.deleteTerminalAlias(auth.user.id, parsed.terminalId);
      }
    }
    emit({
      type: "cyborg:set_terminal_alias_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
    if (pg && parsed.workspaceId) {
      this.messageRouter.broadcastTerminalAliasChanged({
        ownerUserId: auth.user.id,
        terminalId: parsed.terminalId,
        alias,
      });
    }
  }

  private async handleGetTerminalAliases(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgGetTerminalAliasesRequestSchema.parse(msg);
    const pg = this.storage.pg;
    const aliases = pg ? await pg.getTerminalAliases(auth.user.id) : {};
    emit({
      type: "cyborg:get_terminal_aliases_response",
      payload: { requestId: parsed.requestId, aliases },
    });
  }

  private handleTyping(msg: CyborgMsg, auth: CyborgAuthContext): undefined {
    const parsed = CyborgTypingSchema.parse(msg);
    this.messageRouter.handleTyping(auth, parsed.workspaceId, parsed.channelId);
    return undefined;
  }

  private handleReaction(msg: CyborgMsg, auth: CyborgAuthContext): undefined {
    const parsed = CyborgReactionSchema.parse(msg);
    this.messageRouter.handleReaction(auth, parsed.workspaceId, parsed.messageId, parsed.emoji);
    return undefined;
  }

  private async handleChannelMessage(msg: CyborgMsg, auth: CyborgAuthContext): Promise<void> {
    const parsed = CyborgChannelMessageSchema.parse(msg);
    const rl = this.rateLimiter.check(`${auth.user.id}:${parsed.workspaceId}`, "message");
    if (!rl.allowed) return;
    this.messageRouter.handleChannelMessage(auth, parsed);
  }

  private async handleDm(msg: CyborgMsg, auth: CyborgAuthContext): Promise<void> {
    const parsed = CyborgDmSchema.parse(msg);
    const rl = this.rateLimiter.check(`${auth.user.id}:${parsed.workspaceId}`, "message");
    if (!rl.allowed) return;
    this.messageRouter.handleDm(auth, parsed);
  }

  // Slash command from a group channel. The slash layer is thin (see
  // internal docs Part 3): it validates + routes by command `kind` to a service.
  // /summarize runs the token-gated map-reduce summarization service and posts
  // the result as a persistent channel message.
  // oxlint-disable-next-line eslint/complexity -- linear guard chain, each branch acks + returns
  private async handleSlashCommand(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSlashCommandRequestSchema.parse(msg);
    const ack = (ok: boolean, dispatched: string[], error?: string, warnings?: string[]): void => {
      emit({
        type: "cyborg:slash_command_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          trigger: parsed.trigger,
          dispatched,
          error,
          // Ephemeral arg warnings (clamped/ignored input) — requester-only,
          // never persisted; old clients simply ignore the extra field.
          ...(warnings && warnings.length > 0 ? { warnings } : {}),
        },
      });
    };

    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) {
      this.logger?.error(
        `[slash_command] permission denied: user ${auth.user.id} lacks send_message in workspace ${parsed.workspaceId} (trigger=/${parsed.trigger})`,
      );
      ack(
        false,
        [],
        "You don't have permission to run slash commands in this workspace (it requires send_message access).",
      );
      return;
    }

    // Resolve the channel. CLOUD path: the relay (which has PG) embeds the
    // resolved channel in the forwarded payload — a SOLO daemon has no PG and
    // can't see cloud-only group channels, which is exactly why every cloud
    // slash command used to ack "channel not found" (the 10-release bug). When
    // the relay provided it, trust it and skip the lookup. SOLO/no-relay path:
    // fall back to local SQLite, then this daemon's own PG if it has one.
    let channel: { id: string; workspace_id: string; name: string } | null =
      parsed.resolvedChannel ?? null;
    if (!channel) {
      channel = this.storage.getChannel(parsed.channelId) ?? null;
      if (!channel && this.storage.pg) {
        // Guard the awaited PG read: an outage must ack an error, not bubble.
        try {
          channel = await this.storage.pg.getChannel(parsed.channelId);
        } catch (err) {
          this.logger?.error(
            { err },
            `[slash_command] channel lookup failed for ${parsed.channelId}`,
          );
          ack(
            false,
            [],
            `Couldn't look up channel ${parsed.channelId} (storage error). Try again in a moment.`,
          );
          return;
        }
      }
    }
    if (!channel || channel.workspace_id !== parsed.workspaceId) {
      this.logger?.error(
        `[slash_command] channel ${parsed.channelId} not resolvable in workspace ${parsed.workspaceId} ` +
          `(relayProvided=${!!parsed.resolvedChannel}, daemonHasPg=${!!this.storage.pg}, trigger=/${parsed.trigger})`,
      );
      ack(
        false,
        [],
        `Channel not found: ${parsed.channelId} is not in this workspace. Reopen the channel and try again.`,
      );
      return;
    }

    // Private-channel membership gate (#242). The cloud relay validates membership
    // before it enriches + forwards (and sets resolvedChannel), so when it did the
    // resolution we trust it. On the non-relay path (a PG-connected daemon that
    // resolved the channel itself) re-check: a private channel requires the caller
    // be a channel member, or the slash command would read/act in a private channel
    // they can't see. (A PG-less solo daemon has no private-channel membership model.)
    if (!parsed.resolvedChannel && this.storage.pg) {
      const isPrivate = !!(channel as { is_private?: number | boolean }).is_private;
      if (isPrivate) {
        // Guard the awaited PG read (same as the getChannel lookup above): an
        // outage must ack an error, not bubble as an unhandled rejection.
        let memberRole: string | null = null;
        try {
          memberRole = await this.storage.pg.getChannelMemberRole(parsed.channelId, auth.user.id);
        } catch (err) {
          this.logger?.error(
            { err },
            `[slash_command] membership lookup failed for ${parsed.channelId}`,
          );
          ack(false, [], "Couldn't verify channel membership (storage error). Try again shortly.");
          return;
        }
        if (!memberRole) {
          this.logger?.error(
            `[slash_command] caller ${auth.user.id} is not a member of private channel ${parsed.channelId} (trigger=/${parsed.trigger})`,
          );
          ack(false, [], "You're not a member of this private channel.");
          return;
        }
      }
    }

    const command = getSlashCommand(parsed.trigger);
    if (!command) {
      // CLI/API callers bypass the composer's client-side guard — give them an
      // explicit ack error with a "did you mean" suggestion, never a silent drop.
      ack(false, [], unknownSlashTriggerError(parsed.trigger));
      return;
    }

    if (!this.agentManager) {
      this.logger?.error(
        `[slash_command] /${parsed.trigger} rejected: this daemon has no AgentManager configured (cannot run AI commands)`,
      );
      ack(
        false,
        [],
        "This daemon can't run AI commands right now (no agent manager). Restart your daemon and try again.",
      );
      return;
    }

    const rl = this.rateLimiter.check(parsed.workspaceId, "agent_spawn");
    if (!rl.allowed) {
      this.logger?.warn(
        `[slash_command] /${parsed.trigger} rate-limited for workspace ${parsed.workspaceId}`,
      );
      ack(
        false,
        [],
        `Too many agent runs right now — wait a few seconds and try /${parsed.trigger} again.`,
      );
      return;
    }

    // /ask @cybo <question> invokes a SPECIFIC cybo (not a history service): it
    // spawns the named cybo into this channel and routes the question to it.
    if (command.kind === "ask") {
      await this.handleAskCybo({
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        channelName: channel.name,
        trigger: parsed.trigger,
        rawArgs: parsed.args ?? "",
        requestId: parsed.requestId,
        userId: auth.user.id,
        emit,
      });
      return;
    }

    // /catchup digests what the caller missed since their last_read_at — the
    // result is EPHEMERAL to the caller (no echo, no channel post), so it bypasses
    // the postUserCommandEcho + runChannelAiCommand path that every other command
    // shares. Permission/membership/rate-limit gates above already passed.
    if (command.kind === "catchup") {
      await this.handleCatchup({
        parsed,
        channel,
        userId: auth.user.id,
        userName: auth.user.name ?? auth.user.email ?? "you",
        maxMessages: command.maxContextMessages,
        emit,
        ack,
      });
      return;
    }

    const countArg = parseCountArgDetailed(
      parsed.args ?? "",
      command.contextMessages,
      command.maxContextMessages,
    );
    const count = countArg.count;
    // /translate consumes its args as the target language, so its trailing text
    // is NOT "ignored" — suppress only that warning; a clamped count
    // ("/translate 9999") is still reported.
    const warnArg =
      command.kind === "translate" ? { ...countArg, ignoredText: undefined } : countArg;
    const argWarnings = describeCountArgWarnings(warnArg, parsed.trigger);
    try {
      // Prefer the shared PostgreSQL history. This command is forwarded to a
      // daemon whose local SQLite cache may be empty or stale (it may not have
      // witnessed the conversation), so reading SQLite alone could summarize an
      // empty transcript even though the channel has messages in PG. PG returns
      // the most-recent N oldest-first; SQLite returns newest-first, so reverse
      // it. A PG-less (solo) daemon falls back to its local store, which is
      // authoritative in that single-machine deployment. Inside the try so a PG
      // outage acks an error instead of bubbling an unhandled rejection.
      const pg = this.storage.pg;
      let recentMessages: ReturnType<typeof this.storage.getMessages> = [];
      if (command.contextMessages > 0) {
        if (parsed.resolvedMessages) {
          // CLOUD: the relay embedded the transcript (oldest-first) from PG, so a
          // SOLO daemon doesn't summarize its empty local SQLite. Take the most-
          // recent `count` (the relay sends a generous slice; we trim to the
          // command's requested size).
          const provided = parsed.resolvedMessages as unknown as ReturnType<
            typeof this.storage.getMessages
          >;
          recentMessages = provided.slice(-count);
        } else if (pg) {
          // SOLO-with-PG / no relay enrichment: read shared PG (oldest-first).
          recentMessages = await pg.getMessages({ channelId: parsed.channelId, limit: count });
        } else {
          // SOLO/no-PG single-machine deployment: local SQLite is authoritative
          // (newest-first, so reverse to oldest-first).
          recentMessages = this.storage
            .getMessages({ channelId: parsed.channelId, limit: count })
            .toReversed();
        }
      }

      const transcript = formatTranscript(recentMessages);
      // Nothing to act on → tell the requester, don't post channel noise.
      if (transcript.trim().length === 0) {
        let transcriptSource = "sqlite";
        if (parsed.resolvedMessages) transcriptSource = "relay";
        else if (pg) transcriptSource = "pg";
        this.logger?.warn(
          `[slash_command] /${parsed.trigger}: empty transcript for channel ${channel.name} (${parsed.channelId}, source=${transcriptSource})`,
        );
        ack(false, [], `No recent messages in #${channel.name} to run /${parsed.trigger} on.`);
        return;
      }
      // Resolve the model preference. PRECEDENCE: channel override > user default
      // > auto-resolve. The channel override (channels.slash_command_model) wins so
      // MODEL precedence (#opt-A): channel override > WORKSPACE default > auto.
      // The per-user preference is deprecated; the workspace config is the default.
      // A daemon WITH PG reads both rows itself; a PG-blind (cloud) daemon relies on
      // the relay-forwarded values (resolvedChannel.slash_command_model + the
      // workspaceSlashModel payload). See resolveSlashModelSelection.
      let pgChannelModel: string | null | undefined;
      let pgWorkspaceModel: { provider: string; model: string } | null | undefined;
      try {
        if (this.storage.pg) {
          pgChannelModel = (await this.storage.pg.getChannel(parsed.channelId))
            ?.slash_command_model;
          pgWorkspaceModel = (await this.storage.pg.getWorkspaceSlashConfig(parsed.workspaceId))
            .model;
        }
      } catch (err) {
        this.logger?.error(
          { err },
          "[slash_command] model-preference lookup failed (auto-resolving)",
        );
      }
      const { selection: slashSelection, source: selectionSource } = resolveSlashModelSelection({
        hasPg: !!this.storage.pg,
        pgChannelModel,
        pgWorkspaceModel,
        resolvedChannelModel: parsed.resolvedChannel?.slash_command_model,
        localChannelModel: (channel as { slash_command_model?: string | null }).slash_command_model,
        forwardedWorkspaceModel: parsed.workspaceSlashModel ?? null,
      });
      // Log which preference won, so a "didn't honor my model" report is diagnosable.
      console.log(
        `[slash_command] /${parsed.trigger} model: ${
          slashSelection
            ? `${selectionSource}=${slashSelection.provider}/${slashSelection.model}`
            : "auto-resolve"
        }`,
      );

      // One ephemeral internal-agent completer drives whichever AI command this
      // is — summary / action-items / standup / translate share the shape.
      const complete = createAgentSummaryCompleter({
        manager: this.agentManager,
        logger: this.logger,
        cwd: process.env.HOME ?? process.cwd(),
        providerSnapshotManager: this.providerSnapshotManager,
        daemonConfig: this.daemonConfigStore
          ? { metadataGeneration: this.daemonConfigStore.get().metadataGeneration }
          : undefined,
        currentSelection: slashSelection ?? undefined,
        // Bound the contention retry to the SAME budget as the hard timeout (minus a
        // margin) so it gives up — with a clean "busy" message — before the timeout.
        retryBudgetMs: SLASH_AI_COMMAND_TIMEOUT_MS - SLASH_AI_CONTENTION_MARGIN_MS,
      });
      // Attribute the posted result to the REAL responder. The completer records
      // the provider/model it resolved, so build the sender AFTER produce() runs:
      //   provider/model → name "Claude (Haiku)" / "Pi" / "Codex", fromId
      //     "provider:<id>" so the client renders the provider icon;
      //   else the workspace default cybo (id + name → its avatar);
      //   else a generic per-command sender ("Assistant") as a last resort.
      const cybos = this.storage.getCybos(parsed.workspaceId);
      const defaultCybo = cybos.find((c) => c.is_default) ?? cybos[0];
      const resolveSender = (): { id: string; name: string } => {
        const u = complete.used;
        if (u.provider) {
          return { id: `provider:${u.provider}`, name: formatResponder(u.provider, u.model) };
        }
        if (defaultCybo) return { id: defaultCybo.id, name: defaultCybo.name };
        return { id: command.kind, name: "Assistant" };
      };

      // Channel guidelines ("Guidelines for agents acting in this channel").
      // CLOUD: the relay forwards them on resolvedChannel (PG-blind daemon);
      // SOLO: the locally-resolved channel row carries channels.instructions.
      // Flow into the prompt builders as owner-set format/limit guidance.
      const channelInstructions =
        parsed.resolvedChannel?.instructions ??
        (channel as { instructions?: string | null }).instructions ??
        null;

      let produce: () => Promise<string>;
      let label: string;
      switch (command.kind) {
        case "summary":
          label = "/summarize";
          produce = () =>
            summarizeTranscript({
              transcript,
              channelName: channel.name,
              complete,
              channelInstructions,
            });
          break;
        case "action_items":
          label = "/action-items";
          produce = () =>
            extractActionItems({
              transcript,
              channelName: channel.name,
              complete,
              channelInstructions,
            });
          break;
        case "standup":
          label = "/standup";
          produce = () =>
            generateStandup({
              transcript,
              channelName: channel.name,
              complete,
              channelInstructions,
            });
          break;
        case "translate":
          label = "/translate";
          produce = () =>
            translateMessages({
              transcript,
              channelName: channel.name,
              complete,
              targetLang: parsed.args ?? "",
            });
          break;
      }

      // A: echo the user's command into the channel as a visible message BEFORE
      // executing, so everyone sees who ran what (the result posts async later).
      // The echo is a plain human message (fromId = author's user id, fromType
      // "human"), so the client resolves its avatar through the same author→
      // getMemberImage(fromId) path as any other message — no per-message avatar.
      this.messageRouter.postUserCommandEcho({
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        userId: auth.user.id,
        userName: auth.user.name ?? auth.user.email ?? "User",
        text: `/${parsed.trigger}${parsed.args ? ` ${parsed.args}` : ""}`,
      });

      // Ack on DISPATCH, not completion: LLM commands routinely outlive the
      // client's 15s RPC window; the result (or error notice) arrives later as a
      // channel message via runChannelAiCommand.
      ack(true, [], undefined, argWarnings);
      this.runChannelAiCommand({
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        trigger: parsed.trigger,
        requestId: parsed.requestId,
        label,
        resolveSender,
        produce,
      });
      return;
    } catch (err) {
      ack(false, [], err instanceof Error ? err.message : "slash command failed");
    }
  }

  // /catchup: digest what the caller missed since their last_read_at in this
  // channel. Reuses the summarization runner (same ephemeral, token-gated
  // map-reduce as /summarize) with a personal-digest final prompt, but delivers
  // the result EPHEMERALLY to the caller (cyborg:catchup_result, toUserId) and
  // NEVER posts to the channel — a personal digest would pollute the channel it
  // summarizes and re-trigger unread for everyone else.
  private async handleCatchup(args: {
    parsed: CyborgSlashCommand;
    channel: { id: string; workspace_id: string; name: string };
    userId: string;
    userName: string;
    maxMessages: number;
    emit: EmitFn;
    ack: (ok: boolean, dispatched: string[], error?: string, warnings?: string[]) => void;
  }): Promise<void> {
    const { parsed, channel, userId, userName, maxMessages, emit, ack } = args;
    const result = (ok: boolean, text: string, unreadCount: number): void => {
      emit({
        type: "cyborg:catchup_result",
        payload: {
          requestId: parsed.requestId,
          toUserId: userId,
          workspaceId: parsed.workspaceId,
          channelId: channel.id,
          channelName: channel.name,
          ok,
          text,
          unreadCount,
        },
      });
    };

    try {
      const unread = await this.resolveCatchupUnread(parsed, channel.id, userId, maxMessages);
      // Don't count the caller's own messages as "unread for them".
      const others = unread.filter((m) => m.from_id !== userId);
      const transcript = formatTranscript(others);
      if (transcript.trim().length === 0) {
        // Ack the RPC, then deliver the ephemeral "all caught up" — no channel post.
        ack(true, []);
        result(false, `You're all caught up in #${channel.name}. ✨`, 0);
        return;
      }

      const selection = await this.resolveCatchupModel(parsed, channel.id);

      if (!this.agentManager) {
        ack(false, [], "This daemon can't run AI commands right now (no agent manager).");
        return;
      }
      const complete = createAgentSummaryCompleter({
        manager: this.agentManager,
        logger: this.logger,
        cwd: process.env.HOME ?? process.cwd(),
        providerSnapshotManager: this.providerSnapshotManager,
        daemonConfig: this.daemonConfigStore
          ? { metadataGeneration: this.daemonConfigStore.get().metadataGeneration }
          : undefined,
        currentSelection: selection ?? undefined,
        retryBudgetMs: SLASH_AI_COMMAND_TIMEOUT_MS - SLASH_AI_CONTENTION_MARGIN_MS,
      });

      const channelInstructions =
        parsed.resolvedChannel?.instructions ??
        (channel as { instructions?: string | null }).instructions ??
        null;

      // Ack on DISPATCH (the digest outlives the RPC window); the ephemeral
      // result arrives later. A loading state is the client's to show.
      ack(true, []);
      void (async () => {
        const TIMEOUT_MS = SLASH_AI_COMMAND_TIMEOUT_MS;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`/catchup timed out after ${TIMEOUT_MS / 1000}s`)),
            TIMEOUT_MS,
          );
        });
        try {
          const digest = await Promise.race([
            summarizeTranscript({
              transcript,
              channelName: channel.name,
              complete,
              channelInstructions,
              finalSystem: (isChunked) =>
                catchupDigestSystem({
                  channelName: channel.name,
                  callerName: userName,
                  isChunked,
                  channelInstructions,
                }),
            }),
            timeout,
          ]);
          result(true, digest, others.length);
        } catch (err) {
          result(
            false,
            `⚠️ /catchup failed: ${err instanceof Error ? err.message : "unknown error"}`,
            others.length,
          );
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      })();
    } catch (err) {
      ack(false, [], err instanceof Error ? err.message : "/catchup failed");
    }
  }

  // The caller's unread slice for /catchup. CLOUD: the relay (which has PG)
  // resolved last_read + the since-slice and embedded it (a PG-blind daemon can
  // read neither). SOLO: resolve from local PG/SQLite ourselves.
  private async resolveCatchupUnread(
    parsed: CyborgSlashCommand,
    channelId: string,
    userId: string,
    maxMessages: number,
  ): Promise<ReturnType<typeof this.storage.getMessages>> {
    type Slice = ReturnType<typeof this.storage.getMessages>;
    if (parsed.resolvedMessages) {
      return parsed.resolvedMessages as unknown as Slice;
    }
    const pg = this.storage.pg;
    const sinceMs =
      parsed.catchupSince ??
      (pg
        ? await pg.getChannelLastRead(userId, channelId)
        : this.storage.getLastRead(userId, channelId)) ??
      0;
    return pg
      ? ((await pg.getChannelMessagesSince(channelId, sinceMs, maxMessages)) as Slice)
      : this.storage.getChannelMessagesSince(channelId, sinceMs, maxMessages);
  }

  // /catchup model precedence (channel > workspace > auto), same as the summary
  // path; a PG read failure degrades to auto-resolve rather than failing.
  private async resolveCatchupModel(
    parsed: CyborgSlashCommand,
    channelId: string,
  ): Promise<{ provider: string; model: string } | null> {
    let pgChannelModel: string | null | undefined;
    let pgWorkspaceModel: { provider: string; model: string } | null | undefined;
    try {
      if (this.storage.pg) {
        pgChannelModel = (await this.storage.pg.getChannel(channelId))?.slash_command_model;
        pgWorkspaceModel = (await this.storage.pg.getWorkspaceSlashConfig(parsed.workspaceId))
          .model;
      }
    } catch (err) {
      this.logger?.error({ err }, "[catchup] model-preference lookup failed (auto-resolving)");
    }
    return resolveSlashModelSelection({
      hasPg: !!this.storage.pg,
      pgChannelModel,
      pgWorkspaceModel,
      resolvedChannelModel: parsed.resolvedChannel?.slash_command_model,
      localChannelModel: null,
      forwardedWorkspaceModel: parsed.workspaceSlashModel ?? null,
    }).selection;
  }

  // /ask @cybo <question>: resolve the named cybo, spawn it (ephemeral) into the
  // channel, and route the question to it so it answers in-channel. A missing
  // cybo / malformed input responds with an EPHEMERAL systemAlert that lists the
  // available cybos (rendered in the composer, not posted to the channel).
  private async handleAskCybo(args: {
    workspaceId: string;
    channelId: string;
    channelName: string;
    trigger: string;
    rawArgs: string;
    requestId?: string;
    userId: string;
    emit: EmitFn;
  }): Promise<void> {
    const { workspaceId, channelId, channelName, trigger, rawArgs, requestId, userId, emit } = args;
    const respond = (
      ok: boolean,
      dispatched: string[],
      extra?: { error?: string; systemAlert?: string },
    ): void => {
      emit({
        type: "cyborg:slash_command_response",
        payload: {
          requestId,
          ok,
          trigger,
          dispatched,
          error: extra?.error,
          systemAlert: extra?.systemAlert,
        },
      });
    };

    const cybos = this.storage.getCybos(workspaceId);
    const available = cybos.length > 0 ? cybos.map((c) => `@${c.slug}`).join(", ") : "(none)";

    // "@cybo question" — the target is the first token (leading @ optional).
    const match = rawArgs.trim().match(/^@?(\S+)\s*([\s\S]*)$/);
    if (!match) {
      respond(false, [], {
        systemAlert: `Usage: /ask @cybo <question>. Available cybos: ${available}`,
      });
      return;
    }
    const target = match[1].toLowerCase();
    const question = match[2].trim();
    const cybo = cybos.find(
      (c) => c.slug.toLowerCase() === target || c.name.toLowerCase() === target,
    );
    if (!cybo) {
      respond(false, [], {
        systemAlert: `No cybo "@${target}" in this workspace. Available cybos: ${available}`,
      });
      return;
    }
    if (!question) {
      respond(false, [], {
        systemAlert: `Ask @${cybo.slug} what? Usage: /ask @${cybo.slug} <question>`,
      });
      return;
    }
    if (!this.agentManager) {
      respond(false, [], { error: "agent manager not available" });
      return;
    }

    try {
      const result = await spawnCybo({
        storage: this.storage,
        agentManager: this.agentManager,
        workspaceId,
        cyboIdOrSlug: cybo.slug,
        userId,
        serverId: this.serverId ?? undefined,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
        ephemeral: true,
        context: { channelId, channelName },
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger ?? undefined,
      });
      // Deliver the question to the freshly spawned, channel-bound cybo. It
      // answers in this channel; the ephemeral binding tears down after the turn.
      void this.messageRouter
        .routeToAgent(result.agentId, question, { rawPrompt: question })
        .catch((err) => this.logger?.warn({ err }, "[ask] route to cybo failed"));
      respond(true, [result.agentId]);
    } catch (err) {
      if (err instanceof CyboNotFoundError) {
        respond(false, [], {
          systemAlert: `No cybo "@${target}" in this workspace. Available cybos: ${available}`,
        });
        return;
      }
      respond(false, [], { error: err instanceof Error ? err.message : "failed to ask cybo" });
    }
  }

  // Run an AI channel command (summary / action-items / standup / translate)
  // fire-and-forget after the dispatch ack: bound it with a 30s timeout, then
  // post the result — or a failure notice — as a channel message. The ack has
  // already returned to the client, so the result can't reach that RPC anymore.
  private runChannelAiCommand(args: {
    workspaceId: string;
    channelId: string;
    trigger: string;
    requestId?: string;
    label: string;
    // Resolved AFTER produce() runs, so it can reflect the provider/model the
    // completer actually used (not a pre-guessed default).
    resolveSender: () => { id: string; name: string };
    produce: () => Promise<string>;
  }): void {
    const { workspaceId, channelId, trigger, requestId, label, resolveSender, produce } = args;
    void (async () => {
      const TIMEOUT_MS = SLASH_AI_COMMAND_TIMEOUT_MS;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`)),
          TIMEOUT_MS,
        );
      });
      try {
        // F: tell clients inference started, so the channel shows a loading state.
        // Inside try so a throw here still hits finally (clears the timeout).
        this.messageRouter.broadcastSlashProgress({
          workspaceId,
          channelId,
          trigger,
          phase: "generating",
          requestId,
        });
        const text = await Promise.race([produce(), timeout]);
        const sender = resolveSender();
        this.messageRouter.postServiceMessage({
          workspaceId,
          channelId,
          fromId: sender.id,
          fromName: sender.name,
          text,
          daemonId: this.serverId,
        });
        this.messageRouter.broadcastSlashProgress({
          workspaceId,
          channelId,
          trigger,
          phase: "done",
          requestId,
        });
      } catch (err) {
        const sender = resolveSender();
        this.messageRouter.postServiceMessage({
          workspaceId,
          channelId,
          fromId: sender.id,
          fromName: sender.name,
          text: `⚠️ ${label} failed: ${err instanceof Error ? err.message : "unknown error"}`,
          daemonId: this.serverId,
        });
        this.messageRouter.broadcastSlashProgress({
          workspaceId,
          channelId,
          trigger,
          phase: "error",
          requestId,
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    })();
  }

  private async handleFetchMessages(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchMessagesRequestSchema.parse(msg);
    const result = this.messageRouter.handleFetchMessages(auth, parsed);
    emit({
      type: "cyborg:fetch_messages_response",
      payload: {
        requestId: parsed.requestId,
        messages: result.messages.map(formatMessage),
        hasMore: result.hasMore,
      },
    });
  }

  private async handleFetchThread(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchThreadRequestSchema.parse(msg);
    const result = this.messageRouter.handleFetchThread(auth, parsed);
    emit({
      type: "cyborg:fetch_thread_response",
      payload: {
        requestId: parsed.requestId,
        parentId: parsed.parentId,
        messages: result.messages.map(formatMessage),
      },
    });
  }

  private async handleSearch(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): Promise<void> {
    const parsed = CyborgSearchSchema.parse(msg);
    const result = this.messageRouter.handleSearch(auth, parsed);
    emit({
      type: "cyborg:search_response",
      payload: { requestId: parsed.requestId, messages: result.messages.map(formatMessage) },
    });
  }

  private async handlePinMessage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgPinMessageSchema.parse(msg);
    const result = this.messageRouter.handlePinMessage(auth, parsed);
    emit({
      type: "cyborg:pin_message_response",
      payload: {
        requestId: parsed.requestId,
        pinnedAt: result?.pinnedAt ?? null,
        pinnedBy: result?.pinnedBy ?? null,
      },
    });
  }

  // Saved messages (#609) — local-daemon half of the dual-routed handler (the
  // relay has the cloud mirror). A PRIVATE per-user bookmark, persisted straight
  // to PG (no SQLite cache: bookmarks are only meaningful in connected mode, and
  // setPinned-style local mirroring would add a shared-table column this feature
  // deliberately avoids). Toggle on/off via `saved`; echo the resulting state.
  private async handleSaveMessage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSaveMessageSchema.parse(msg);
    const pg = this.storage.pg;
    if (pg) {
      const existing = await pg.getMessageById(parsed.messageId);
      // Anchor to the asserted workspace: you can only bookmark a message that
      // exists in a workspace you're a member of.
      if (existing && existing.workspaceId === parsed.workspaceId) {
        if (parsed.saved) await pg.saveMessage(auth.user.id, parsed.messageId);
        else await pg.unsaveMessage(auth.user.id, parsed.messageId);
      }
    }
    emit({
      type: "cyborg:save_message_response",
      payload: { requestId: parsed.requestId, messageId: parsed.messageId, saved: parsed.saved },
    });
  }

  private async handleListSaved(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListSavedRequestSchema.parse(msg);
    const pg = this.storage.pg;
    const messages = pg ? await pg.getSavedMessages(auth.user.id, parsed.workspaceId) : [];
    emit({
      type: "cyborg:list_saved_response",
      payload: { requestId: parsed.requestId, messages: messages.map(formatMessage) },
    });
  }

  // Signed interactive action (#600) — local-daemon half of the dual-routed
  // handler (the relay has the mirror for cloud). Verify the token (one check
  // covers forgery/tamper/wrong-actor/expiry), cross-check it was issued for THIS
  // message+button, then dispatch to the action-kind registry; broadcast the
  // resolved card so every client re-renders the settled state.
  private async handleMessageAction(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgMessageActionSchema.parse(msg);
    const fail = (error: string): void => {
      emit({
        type: "cyborg:message_action_response",
        payload: { requestId: parsed.requestId, ok: false, error },
      });
    };
    const now = Math.floor(Date.now() / 1000);
    const payload = verifyAction(parsed.token, { now, expectActor: auth.user.id });
    // Token-pasted-on-wrong-button defense: the signed mid/aid must match the
    // button the client claims to have clicked.
    if (!payload || payload.mid !== parsed.messageId || payload.aid !== parsed.actionId) {
      fail("invalid_or_expired");
      return;
    }
    const handler = getActionHandler(payload.k);
    if (!handler) {
      fail("unknown_action_kind");
      return;
    }
    const outcome = await handler(payload, {
      actorId: auth.user.id,
      workspaceId: parsed.workspaceId,
      messageId: parsed.messageId,
      deps: { messageRouter: this.messageRouter, storage: this.storage },
    });
    emit({
      type: "cyborg:message_action_response",
      payload: { requestId: parsed.requestId, ok: outcome.ok, error: outcome.error },
    });
    if (outcome.ok && outcome.card) {
      this.messageRouter.broadcastMessageCardUpdated(
        parsed.workspaceId,
        parsed.messageId,
        outcome.card,
      );
    }
  }

  // ─── Terminal sessions (#654) ──────────────────────────────────────────────
  // The relay already gated daemon access (spawn gate #31) before forwarding;
  // these handlers run on the OWNING daemon and delegate to the inherited
  // terminal engine. The owner-lock inside the controller is the second gate.

  private async handleStartTerminal(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgStartTerminalRequestSchema.parse(msg);
    if (!this.terminalController) {
      emit({
        type: "cyborg:start_terminal_response",
        payload: {
          requestId: parsed.requestId,
          ok: false,
          error: "terminals unavailable on this daemon",
        },
      });
      return;
    }
    const result = await this.terminalController.start(
      {
        cwd: parsed.cwd,
        cols: parsed.cols,
        rows: parsed.rows,
        ownerUserId: auth.user.id,
        // Stamp the opener's STABLE human identity (#874): ownerUserId is an opaque
        // per-store UUID that diverges across layers, so the email is what lets a
        // later re-subscribe under a different id be recognised as the same owner.
        ownerEmail: auth.user.email,
        // Carried into the persisted sidecar (#750) so post-restart history knows
        // which workspace/daemon the session belonged to.
        workspaceId: parsed.workspaceId,
        daemonId: parsed.daemonId ?? null,
        // Stable per-mount subscriber id (internal docs GAP-1) so the matching
        // detach on unmount can drop exactly this view's attacher.
        attachId: parsed.attachId,
      },
      emit,
    );
    emit({
      type: "cyborg:start_terminal_response",
      payload: {
        requestId: parsed.requestId,
        ok: result.ok,
        ...(result.terminalId ? { terminalId: result.terminalId } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }

  // List the caller's tracked terminals for a workspace (the directory feed's pull
  // half). Owner-scoped by the controller; the response correlates by requestId.
  private handleListTerminals(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): void {
    const parsed = CyborgListTerminalsRequestSchema.parse(msg);
    const terminals = this.terminalController
      ? this.terminalController.listForWorkspace({
          workspaceId: parsed.workspaceId,
          ownerUserId: auth.user.id,
          // Email-first owner match (Bug A): a pty that survived a daemon restart is
          // rehydrated under the sidecar's id, which diverges from this PG/relay id —
          // so a pure id filter hid it from its own owner. The caller's email re-admits
          // the real owner so list_terminals surfaces the live survivor.
          ownerEmail: auth.user.email,
        })
      : [];
    emit({
      type: "cyborg:list_terminals_response",
      payload: {
        requestId: parsed.requestId,
        workspaceId: parsed.workspaceId,
        terminals,
      },
    });
  }

  // Push the workspace terminal directory snapshot to its owner (the feed's push
  // half — fired by the controller's onDirectoryChanged on every start/exit).
  private broadcastTerminalDirectory(workspaceId: string, ownerUserId: string): void {
    if (!this.terminalController) return;
    const terminals = this.terminalController.listForWorkspace({ workspaceId, ownerUserId });
    this.messageRouter.broadcastTerminalsChanged({ workspaceId, ownerUserId, terminals });
  }

  private handleTerminalInput(msg: CyborgMsg, auth: CyborgAuthContext): void {
    const parsed = CyborgTerminalInputSchema.parse(msg);
    this.terminalController?.input(parsed.terminalId, parsed.data, auth.user.id, auth.user.email);
  }

  private handleTerminalResize(msg: CyborgMsg, auth: CyborgAuthContext): void {
    const parsed = CyborgTerminalResizeSchema.parse(msg);
    this.terminalController?.resize(
      parsed.terminalId,
      parsed.cols,
      parsed.rows,
      auth.user.id,
      auth.user.email,
    );
  }

  private handleKillTerminal(msg: CyborgMsg, auth: CyborgAuthContext): void {
    const parsed = CyborgKillTerminalSchema.parse(msg);
    this.terminalController?.kill(parsed.terminalId, auth.user.id, auth.user.email);
  }

  // Watch an existing session (internal docs): register a viewer (which owns its
  // own Paseo subscription) and let Paseo's FRESH per-subscribe snapshot heal the
  // screen (the cyborg:terminal_snapshot frame — no ack on the critical path). The
  // controller owner-locks; a dead session replays history (live:false). On a LIVE
  // subscribe there is no *_response — the client waits for the snapshot frame, so
  // we emit nothing here on success. We DO ack a not-found/unavailable dead session
  // via the shared attach_terminal_response shape so the dead-session handling
  // (#718) still fires.
  private handleSubscribeTerminal(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): void {
    const parsed = CyborgSubscribeTerminalSchema.parse(msg);
    const result = this.terminalController
      ? this.terminalController.subscribe(
          parsed.terminalId,
          auth.user.id,
          emit,
          parsed.attachId,
          // Email-keyed owner-lock (#874): the re-attach arrives under a possibly
          // divergent ownerUserId, so pass the stable email to match the real owner.
          auth.user.email,
        )
      : { ok: false, error: "terminals unavailable on this daemon" };
    // A LIVE subscribe self-heals via the snapshot frame — no ack. Only a dead /
    // unavailable session needs the response so the client can clean the stale
    // sidebar pointer (#718) or render history (live:false, #750).
    if (result.ok && result.live === true) return;
    emit({
      type: "cyborg:attach_terminal_response",
      payload: {
        requestId: parsed.requestId,
        ok: result.ok,
        ...(result.terminalId ? { terminalId: result.terminalId } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.live !== undefined ? { live: result.live } : {}),
        ...(result.endedReason ? { endedReason: result.endedReason } : {}),
      },
    });
  }

  // Stop watching a session without killing it (internal docs): drop this view's
  // viewer (and its Paseo subscription) so the pty can go live(detached). NOT a
  // kill — the pty survives for re-subscribe (#738/#762). Fire-and-forget; matched
  // by the client's per-mount attachId (the per-dispatch emit closure isn't
  // reference-stable across RPCs on the cloud/relay path).
  private handleUnsubscribeTerminal(msg: CyborgMsg, auth: CyborgAuthContext): void {
    const parsed = CyborgUnsubscribeTerminalSchema.parse(msg);
    this.terminalController?.unsubscribe(
      parsed.terminalId,
      auth.user.id,
      { attachId: parsed.attachId },
      auth.user.email,
    );
  }

  // Forget a persisted dead terminal (#750): delete its on-disk sidecar + log so a
  // dismissed history row stops surfacing. Owner-locked in the controller against
  // the persisted owner; a miss is a harmless no-op (ok:true either way — the row
  // is gone from the client's perspective regardless).
  private handleForgetTerminal(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): void {
    const parsed = CyborgForgetTerminalSchema.parse(msg);
    this.terminalController?.forget(parsed.terminalId, auth.user.id, auth.user.email);
    emit({
      type: "cyborg:forget_terminal_response",
      payload: { requestId: parsed.requestId, terminalId: parsed.terminalId, ok: true },
    });
  }

  private async handleMarkRead(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgMarkReadSchema.parse(msg);
    const lastReadAt = this.messageRouter.handleMarkRead(auth, parsed);
    emit({
      type: "cyborg:mark_read_response",
      payload: { requestId: parsed.requestId, lastReadAt },
    });
  }

  private async handleMarkChannelUnread(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgMarkChannelUnreadSchema.parse(msg);
    const lastReadAt = this.messageRouter.handleMarkChannelUnread(auth, parsed);
    emit({
      type: "cyborg:mark_channel_unread_response",
      payload: { requestId: parsed.requestId, lastReadAt },
    });
  }

  private async handleFetchUnread(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchUnreadSchema.parse(msg);
    const { counts, reads } = this.messageRouter.handleFetchUnread(auth, parsed);
    emit({
      type: "cyborg:fetch_unread_response",
      payload: { requestId: parsed.requestId, counts, reads },
    });
  }

  private async handleFetchActivity(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchActivitySchema.parse(msg);
    const { items, unread } = this.messageRouter.handleFetchActivity(auth, parsed);
    emit({
      type: "cyborg:fetch_activity_response",
      payload: { requestId: parsed.requestId, items, unread },
    });
  }

  private async handleMarkActivityRead(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgMarkActivityReadSchema.parse(msg);
    const unread = this.messageRouter.handleMarkActivityRead(auth, parsed);
    emit({
      type: "cyborg:mark_activity_read_response",
      payload: { requestId: parsed.requestId, unread },
    });
  }

  private async handleSetNotificationPref(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetNotificationPrefSchema.parse(msg);
    this.messageRouter.handleSetNotificationPref(auth, parsed);
    emit({
      type: "cyborg:set_notification_pref_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleFetchNotificationPrefs(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchNotificationPrefsSchema.parse(msg);
    const prefs = this.messageRouter.handleFetchNotificationPrefs(auth, parsed);
    emit({
      type: "cyborg:fetch_notification_prefs_response",
      payload: { requestId: parsed.requestId, prefs },
    });
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  private async handleDraftSet(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDraftSetSchema.parse(msg);
    this.messageRouter.handleDraftSet(auth, parsed);
    emit({
      type: "cyborg:draft_set_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleDraftClear(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDraftClearSchema.parse(msg);
    this.messageRouter.handleDraftClear(auth, parsed);
    emit({
      type: "cyborg:draft_clear_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleFetchDrafts(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchDraftsSchema.parse(msg);
    const drafts = this.messageRouter.handleFetchDrafts(auth, parsed);
    emit({
      type: "cyborg:fetch_drafts_response",
      payload: { requestId: parsed.requestId, drafts },
    });
  }

  private async handleEditMessage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgEditMessageSchema.parse(msg);
    const updated = this.messageRouter.handleEditMessage(auth, parsed);
    emit({
      type: "cyborg:edit_message_response",
      payload: { requestId: parsed.requestId, updated },
    });
  }

  private async handleDeleteMessage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteMessageSchema.parse(msg);
    const deleted = this.messageRouter.handleDeleteMessage(auth, parsed);
    emit({
      type: "cyborg:delete_message_response",
      payload: { requestId: parsed.requestId, deleted },
    });
  }

  private async handleSync(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): Promise<void> {
    const parsed = CyborgSyncRequestSchema.parse(msg);
    const result = this.messageRouter.handleSync(auth, parsed);
    emit({
      type: "cyborg:sync_response",
      payload: {
        requestId: parsed.requestId,
        mode: result.mode,
        messages: result.messages.map(formatMessage),
      },
    });
  }

  private async handleCreateChannel(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateChannelRequestSchema.parse(msg);
    const channel = this.workspaceManager.createChannel(
      parsed.workspaceId,
      auth.user.id,
      parsed.name,
      {
        description: parsed.description,
        isPrivate: parsed.isPrivate,
        instructions: parsed.instructions,
      },
    );
    if (!channel) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot create channel",
        },
      });
      return;
    }
    emit({
      type: "cyborg:create_channel_response",
      payload: {
        requestId: parsed.requestId,
        channel: {
          id: channel.id,
          workspaceId: channel.workspace_id,
          name: channel.name,
          description: channel.description,
          isPrivate: !!channel.is_private,
          instructions: channel.instructions,
          createdBy: channel.created_by,
          createdAt: channel.created_at,
        },
      },
    });
  }

  private async handleCreateGroupDm(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateGroupDmRequestSchema.parse(msg);
    const result = this.workspaceManager.createGroupDm(
      parsed.workspaceId,
      auth.user.id,
      parsed.participants,
    );
    if (!result.ok) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: result.code === "forbidden" ? "forbidden" : "invalid_request",
          message: result.message,
        },
      });
      return;
    }
    const channel = result.channel;
    emit({
      type: "cyborg:create_group_dm_response",
      payload: {
        requestId: parsed.requestId,
        channel: {
          id: channel.id,
          workspaceId: channel.workspace_id,
          name: channel.name,
          description: channel.description,
          isPrivate: !!channel.is_private,
          instructions: channel.instructions,
          createdBy: channel.created_by,
          createdAt: channel.created_at,
          type: channel.type ?? "group_dm",
          isHidden: !!channel.is_hidden,
        },
      },
    });
  }

  private async handleFetchChannels(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchChannelsRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot view channels",
        },
      });
      return;
    }
    const channels = this.workspaceManager.getChannels(parsed.workspaceId);
    emit({
      type: "cyborg:fetch_channels_response",
      payload: {
        requestId: parsed.requestId,
        channels: channels.map((c) => ({
          id: c.id,
          workspaceId: c.workspace_id,
          name: c.name,
          description: c.description,
          isPrivate: !!c.is_private,
          instructions: c.instructions,
          createdBy: c.created_by,
          createdAt: c.created_at,
          // #608: kind + browser visibility so the sidebar groups group DMs.
          type: c.type ?? "regular",
          isHidden: !!c.is_hidden,
          // Tasks Phase 2 — auto-tasks opt-in switch (OPT-IN: only explicit 1 = ON).
          autoTasksEnabled: c.auto_tasks_enabled === 1,
        })),
      },
    });
  }

  private async handleCreateWorkspace(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateWorkspaceRequestSchema.parse(msg);
    const workspace = this.workspaceManager.createWorkspace(
      parsed.name,
      auth.user.id,
      parsed.settings,
    );
    this.subscribeWorkspace(workspace.id);
    emit({
      type: "cyborg:create_workspace_response",
      payload: {
        requestId: parsed.requestId,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          ownerId: workspace.owner_id,
          settings: workspace.settings ? JSON.parse(workspace.settings) : {},
          createdAt: workspace.created_at,
        },
      },
    });
  }

  private async handleFetchWorkspaces(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchWorkspacesRequestSchema.parse(msg);
    const workspaces = this.workspaceManager.getWorkspacesForUser(auth.user.id);
    emit({
      type: "cyborg:fetch_workspaces_response",
      payload: {
        requestId: parsed.requestId,
        workspaces: workspaces.map((ws) => ({
          id: ws.id,
          name: ws.name,
          ownerId: ws.owner_id,
          role: ws.role,
          settings: ws.settings ? JSON.parse(ws.settings) : {},
          createdAt: ws.created_at,
        })),
      },
    });
  }

  private async handleUpdateWorkspace(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateWorkspaceRequestSchema.parse(msg);
    const role = this.workspaceManager.getMemberRole(parsed.workspaceId, auth.user.id);
    if (role !== "owner" && role !== "admin") {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot update workspace",
        },
      });
      return;
    }
    const updates: {
      name?: string;
      avatarUrl?: string | null;
      settings?: Record<string, unknown>;
    } = {};
    if (typeof parsed.name === "string" && parsed.name.trim()) updates.name = parsed.name.trim();
    if (parsed.avatarUrl !== undefined) updates.avatarUrl = parsed.avatarUrl;
    if (parsed.settings !== undefined) updates.settings = parsed.settings;
    this.workspaceManager.updateWorkspace(parsed.workspaceId, auth.user.id, updates);
    emit({
      type: "cyborg:update_workspace_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleDeleteWorkspace(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteWorkspaceRequestSchema.parse(msg);
    const role = this.workspaceManager.getMemberRole(parsed.workspaceId, auth.user.id);
    if (role !== "owner") {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the workspace owner can delete it",
        },
      });
      return;
    }
    this.workspaceManager.deleteWorkspace(parsed.workspaceId);
    emit({
      type: "cyborg:delete_workspace_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleInviteMember(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgInviteMemberRequestSchema.parse(msg);
    const membership = this.workspaceManager.inviteMember(
      parsed.workspaceId,
      auth.user.id,
      parsed.email,
      parsed.role,
    );
    if (!membership) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot invite member",
        },
      });
      return;
    }
    emit({
      type: "cyborg:invite_member_response",
      payload: { requestId: parsed.requestId, membership },
    });
  }

  private async handleRemoveMember(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRemoveMemberRequestSchema.parse(msg);
    const removed = this.workspaceManager.removeMember(
      parsed.workspaceId,
      auth.user.id,
      parsed.userId,
    );
    if (!removed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot remove member",
        },
      });
      return;
    }
    emit({
      type: "cyborg:remove_member_response",
      payload: { requestId: parsed.requestId, removed: true },
    });
  }

  private async handleUpdateRole(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateRoleRequestSchema.parse(msg);
    const updated = this.workspaceManager.updateMemberRole(
      parsed.workspaceId,
      auth.user.id,
      parsed.userId,
      parsed.role,
    );
    if (!updated) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot update role",
        },
      });
      return;
    }
    emit({
      type: "cyborg:update_role_response",
      payload: { requestId: parsed.requestId, updated: true },
    });
  }

  private async handleCreateTask(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateTaskRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot create task",
        },
      });
      return;
    }
    const rl = this.rateLimiter.check(parsed.workspaceId, "task_create");
    if (!rl.allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "rate_limited",
          message: "Too many tasks created",
        },
      });
      return;
    }
    // The create-path require-rule (project | channel | parent) lives in
    // storage.createTask's resolveCreateProject: it throws a plain Error
    // ("provide projectId or channelId" when none is supplied, "project not found"
    // when an explicit projectId is unknown). Surface those as a cyborg:error with
    // the real message (mirrors the relay's try/catch + respondError) and stop
    // before the activity-feed / broadcast side effects, instead of letting the
    // throw escape to a non-cyborg rpc_error the CLI can't match (→ 15s hang).
    let task: StoredTask;
    try {
      task = this.storage.createTask({
        // User/cybo-facing create (UI + the cybo's cyborg7_create_task local path):
        // require an explicit project/channel/parent context — no silent Inbox
        // fallback. With none, resolveCreateProject throws "provide projectId or
        // channelId", caught below and surfaced as cyborg:error (the CLI matches it).
        requireProjectContext: true,
        workspaceId: parsed.workspaceId,
        title: parsed.title,
        description: parsed.description,
        assigneeId: parsed.assigneeId,
        createdBy: auth.user.id,
        dueAt: parsed.dueAt,
        // Tasks Phase 2 (watcher): thread the optional channel binding + board
        // priority the schema accepts. Without this a task created via the daemon
        // (UI or a cybo's cyborg7_create_task) silently lost both.
        channelId: parsed.channelId,
        priority: parsed.priority,
        // Tasks Redesign — Plane-style fields. Scalars (project/parent/state/cycle,
        // planned start) land as task columns on both stores; `labels` are NAMES
        // (resolved/created against the task's final project) and `moduleIds` are ids,
        // both routed to the join tables. Without this, a daemon-side create (UI or a
        // cybo's cyborg7_create_task) silently dropped every new task attribute.
        projectId: parsed.projectId,
        parentId: parsed.parentId,
        stateId: parsed.stateId,
        startDate: parsed.startDate,
        cycleId: parsed.cycleId,
        labels: parsed.labels,
        moduleIds: parsed.moduleIds,
      });
    } catch (err) {
      this.emitTaskOpError(parsed.requestId, err, emit);
      return;
    }
    emit({
      type: "cyborg:create_task_response",
      payload: { requestId: parsed.requestId, task },
    });
    // Activity feed + live update. A human assignee (not the creator) gets a
    // "task_assigned" row via MessageRouter's activity path (same one mentions
    // use); a cybo/agent assignee produces none (not a workspace member).
    this.emitTaskActivityEvents(task, null, auth);
    this.messageRouter.broadcastTasksChanged({
      workspaceId: parsed.workspaceId,
      op: "created",
      task: mapTaskForBroadcast(task),
    });
    // Logs tab observability: a human (or a cybo's cyborg7_create_task) created a
    // task — surface who/what/assignee/priority.
    this.messageRouter.broadcastTaskEvent({
      kind: "task_created",
      workspaceId: task.workspace_id,
      taskId: task.id,
      channelId: task.channel_id ?? null,
      cyboId: this.storage.getCybo(task.assignee_id ?? "") ? task.assignee_id : null,
      title: task.title,
      assigneeName: this.resolveAssigneeName(task.workspace_id, task.assignee_id),
      priority: task.priority ?? null,
      actor: auth.user.name ?? auth.user.email,
    });
    // Tasks Phase 3 (internal docs): a task created with an AGENT assignee and
    // no FUTURE due_at is dispatched immediately. A future-due task is left for the
    // schedule-runner tick to fire at its slot. The atomic claim inside
    // dispatchTaskToAgent dedupes against that tick (whichever fires first wins).
    this.maybeDispatchOnAssign(task);
  }

  // Immediate execute-dispatch when a create/update assigns a task to a cybo with
  // no future due_at. getCybo is the agent-vs-human discriminator (a human assignee
  // never resolves). Fire-and-forget — the dispatch's own claim + error handling
  // make it safe; a future-due task is skipped (the tick fires it at its slot).
  private maybeDispatchOnAssign(task: StoredTask): void {
    if (!this.agentManager) return;
    if (!task.assignee_id) return;
    if (task.due_at && task.due_at > Date.now()) return;
    if (!this.storage.getCybo(task.assignee_id)) return;
    void dispatchTaskToAgent({
      storage: this.storage,
      agentManager: this.agentManager,
      task,
      reason: "task_assigned",
      serverId: this.serverId ?? undefined,
      cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
      credentialStore: this.credentialStore,
      composio: this.composio,
      logger: this.logger ?? undefined,
      onEvent: (ev) => this.messageRouter.broadcastTaskEvent(ev),
    }).catch((err) =>
      this.logger?.warn({ err, taskId: task.id }, "[tasks] immediate dispatch failed"),
    );
  }

  private async handleUpdateTask(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateTaskRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot update task",
        },
      });
      return;
    }
    // Snapshot the prior assignee/status BEFORE mutating, so task-activity can
    // tell a reassign from a status move (no single-task getter on DualStorage).
    const prevTask = (this.storage.getTasks(parsed.workspaceId) ?? []).find(
      (t) => t.id === parsed.taskId,
    );
    // Re-parenting to an unknown project throws a plain Error ("project not found")
    // from storage.updateTask's column resolver. Surface it as a cyborg:error with
    // the real message (same as the create path / relay), not an unmatched rpc_error.
    let task: StoredTask | undefined;
    try {
      task = this.storage.updateTask(parsed.taskId, {
        status: parsed.status,
        title: parsed.title,
        description: parsed.description,
        assigneeId: parsed.assigneeId,
        result: parsed.result,
        // dueAt (epoch ms | null) and priority must be forwarded too, else a
        // due-date / priority edit from the detail card is silently dropped here
        // and only the status survives. null dueAt clears the due date.
        dueAt: parsed.dueAt,
        priority: parsed.priority,
        // Tasks Redesign — Plane-style fields on update. Scalars (project/parent/
        // state/cycle, planned start) replace task columns; pass null to clear one. An
        // explicit `labels` (NAMES, resolved to ids by DualStorage) / `moduleIds` array
        // replace-sets that join table (empty array clears it). Without this, an edit of
        // any new attribute from the detail card was silently dropped on the daemon path.
        projectId: parsed.projectId,
        parentId: parsed.parentId,
        stateId: parsed.stateId,
        startDate: parsed.startDate,
        cycleId: parsed.cycleId,
        labels: parsed.labels,
        moduleIds: parsed.moduleIds,
      });
    } catch (err) {
      this.emitTaskOpError(parsed.requestId, err, emit);
      return;
    }
    if (!task) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    emit({
      type: "cyborg:update_task_response",
      payload: { requestId: parsed.requestId, task },
    });
    // Activity feed + live update — same path as create, but the prev snapshot
    // drives task_assigned (assignee changed) vs task_status_changed.
    this.emitTaskActivityEvents(
      task,
      prevTask ? { assigneeId: prevTask.assignee_id, status: prevTask.status } : null,
      auth,
    );
    this.messageRouter.broadcastTasksChanged({
      workspaceId: parsed.workspaceId,
      op: "updated",
      task: mapTaskForBroadcast(task),
    });
    // Logs tab observability: surface a status move ("To Do -> Done by <actor>").
    // Only when the status actually changed (a title/assignee-only edit is noise).
    if (prevTask && prevTask.status !== task.status) {
      this.messageRouter.broadcastTaskEvent({
        kind: "task_status_changed",
        workspaceId: task.workspace_id,
        taskId: task.id,
        channelId: task.channel_id ?? null,
        title: task.title,
        fromStatus: prevTask.status,
        toStatus: task.status,
        actor: auth.user.name ?? auth.user.email,
      });
    }
    // Tasks Phase 3 (internal docs): if this update flipped a RECURRING task to
    // done, spawn its next occurrence (exactly-once via the atomic spawn claim). The
    // "just became done" guard (prev !== done && next === done) keeps a repeated
    // done→done write from spawning twice, on top of the atomic recurrence_spawned_at
    // claim.
    const justCompleted = task.status === "done" && prevTask?.status !== "done";
    if (justCompleted && task.recurrence) {
      spawnNextRecurrence({
        storage: this.storage,
        task,
        nowMs: Date.now(),
        logger: this.logger ?? undefined,
        onEvent: (ev) => this.messageRouter.broadcastTaskEvent(ev),
      });
    }
    // Tasks Phase 3 (internal docs): if this update assigned the task to a cybo
    // with no future due_at, dispatch immediately (claim dedupes vs the runner).
    this.maybeDispatchOnAssign(task);
  }

  // Resolve a task assignee id to a display name for the Logs tab: a cybo by its
  // name, else a workspace human by name/email, else the raw id (cross-workspace /
  // removed). Best-effort — display only.
  private resolveAssigneeName(workspaceId: string, assigneeId: string | null): string | null {
    if (!assigneeId) return null;
    const cybo = this.storage.getCybo(assigneeId);
    if (cybo) return cybo.name;
    const member = this.workspaceManager
      .getMembers(workspaceId)
      .find((m) => m.user_id === assigneeId);
    if (member) return member.name ?? member.email ?? assigneeId;
    return assigneeId;
  }

  // Build + write task activity rows for a create/update. Pure decision lives in
  // taskActivityEvents; this supplies the human-member predicate (a cybo/agent id
  // is never a workspace member) and the actor name, then writes each row via the
  // shared MessageRouter activity path.
  private emitTaskActivityEvents(
    task: StoredTask,
    prev: { assigneeId: string | null; status: string } | null,
    auth: CyborgAuthContext,
  ): void {
    const memberIds = new Set(
      (this.workspaceManager.getMembers(task.workspace_id) ?? []).map((m) => m.user_id),
    );
    const actorName = auth.user.name ?? auth.user.email;
    const events = taskActivityEvents({
      prev,
      next: {
        id: task.id,
        title: task.title,
        assigneeId: task.assignee_id,
        status: task.status,
      },
      actorId: auth.user.id,
      isHumanRecipient: (id) => memberIds.has(id),
    });
    for (const ev of events) {
      this.messageRouter.emitTaskActivity(ev.recipientId, {
        workspaceId: task.workspace_id,
        eventType: ev.eventType,
        sourceId: ev.sourceId,
        previewText: ev.previewText,
        actorId: auth.user.id,
        actorName,
      });
    }
  }

  private async handleFetchTasks(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchTasksRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot view tasks",
        },
      });
      return;
    }
    // Tasks Redesign — optional single-project scope, mirroring the relay's
    // fetch_tasks handler. The wire projectId is a CHAT id (the UI/CLI route on it)
    // or a "tp_…" id; resolve it to the tasks_projects.id, then scope the page to it.
    // Omitted → the full workspace page (unchanged). An explicit id that resolves to
    // nothing → not_found (fail-closed), matching the relay's "project not found".
    let projectFilterId: string | undefined;
    if (parsed.projectId) {
      const resolved = this.storage.resolveTasksProjectId(parsed.projectId);
      if (!resolved) {
        emit({
          type: "cyborg:error",
          payload: {
            requestId: parsed.requestId,
            code: "not_found",
            message: "Project not found",
          },
        });
        return;
      }
      projectFilterId = resolved;
    }
    const { tasks, nextCursor } = this.storage.getTasksPage(parsed.workspaceId, {
      status: parsed.status,
      assigneeId: parsed.assigneeId,
      limit: parsed.limit,
      cursor: parsed.cursor,
      // Scope to the resolved tasks_projects.id when given (the SQL also pins
      // workspace_id, so a cross-workspace id naturally yields an empty page).
      projectId: projectFilterId,
    });
    emit({
      type: "cyborg:fetch_tasks_response",
      payload: {
        requestId: parsed.requestId,
        tasks: tasks.map(mapTaskForBroadcast),
        nextCursor,
      },
    });
  }

  // List the workspace's Tasks-projects (the CLI / UI project picker source). The
  // daemon mirror of the relay's cyborg:fetch_tasks_projects: the message carries the
  // workspaceId, so the same "view" permission gate as fetch_tasks proves membership.
  // Solo SQLite has a single user, so there is no PG-style per-project visibility to
  // apply — every Tasks-project in the workspace is returned. Each raw row is mapped
  // to the picker shape: name = the linked chat project's name (or "Inbox" for the
  // synthetic chat_project_id-null project, falling back to the identifier); color
  // falls back to the chat project's color; isInbox = (chat_project_id == null).
  private async handleFetchTasksProjects(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchTasksProjectsRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot view tasks projects",
        },
      });
      return;
    }
    // id → chat project (name + color) map for the display-name / color fallback.
    const chatProjects = new Map(
      this.storage.getProjects(parsed.workspaceId).map((p) => [p.id, p]),
    );
    const projects = this.storage.getTasksProjects(parsed.workspaceId).map((tp) => {
      const chat = tp.chat_project_id ? chatProjects.get(tp.chat_project_id) : undefined;
      return {
        id: tp.id,
        identifier: tp.identifier,
        name: tp.chat_project_id ? (chat?.name ?? tp.identifier) : "Inbox",
        color: tp.color ?? chat?.color ?? null,
        isInbox: tp.chat_project_id === null,
        chatProjectId: tp.chat_project_id,
      };
    });
    emit({
      type: "cyborg:fetch_tasks_projects_response",
      payload: {
        requestId: parsed.requestId,
        projects,
      },
    });
  }

  // ─── Tasks Redesign catalog reads (board/detail) ─────────────────────
  // Daemon/SQLite mirrors of the relay's five catalog fetches. The wire carries
  // the CHAT projectId / taskId only (no workspaceId), so each handler resolves
  // the project to its tasks_projects.id, derives the workspace from that row, and
  // gates with the same "view" permission as fetch_tasks. A project that can't be
  // resolved (or whose workspace the caller can't view) → forbidden (fail-closed).

  // Resolve a wire projectId → its workspace id (via the local Tasks-project),
  // gated by the caller's "view" permission. Returns the resolved tasks_projects
  // id on success, or null (after emitting cyborg:error) when missing/forbidden.
  private gateProjectView(
    projectId: string,
    requestId: string,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): string | null {
    const resolvedId = this.storage.resolveTasksProjectId(projectId);
    const project = resolvedId ? this.storage.getTasksProject(resolvedId) : undefined;
    const allowed = project
      ? this.workspaceManager.checkPermission(project.workspace_id, auth.user.id, "view").allowed
      : false;
    if (!project || !allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId, code: "forbidden", message: "Cannot view project" },
      });
      return null;
    }
    return project.id;
  }

  private async handleFetchProjectStates(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchProjectStatesRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    emit({
      type: "cyborg:fetch_project_states_response",
      payload: {
        requestId: parsed.requestId,
        states: this.storage.getProjectStates(resolvedId),
      },
    });
  }

  private async handleFetchProjectLabels(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchProjectLabelsRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    emit({
      type: "cyborg:fetch_project_labels_response",
      payload: {
        requestId: parsed.requestId,
        labels: this.storage.getProjectLabels(resolvedId),
      },
    });
  }

  private async handleFetchCycles(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchCyclesRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    emit({
      type: "cyborg:fetch_cycles_response",
      payload: {
        requestId: parsed.requestId,
        cycles: this.storage.getProjectCycles(resolvedId),
      },
    });
  }

  private async handleFetchModules(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchModulesRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    emit({
      type: "cyborg:fetch_modules_response",
      payload: {
        requestId: parsed.requestId,
        modules: this.storage.getProjectModules(resolvedId),
      },
    });
  }

  // ─── Cycles catalog CRUD (daemon path) ─────────────────────────────
  // create carries the wire (chat) projectId; update/delete carry the cycleId, so
  // the cycle is resolved to its tasks_projects id (which gateProjectView accepts)
  // before the same "view" gate. Storage writes SQLite + mirrors to PG.

  private async handleCreateCycle(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateCycleRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    const cycle = this.storage.createCycle({
      projectId: parsed.projectId,
      name: parsed.name,
      description: parsed.description ?? null,
      startDate: parsed.startDate ?? null,
      endDate: parsed.endDate ?? null,
    });
    emit({
      type: "cyborg:create_cycle_response",
      payload: { requestId: parsed.requestId, cycle },
    });
  }

  private async handleUpdateCycle(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateCycleRequestSchema.parse(msg);
    const cycleProjectId = this.storage.getCycleProjectId(parsed.cycleId);
    if (!cycleProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(cycleProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    const cycle = this.storage.updateCycle(parsed.cycleId, {
      name: parsed.name,
      description: parsed.description,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
    });
    if (!cycle) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Cycle not found" },
      });
      return;
    }
    emit({
      type: "cyborg:update_cycle_response",
      payload: { requestId: parsed.requestId, cycle },
    });
  }

  private async handleDeleteCycle(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteCycleRequestSchema.parse(msg);
    const cycleProjectId = this.storage.getCycleProjectId(parsed.cycleId);
    if (!cycleProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(cycleProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    this.storage.deleteCycle(parsed.cycleId);
    emit({
      type: "cyborg:delete_cycle_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
  }

  // ─── Project pages catalog CRUD (daemon path) ──────────────────────
  // fetch/create carry the wire (chat) projectId; fetch_page/update/archive/delete
  // carry the pageId, so the page is resolved to its tasks_projects id (which
  // gateProjectView accepts) before the same "view" gate. Storage writes SQLite +
  // mirrors to PG; create/update/archive/delete fan a cyborg:pages_changed out to
  // the workspace so open pages views refresh live.

  private async handleFetchPages(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchPagesRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    emit({
      type: "cyborg:fetch_pages_response",
      payload: {
        requestId: parsed.requestId,
        pages: this.storage.getProjectPages(resolvedId, auth.user.id),
      },
    });
  }

  private async handleFetchPage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchPageRequestSchema.parse(msg);
    const pageProjectId = this.storage.getPageProjectId(parsed.pageId);
    // Missing page → return null (not an error) so the client can treat it as "gone".
    if (!pageProjectId) {
      emit({
        type: "cyborg:fetch_page_response",
        payload: { requestId: parsed.requestId, page: null },
      });
      return;
    }
    const resolvedId = this.gateProjectView(pageProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    const page = this.storage.getPage(parsed.pageId);
    // A non-null-owner private page is visible ONLY to its owner; return null for
    // everyone else (mirrors the list filter). Public + null-owner pages return.
    emit({
      type: "cyborg:fetch_page_response",
      payload: {
        requestId: parsed.requestId,
        page: page && isPageRestrictedFromUser(page, auth.user.id) ? null : page,
      },
    });
  }

  private async handleCreatePage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreatePageRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    let page;
    try {
      page = this.storage.createPage({
        projectId: parsed.projectId,
        title: parsed.title,
        ownedBy: auth.user.id,
        parentId: parsed.parentId ?? null,
      });
    } catch (err) {
      if (err instanceof Error && err.message === "parent page not found in this project") {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "not_found", message: err.message },
        });
        return;
      }
      throw err;
    }
    emit({
      type: "cyborg:create_page_response",
      payload: { requestId: parsed.requestId, page },
    });
    this.messageRouter.broadcastPagesChanged({
      workspaceId: page.workspaceId,
      projectId: page.projectId,
      op: "created",
      // Strip a private page to id+visibility so its title/content never fans out
      // workspace-wide to non-owners; public + null-owner pages broadcast in full.
      page: pageBroadcastPayload(page),
    });
  }

  private async handleUpdatePage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdatePageRequestSchema.parse(msg);
    const pageProjectId = this.storage.getPageProjectId(parsed.pageId);
    if (!pageProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(pageProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    // Owner-gate: a non-null-owner private page is editable only by its owner (the
    // project gate above is membership-only). The owner can still flip it public.
    const current = this.storage.getPage(parsed.pageId);
    if (current && isPageRestrictedFromUser(current, auth.user.id)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot edit page" },
      });
      return;
    }
    let page;
    try {
      page = this.storage.updatePage(parsed.pageId, {
        title: parsed.title,
        content: parsed.content,
        visibility: parsed.visibility,
        icon: parsed.icon,
        parentId: parsed.parentId,
        sortOrder: parsed.sortOrder,
      });
    } catch (err) {
      // Re-parent rejections (cycle or cross-project parent) are user-input.
      if (
        err instanceof PageCycleError ||
        (err instanceof Error && err.message === "parent page not found in this project")
      ) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: err.message },
        });
        return;
      }
      throw err;
    }
    if (!page) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Page not found" },
      });
      return;
    }
    emit({
      type: "cyborg:update_page_response",
      payload: { requestId: parsed.requestId, page },
    });
    this.messageRouter.broadcastPagesChanged({
      workspaceId: page.workspaceId,
      projectId: page.projectId,
      op: "updated",
      // Strip a private page to id+visibility so its title/content never fans out
      // workspace-wide to non-owners; public + null-owner pages broadcast in full.
      page: pageBroadcastPayload(page),
    });
  }

  private async handleSetPageArchived(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetPageArchivedRequestSchema.parse(msg);
    const pageProjectId = this.storage.getPageProjectId(parsed.pageId);
    if (!pageProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(pageProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    // Owner-gate: a non-null-owner private page is archivable only by its owner.
    const current = this.storage.getPage(parsed.pageId);
    if (current && isPageRestrictedFromUser(current, auth.user.id)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot edit page" },
      });
      return;
    }
    const page = this.storage.setPageArchived(parsed.pageId, parsed.archived);
    if (!page) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Page not found" },
      });
      return;
    }
    emit({
      type: "cyborg:set_page_archived_response",
      payload: { requestId: parsed.requestId, page },
    });
    this.messageRouter.broadcastPagesChanged({
      workspaceId: page.workspaceId,
      projectId: page.projectId,
      op: "updated",
      // Strip a private page to id+visibility so its title/content never fans out
      // workspace-wide to non-owners; public + null-owner pages broadcast in full.
      page: pageBroadcastPayload(page),
    });
  }

  private async handleDeletePage(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeletePageRequestSchema.parse(msg);
    const pageProjectId = this.storage.getPageProjectId(parsed.pageId);
    if (!pageProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(pageProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    // Capture identity for the broadcast before the row is gone.
    const page = this.storage.getPage(parsed.pageId);
    // Owner-gate: a non-null-owner private page is deletable only by its owner.
    if (page && isPageRestrictedFromUser(page, auth.user.id)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot delete page" },
      });
      return;
    }
    this.storage.deletePage(parsed.pageId);
    emit({
      type: "cyborg:delete_page_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
    if (page) {
      this.messageRouter.broadcastPagesChanged({
        workspaceId: page.workspaceId,
        projectId: page.projectId,
        op: "deleted",
        page: { id: page.id },
      });
    }
  }

  // ─── Modules catalog CRUD (daemon path) ────────────────────────────

  private async handleCreateModule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateModuleRequestSchema.parse(msg);
    const resolvedId = this.gateProjectView(parsed.projectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    const moduleRow = this.storage.createModule({
      projectId: parsed.projectId,
      name: parsed.name,
      description: parsed.description ?? null,
      status: parsed.status ?? null,
    });
    emit({
      type: "cyborg:create_module_response",
      payload: { requestId: parsed.requestId, module: moduleRow },
    });
  }

  private async handleUpdateModule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateModuleRequestSchema.parse(msg);
    const moduleProjectId = this.storage.getModuleProjectId(parsed.moduleId);
    if (!moduleProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(moduleProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    const moduleRow = this.storage.updateModule(parsed.moduleId, {
      name: parsed.name,
      description: parsed.description,
      status: parsed.status,
    });
    if (!moduleRow) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Module not found" },
      });
      return;
    }
    emit({
      type: "cyborg:update_module_response",
      payload: { requestId: parsed.requestId, module: moduleRow },
    });
  }

  private async handleDeleteModule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteModuleRequestSchema.parse(msg);
    const moduleProjectId = this.storage.getModuleProjectId(parsed.moduleId);
    if (!moduleProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view project" },
      });
      return;
    }
    const resolvedId = this.gateProjectView(moduleProjectId, parsed.requestId, auth, emit);
    if (!resolvedId) return;
    this.storage.deleteModule(parsed.moduleId);
    emit({
      type: "cyborg:delete_module_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
  }

  private async handleFetchTaskActivity(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchTaskActivityRequestSchema.parse(msg);
    // Gate the feed via the task's project: resolve task→project, then run the same
    // "view" permission check the project reads use. The project id stored on the
    // task is already a tasks_projects id, so gateProjectView passes it through.
    const taskProjectId = this.storage.getTaskProjectId(parsed.taskId);
    if (!taskProjectId || !this.gateProjectView(taskProjectId, parsed.requestId, auth, emit)) {
      // gateProjectView emits the error for the resolved-but-forbidden case; a
      // missing task (no project) emits here.
      if (!taskProjectId) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view task" },
        });
      }
      return;
    }
    emit({
      type: "cyborg:fetch_task_activity_response",
      payload: {
        requestId: parsed.requestId,
        activity: this.storage.getTaskActivity(parsed.taskId),
      },
    });
  }

  // ─── Task links (daemon path) ──────────────────────────────────────
  // add/fetch carry the taskId; remove carries the linkId, resolved to its task's
  // project before the same "view" gate. Storage writes SQLite + mirrors to PG.

  private async handleAddTaskLink(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgAddTaskLinkRequestSchema.parse(msg);
    const taskProjectId = this.storage.getTaskProjectId(parsed.taskId);
    if (!taskProjectId || !this.gateProjectView(taskProjectId, parsed.requestId, auth, emit)) {
      if (!taskProjectId) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view task" },
        });
      }
      return;
    }
    const link = this.storage.addTaskLink({
      taskId: parsed.taskId,
      url: parsed.url,
      title: parsed.title ?? null,
      createdBy: auth.user.id,
    });
    emit({
      type: "cyborg:add_task_link_response",
      payload: { requestId: parsed.requestId, link },
    });
  }

  private async handleRemoveTaskLink(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRemoveTaskLinkRequestSchema.parse(msg);
    const linkProjectId = this.storage.getTaskLinkProjectId(parsed.linkId);
    if (!linkProjectId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view link" },
      });
      return;
    }
    if (!this.gateProjectView(linkProjectId, parsed.requestId, auth, emit)) return;
    this.storage.removeTaskLink(parsed.linkId);
    emit({
      type: "cyborg:remove_task_link_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
  }

  private async handleFetchTaskLinks(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchTaskLinksRequestSchema.parse(msg);
    const taskProjectId = this.storage.getTaskProjectId(parsed.taskId);
    if (!taskProjectId || !this.gateProjectView(taskProjectId, parsed.requestId, auth, emit)) {
      if (!taskProjectId) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view task" },
        });
      }
      return;
    }
    emit({
      type: "cyborg:fetch_task_links_response",
      payload: {
        requestId: parsed.requestId,
        links: this.storage.getTaskLinks(parsed.taskId),
      },
    });
  }

  // ─── Task attachments (daemon path) ────────────────────────────────
  // The client uploads via the presign route, then add persists the row from the
  // resulting key + delivery url. Gated by the task's project, like links.

  private async handleAddTaskAttachment(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgAddTaskAttachmentRequestSchema.parse(msg);
    const taskProjectId = this.storage.getTaskProjectId(parsed.taskId);
    if (!taskProjectId || !this.gateProjectView(taskProjectId, parsed.requestId, auth, emit)) {
      if (!taskProjectId) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view task" },
        });
      }
      return;
    }
    const attachment = this.storage.addTaskAttachment({
      taskId: parsed.taskId,
      key: parsed.key,
      url: parsed.url,
      name: parsed.name,
      size: parsed.size,
      contentType: parsed.contentType ?? null,
      uploadedBy: auth.user.id,
    });
    emit({
      type: "cyborg:add_task_attachment_response",
      payload: { requestId: parsed.requestId, attachment },
    });
  }

  private async handleRemoveTaskAttachment(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRemoveTaskAttachmentRequestSchema.parse(msg);
    const attProjectId = this.storage.getTaskAttachmentProjectId(parsed.attachmentId);
    if (!attProjectId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot view attachment",
        },
      });
      return;
    }
    if (!this.gateProjectView(attProjectId, parsed.requestId, auth, emit)) return;
    this.storage.removeTaskAttachment(parsed.attachmentId);
    emit({
      type: "cyborg:remove_task_attachment_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
  }

  private async handleFetchTaskAttachments(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchTaskAttachmentsRequestSchema.parse(msg);
    const taskProjectId = this.storage.getTaskProjectId(parsed.taskId);
    if (!taskProjectId || !this.gateProjectView(taskProjectId, parsed.requestId, auth, emit)) {
      if (!taskProjectId) {
        emit({
          type: "cyborg:error",
          payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot view task" },
        });
      }
      return;
    }
    emit({
      type: "cyborg:fetch_task_attachments_response",
      payload: {
        requestId: parsed.requestId,
        attachments: this.storage.getTaskAttachments(parsed.taskId),
      },
    });
  }

  // Phase 0 — drag-reorder a task within its (workspace, status) lane. Same
  // create_task permission gate (a viewer can't reorder). Persists the new
  // sort_order (SQLite authoritative, mirrored to PG) and broadcasts an "updated"
  // tasks_changed so other open boards re-sort live.
  private async handleReorderTask(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgReorderTaskRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot reorder task" },
      });
      return;
    }
    // Anchor to the asserted workspace before mutating (reorderTask is by id, so
    // without this a forged taskId could reorder another workspace's task — IDOR).
    const wsTasks = this.storage.getTasks(parsed.workspaceId);
    if (!wsTasks.some((t) => t.id === parsed.taskId)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    const task = this.storage.reorderTask(parsed.taskId, {
      beforeId: parsed.beforeId,
      afterId: parsed.afterId,
    });
    if (!task) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    emit({
      type: "cyborg:reorder_task_response",
      payload: { requestId: parsed.requestId, task: mapTaskForBroadcast(task) },
    });
    this.messageRouter.broadcastTasksChanged({
      workspaceId: parsed.workspaceId,
      op: "updated",
      task: mapTaskForBroadcast(task),
    });
  }

  // Phase 0 — apply one set of updates to many tasks at once. Same create_task
  // permission gate. Mirrors each updated row to PG and broadcasts one "updated"
  // tasks_changed per task so open views reflect the bulk edit live.
  private async handleBulkUpdateTasks(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgBulkUpdateTasksRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot update tasks",
        },
      });
      return;
    }
    // Anchor: only touch tasks that belong to this workspace (updateTask is by id
    // alone, so without this filter a forged id could edit another ws's task — IDOR).
    const wsTaskIds = new Set(this.storage.getTasks(parsed.workspaceId).map((t) => t.id));
    const allowedTaskIds = parsed.taskIds.filter((id) => wsTaskIds.has(id));
    if (allowedTaskIds.length === 0) {
      emit({
        type: "cyborg:bulk_update_tasks_response",
        payload: { requestId: parsed.requestId, tasks: [] },
      });
      return;
    }
    // Only the present fields are applied (undefined is skipped by updateTask).
    const tasks = this.storage.bulkUpdateTasks(allowedTaskIds, {
      status: parsed.updates.status,
      priority: parsed.updates.priority,
      assigneeId: parsed.updates.assigneeId,
      dueAt: parsed.updates.dueAt,
      archivedAt: parsed.updates.archivedAt,
    });
    emit({
      type: "cyborg:bulk_update_tasks_response",
      payload: { requestId: parsed.requestId, tasks: tasks.map(mapTaskForBroadcast) },
    });
    for (const task of tasks) {
      this.messageRouter.broadcastTasksChanged({
        workspaceId: parsed.workspaceId,
        op: "updated",
        task: mapTaskForBroadcast(task),
      });
    }
  }

  // Phase 0 — hard-delete a task (irreversible). Same create_task permission gate.
  // Broadcasts a "deleted" tasks_changed so open views drop the row by id.
  private async handleDeleteTask(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteTaskRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot delete task" },
      });
      return;
    }
    // Anchor to the asserted workspace before deleting (deleteTask is by id, so
    // without this a forged taskId could delete another workspace's task — IDOR).
    const wsTasks = this.storage.getTasks(parsed.workspaceId);
    if (!wsTasks.some((t) => t.id === parsed.taskId)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    const deleted = this.storage.deleteTask(parsed.taskId);
    emit({
      type: "cyborg:delete_task_response",
      payload: { requestId: parsed.requestId, taskId: parsed.taskId, deleted },
    });
    if (deleted) {
      // The wire schema (CyborgTasksChangedSchema, this package) accepts op
      // "deleted"; broadcastTasksChanged's param type still lists created|updated
      // (a shared file outside this task's scope). The cast emits the correct wire
      // value without editing that shared signature — the runtime payload is valid.
      this.messageRouter.broadcastTasksChanged({
        workspaceId: parsed.workspaceId,
        op: "deleted" as "updated",
        task: { id: parsed.taskId },
      });
    }
  }

  // Phase 0 — soft archive / un-archive a task (sets/clears archived_at). Same
  // create_task permission gate. Broadcasts an "updated" tasks_changed carrying the
  // new archivedAt so default views hide/show the row live.
  private async handleArchiveTask(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgArchiveTaskRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_task",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot archive task" },
      });
      return;
    }
    // Anchor to the asserted workspace before mutating (archiveTask is by id, so
    // without this a forged taskId could archive another workspace's task — IDOR).
    const wsTasks = this.storage.getTasks(parsed.workspaceId);
    if (!wsTasks.some((t) => t.id === parsed.taskId)) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    const task = this.storage.archiveTask(parsed.taskId, parsed.archived);
    if (!task) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Task not found" },
      });
      return;
    }
    emit({
      type: "cyborg:archive_task_response",
      payload: { requestId: parsed.requestId, task: mapTaskForBroadcast(task) },
    });
    this.messageRouter.broadcastTasksChanged({
      workspaceId: parsed.workspaceId,
      op: "updated",
      task: mapTaskForBroadcast(task),
    });
  }

  private async handleCreateAgent(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateAgentRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot create agent",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    const rl = this.rateLimiter.check(parsed.workspaceId, "agent_spawn");
    if (!rl.allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "rate_limited",
          message: "Too many agents created",
        },
      });
      return;
    }

    try {
      const systemPrompt = buildSystemPrompt(parsed.workspaceId, parsed.systemPrompt);
      const config: AgentSessionConfig = {
        provider: parsed.provider,
        cwd: parsed.cwd,
        model: parsed.model,
        systemPrompt,
        // Valid Codex variant (NOT the legacy "auto", which codex-app-server
        // rejects on turn 1). Claude/Pi providers ignore this field.
        approvalPolicy: CYBO_CODEX_APPROVAL_POLICY,
      };

      const agent = await this.agentManager.createAgent(config, undefined, {
        workspaceId: parsed.workspaceId,
        labels: {
          surface: "cyborg7",
          workspaceId: parsed.workspaceId,
          ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        },
      });

      this.storage.createAgentBinding({
        agentId: agent.id,
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId,
        provider: parsed.provider,
        model: parsed.model,
        systemPrompt,
        daemonId: this.serverId,
        initiatedBy: auth.user.id,
        // Real canonical email (cloud-forwarded path stamps it) so the offline
        // visibility filter matches the owner — not the local <id>@remote.local.
        initiatedByEmail: auth.user.email ?? null,
        cwd: agent.cwd ?? parsed.cwd ?? null,
      });
      // Session-history row for the Home stats (best-effort, PG-only).
      this.storage.recordAgentSessionStart({
        agentId: agent.id,
        workspaceId: parsed.workspaceId,
        channelId: parsed.channelId ?? null,
        userId: auth.user.id,
        provider: parsed.provider,
        cyboId: null,
        sessionType: "session",
        cwd: agent.cwd ?? parsed.cwd ?? null,
      });

      emit({
        type: "cyborg:create_agent_response",
        payload: {
          requestId: parsed.requestId,
          agent: {
            agentId: agent.id,
            provider: agent.provider,
            lifecycle: agent.lifecycle,
            model: agent.config.model ?? null,
            modeId: agent.currentModeId ?? null,
            availableModes: agent.availableModes,
            // Persisted config is the durable source (restored on load); runtimeInfo
            // is null until the agent re-emits, so without this fallback the choice
            // reset to "off" on reload.
            thinkingOptionId:
              agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
            cwd: agent.cwd,
            daemonLocal: true,
            // #843: include the owning daemonId so the client can target provider
            // fetches + agent-control RPCs (set_model/mode/thinking) at this daemon
            // immediately, instead of falling back to an arbitrary one (which left
            // the mode/thinking selectors disabled on a brand-new session).
            daemonId: this.serverId ?? undefined,
          },
        },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to create agent",
        },
      });
    }
  }

  private async handleListAgents(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListAgentsRequestSchema.parse(msg);
    let bindings = this.storage.getAgentsByWorkspace(parsed.workspaceId);
    if (parsed.cyboId) {
      bindings = bindings.filter((b) => b.cybo_id === parsed.cyboId);
    }
    // Resolve the caller's LOCAL id (initiated_by is stored in the local id space,
    // auth.user.id may be a cloud id for the same person) so a user's own private
    // agents aren't hidden from their list under id divergence.
    const callerLocalId = auth.user.email
      ? this.storage.getUserByEmail(auth.user.email)?.id
      : undefined;
    // Per-user visibility (agentBindingVisibleCore — the ONE rule shared with the
    // relay's OFFLINE path so live + offline lists agree). EPHEMERAL summons
    // (@-mentions, slash commands) are OWNER-SCOPED: they belong to the user who
    // triggered them and appear ONLY in that user's list — never every member's
    // sidebar (the 2026-06-12 ghost-session incident: a channel-bound ephemeral
    // leaked to ALL members through the channel_id short-circuit). Non-ephemeral
    // channel agents stay SHARED (a deliberate collaborative feature).
    bindings = bindings.filter((b) =>
      agentBindingVisibleCore(
        {
          channelId: b.channel_id,
          initiatedBy: b.initiated_by,
          ephemeral: b.ephemeral === 1,
        },
        () => b.initiated_by === auth.user.id || b.initiated_by === callerLocalId,
      ),
    );
    // Denormalize the cybo NAME so the client can label cybo-spawned agents by
    // their cybo name (e.g. "Cybo", "Apex") instead of the bare provider. Covers
    // BOTH workspace/DB cybos and local (disk) cybos — same merge as fetch_cybos —
    // so it doesn't depend on the client's cybo list being loaded or id formats
    // matching (the source of this recurring regression).
    const cyboInfo = await this.buildCyboInfoMap(parsed.workspaceId);
    emit({
      type: "cyborg:list_agents_response",
      payload: {
        requestId: parsed.requestId,
        agents: bindings.map((b) => this.toAgentListRow(b, cyboInfo)),
      },
    });
  }

  // One agent-list row from a binding + the cybo info map. Extracted from the
  // inline map callback so the per-row optional-chaining stays under the
  // complexity cap.
  private toAgentListRow(
    b: StoredAgentBinding,
    cyboInfo: Map<string, { name: string; avatar: string | null }>,
  ): Record<string, unknown> {
    const live = this.agentManager?.getAgent(b.agent_id);
    const info = b.cybo_id ? cyboInfo.get(b.cybo_id) : undefined;
    return {
      agentId: b.agent_id,
      provider: b.provider,
      channelId: b.channel_id,
      cyboId: b.cybo_id,
      cyboName: info?.name ?? null,
      cyboAvatar: info?.avatar ?? null,
      initiatedBy: b.initiated_by,
      // The local SQLite id space differs per daemon, so a CROSS-daemon viewer
      // (e.g. R listing sessions on S's daemon) can't compare initiatedBy (S's
      // local id for R) to its own cloud account id. Carry the initiator's EMAIL
      // — the stable cross-namespace identity — so the relay can resolve it to the
      // viewer's GLOBAL account id and group the row under "You" (cross-daemon
      // initiated_by bridge, mirrors the agent_prompt_forward fromEmail idiom).
      initiatedByEmail: b.initiated_by
        ? (this.storage.getUserById(b.initiated_by)?.email ?? null)
        : null,
      ...this.liveAgentFields(b, live),
      daemonLocal: live != null,
      daemonId: b.daemon_id ?? this.serverId,
    };
  }

  // Runtime (live) fields for an agent row, falling back to the persisted binding
  // when the agent isn't running locally. Split out of toAgentListRow so neither
  // method's optional chaining exceeds the complexity cap.
  private liveAgentFields(
    b: StoredAgentBinding,
    live: ManagedAgent | null | undefined,
  ): Record<string, unknown> {
    if (!live) {
      return {
        lifecycle: "unknown",
        model: b.model ?? null,
        modeId: null,
        availableModes: [] as unknown[],
        thinkingOptionId: null,
        cwd: b.cwd ?? null,
      };
    }
    const attention = live.attention;
    return {
      lifecycle: live.lifecycle ?? "unknown",
      model: live.config.model ?? b.model ?? null,
      modeId: live.currentModeId ?? null,
      availableModes: live.availableModes ?? [],
      thinkingOptionId: live.runtimeInfo?.thinkingOptionId ?? live.config.thinkingOptionId ?? null,
      cwd: live.cwd ?? b.cwd ?? null,
      // #591: surface the daemon's derived attention flag on the LIST row (not
      // just fetch_agent_state) so the agents list can badge a finished/errored
      // background agent. Same projection as handleFetchAgentState. Only emitted
      // for a live agent — the persisted binding has no runtime attention state.
      ...(attention?.requiresAttention
        ? {
            attention: {
              requiresAttention: true as const,
              reason: attention.attentionReason,
            },
          }
        : {}),
    };
  }

  // Daemon-owner audit listing (#993). Lists ALL sessions bound to ONE daemon —
  // including ephemeral/internal summons and OTHER users' — gated on the `admin`
  // daemon scope. PURELY ADDITIVE: handleListAgents and its !ephemeral / caller
  // filters are untouched; this never feeds the scoped chat sidebar.
  private async handleListDaemonSessions(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListDaemonSessionsRequestSchema.parse(msg);
    if (!(await this.auditGatePasses(parsed.workspaceId, parsed.daemonId, auth))) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Daemon audit requires the admin scope on this daemon.",
        },
      });
      return;
    }
    // ALL bindings on this daemon — NO !ephemeral filter and NO caller filter (the
    // two scopings handleListAgents applies). daemon_id is null for sessions on the
    // local daemon, so fall back to serverId before comparing.
    const localDaemonId = this.serverId;
    const bindings = this.storage
      .getAgentsByWorkspace(parsed.workspaceId)
      .filter((b) => (b.daemon_id ?? localDaemonId) === parsed.daemonId);
    const cyboInfo = await this.buildCyboInfoMap(parsed.workspaceId);
    emit({
      type: "cyborg:list_daemon_sessions_response",
      payload: {
        requestId: parsed.requestId,
        daemonId: parsed.daemonId,
        sessions: bindings.map((b) => this.toDaemonSessionAuditRow(b, cyboInfo)),
      },
    });
  }

  // The audit gate: the daemon `admin` scope (owner holds the full scope set
  // implicitly, so this also admits the owner). Solo / single-tenant mode has no
  // shared daemon-access store — the local caller IS the host user, so permit.
  private async auditGatePasses(
    workspaceId: string,
    daemonId: string,
    auth: CyborgAuthContext,
  ): Promise<boolean> {
    const pg = this.storage.pg;
    if (!pg) return true;
    const scopes = await pg.getUserDaemonScopes(workspaceId, daemonId, auth.user.id);
    return scopes.has("admin");
  }

  // An audit row = the agent-list row (reuses initiatedBy/initiatedByEmail/cybo
  // denorm + liveAgentFields) PLUS the `ephemeral`/`internal` badges the sidebar's
  // scoped rows deliberately omit.
  private toDaemonSessionAuditRow(
    b: StoredAgentBinding,
    cyboInfo: Map<string, { name: string; avatar: string | null }>,
  ): Record<string, unknown> {
    const live = this.agentManager?.getAgent(b.agent_id);
    const row = this.toAgentListRow(b, cyboInfo);
    row.ephemeral = b.ephemeral === 1;
    row.internal = live?.internal ?? false;
    return row;
  }

  private async handleListProviders(msg: CyborgMsg, emit: EmitFn): Promise<void> {
    const parsed = CyborgListProvidersRequestSchema.parse(msg);
    if (!this.providerRegistry) {
      emit({
        type: "cyborg:list_providers_response",
        payload: { requestId: parsed.requestId, providers: [] },
      });
      return;
    }

    const providers = await Promise.all(
      Object.entries(this.providerRegistry).map(async ([id, def]) => {
        let available = false;
        let models: { id: string; label?: string; isDefault?: boolean }[] = [];
        let unavailableReason: string | null = null;
        let reasonKind: ReturnType<typeof classifyProviderError>["kind"] | null = null;
        try {
          const client = def.createClient(
            // minimal logger for availability check
            {
              info: () => {},
              warn: () => {},
              error: () => {},
              debug: () => {},
              child: () => ({}) as never,
            } as never,
          );
          available = await client.isAvailable();
          // Native harness (claude/codex) availability is a HALF-TRUTH: Paseo's
          // isAvailable() only verifies the binary launches, NOT that the host is
          // logged in (internal docs). A logged-OUT-but-installed harness
          // would report available → a native cybo reads "Configured" → the first
          // turn dies with an auth error. Augment with a cheap, read-only login
          // probe so logged-out flips to not-available + a Connect remedy.
          if (available && isNativeHarnessProvider(id)) {
            const login = await probeNativeHarnessLogin(id);
            if (login.state === "logged_out") {
              available = false;
              unavailableReason = login.reason;
              reasonKind = "not_configured";
            }
          }
          if (available) {
            const fetched = await def.fetchModels({ cwd: process.env.HOME ?? ".", force: false });
            models = fetched.map((m) => ({ id: m.id, label: m.label, isDefault: m.isDefault }));
          } else if (unavailableReason === null && client.getDiagnostic) {
            // Not available — surface the EXACT reason (the runtime's auth output)
            // so the UI shows the right remedy instead of a generic "not connected".
            const classified = classifyProviderError((await client.getDiagnostic()).diagnostic);
            unavailableReason = classified.reason;
            reasonKind = classified.kind;
          }
        } catch (err) {
          available = false;
          const classified = classifyProviderError(
            err instanceof Error ? err.message : String(err),
          );
          unavailableReason = classified.reason;
          reasonKind = classified.kind;
        }
        return {
          id,
          label: def.label,
          description: def.description,
          available,
          models,
          modes: def.modes.map((m) => ({ id: m.id, label: m.label, description: m.description })),
          defaultModeId: def.defaultModeId,
          unavailableReason,
          reasonKind,
        };
      }),
    );

    emit({
      type: "cyborg:list_providers_response",
      payload: { requestId: parsed.requestId, providers },
    });
  }

  private async handleListMembers(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListMembersRequestSchema.parse(msg);
    const members = this.workspaceManager.getMembers(parsed.workspaceId);
    emit({
      type: "cyborg:list_members_response",
      payload: {
        requestId: parsed.requestId,
        members: members.map((m) => ({
          userId: m.user_id,
          email: m.email,
          name: m.name,
          role: m.role,
          joinedAt: m.joined_at,
        })),
      },
    });
  }

  private async handleAgentPermissionResponse(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgAgentPermissionResponseSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    this.messageRouter.respondToPermission(
      parsed.agentId,
      parsed.permissionRequestId,
      parsed.response,
    );
    emit({
      type: "cyborg:agent_permission_response_ack",
      payload: { requestId: parsed.requestId, status: "sent" },
    });
  }

  private async handleCancelAgent(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCancelAgentSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    this.messageRouter.cancelAgent(parsed.agentId);
    emit({
      type: "cyborg:cancel_agent_ack",
      payload: { requestId: parsed.requestId, status: "canceling" },
    });
  }

  // #591: clear an agent's derived attention flag (viewed → dismiss). Routes
  // through the message router so it reaches whichever daemon owns the agent
  // (local or peer). Fire-and-forget: the daemon re-broadcasts the cleared
  // state; no response payload is needed (and the binding-guard mirrors cancel).
  private async handleClearAttention(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgClearAttentionSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    this.messageRouter.clearAgentAttention(parsed.agentId);
  }

  private async handleSetAgentModel(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetAgentModelSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      await this.ensureAgentLoaded(parsed.agentId);
      await this.agentManager.setAgentModel(parsed.agentId, parsed.modelId);
      this.storage.updateAgentBindingModel(parsed.agentId, parsed.modelId ?? null);
      emit({
        type: "cyborg:set_agent_model_response",
        payload: { requestId: parsed.requestId, status: "ok" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to set model",
        },
      });
    }
  }

  // 'Rewind to here' (#649): expose Paseo's per-provider session rewind for cybos.
  // Mirrors handleSetAgentModel — same binding/agent-manager guards — but invokes
  // Paseo's agentManager.rewind, which truncates the provider's session history to
  // the target turn (and resets timeline state). `messageId` is the Paseo timeline
  // user-message id; default mode is "conversation" (the only mode pi/cybos
  // support — Claude additionally supports files/both).
  private async handleRewindAgent(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRewindAgentSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      await this.ensureAgentLoaded(parsed.agentId);
      await this.agentManager.rewind(
        parsed.agentId,
        parsed.messageId,
        parsed.mode ?? "conversation",
      );
      emit({
        type: "cyborg:rewind_agent_response",
        payload: { requestId: parsed.requestId, status: "ok" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to rewind agent",
        },
      });
    }
  }

  // Reload/restart a session in place (#592): recover a wedged/desynced agent
  // without losing its identity. Mirrors handleRewindAgent's guards but invokes
  // Paseo's agentManager.reloadAgentSession — cancels any in-flight run, then
  // closes + resumes/recreates the session keeping the same agentId. With
  // rehydrateFromDisk it wipes the in-memory timeline, mints a new epoch and
  // re-streams provider history (the wedged-after-reconnect case). The fresh
  // stream re-broadcasts to the workspace via the existing agent_stream hook.
  private async handleReloadSession(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgReloadSessionSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      await this.ensureAgentLoaded(parsed.agentId);
      await this.agentManager.reloadAgentSession(parsed.agentId, undefined, {
        rehydrateFromDisk: parsed.rehydrateFromDisk ?? false,
      });
      emit({
        type: "cyborg:reload_session_response",
        payload: { requestId: parsed.requestId, status: "ok" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to reload session",
        },
      });
    }
  }

  private async handleSetAgentMode(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetAgentModeSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      await this.ensureAgentLoaded(parsed.agentId);
      await this.agentManager.setAgentMode(parsed.agentId, parsed.modeId);
      emit({
        type: "cyborg:set_agent_mode_response",
        payload: { requestId: parsed.requestId, status: "ok" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to set mode",
        },
      });
    }
  }

  private async handleSetAgentThinking(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetAgentThinkingSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      await this.ensureAgentLoaded(parsed.agentId);
      await this.agentManager.setAgentThinkingOption(parsed.agentId, parsed.thinkingOptionId);
      emit({
        type: "cyborg:set_agent_thinking_response",
        payload: { requestId: parsed.requestId, status: "ok" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to set thinking option",
        },
      });
    }
  }

  private async handleListCommands(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListCommandsSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    try {
      const agent = await this.ensureAgentLoaded(parsed.agentId);
      if (!agent) {
        emit({
          type: "cyborg:error",
          payload: {
            requestId: parsed.requestId,
            code: "not_found",
            message: "Agent not running",
          },
        });
        return;
      }
      // Prefer the LIVE session's commands (provider-driven, rich — e.g. /clear,
      // /compact, custom commands) like Paseo's session.ts does. listDraftCommands
      // queries a throwaway config-only session and returns [] for providers like
      // PI, which is why slash autocomplete showed nothing. Fall back to the draft
      // list only when there's no live session to ask.
      const commands = agent.session?.listCommands
        ? await agent.session.listCommands()
        : await this.agentManager.listDraftCommands(agent.config);
      emit({
        type: "cyborg:list_commands_response",
        payload: {
          requestId: parsed.requestId,
          commands: commands.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          })),
        },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to list commands",
        },
      });
    }
  }

  // #581: @-file/dir autocomplete. Search the agent's workspace cwd for file +
  // directory entries matching the text typed after `@`. We read the cwd from the
  // agent binding (no live session needed — the suggestions are pure FS lookups),
  // mirroring Paseo's directory_suggestions_request handler. Empty/no-cwd → empty
  // list (never an error, so the composer just shows nothing rather than a toast).
  private async handleDirectorySuggestions(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDirectorySuggestionsSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found in workspace",
        },
      });
      return;
    }
    const cwd = binding.cwd?.trim();
    if (!cwd) {
      emit({
        type: "cyborg:directory_suggestions_response",
        payload: { requestId: parsed.requestId, entries: [], error: null },
      });
      return;
    }
    try {
      const entries = await searchWorkspaceEntries({
        cwd: expandTilde(cwd),
        query: parsed.query,
        limit: 20,
        includeFiles: true,
        includeDirectories: true,
      });
      emit({
        type: "cyborg:directory_suggestions_response",
        payload: {
          requestId: parsed.requestId,
          entries: entries.map((e) => ({ path: e.path, kind: e.kind })),
          error: null,
        },
      });
    } catch (err) {
      emit({
        type: "cyborg:directory_suggestions_response",
        payload: {
          requestId: parsed.requestId,
          entries: [],
          error: err instanceof Error ? err.message : "Failed to search workspace",
        },
      });
    }
  }

  private async handleSendAgentPrompt(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSendAgentPromptRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_agent_prompt",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot prompt agent",
        },
      });
      return;
    }
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Agent not found",
        },
      });
      return;
    }
    if (binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Agent not in this workspace",
        },
      });
      return;
    }

    // A session is PRIVATE (promptable only by its initiator) unless it is a SHARED
    // channel agent — i.e. channel-bound AND non-ephemeral. DM agents (no channel)
    // and EPHEMERAL channel summons (@-mentions / slash commands) are private to the
    // user who started them: a non-initiator must not be able to drive someone
    // else's mention session (the ownership leak this guard also protects on read).
    const isSharedChannelAgent = !!binding.channel_id && binding.ephemeral !== 1;
    if (!isSharedChannelAgent && binding.initiated_by && binding.initiated_by !== auth.user.id) {
      // binding.initiated_by is a LOCAL SQLite id; auth.user.id can be a CLOUD id
      // for the same person (divergent namespaces). Bridge by email — only reject
      // when it's genuinely a different account.
      const initiator = this.storage.getUserById(binding.initiated_by);
      const sameUser =
        !!initiator?.email && !!auth.user.email && initiator.email === auth.user.email;
      if (!sameUser) {
        emit({
          type: "cyborg:error",
          payload: {
            requestId: parsed.requestId,
            code: "forbidden",
            message: "This is a private agent session",
          },
        });
        return;
      }
    }

    const targetDaemonId = binding.daemon_id ?? this.serverId;
    if (targetDaemonId) {
      const pg = this.storage.pg;
      if (pg) {
        const canAccess = await pg.canUserAccessDaemon(
          parsed.workspaceId,
          targetDaemonId,
          auth.user.id,
        );
        if (!canAccess) {
          emit({
            type: "cyborg:error",
            payload: {
              requestId: parsed.requestId,
              code: "forbidden",
              message: "You don't have access to agents on this daemon",
            },
          });
          return;
        }
      }
    }

    const promptText = `[DM from ${auth.user.name ?? auth.user.email}]: ${parsed.prompt}`;
    // #579: fold image/file attachments into the prompt. Images become vision
    // content blocks for Claude; text files become excerpts; non-vision
    // providers get a text reference. No attachments → plain string (unchanged).
    const prompt = await buildAgentPrompt({
      text: promptText,
      attachments: parsed.attachments,
      supportsImageBlocks: binding.provider === "claude",
    });

    try {
      await this.messageRouter.routeToAgent(parsed.agentId, prompt, {
        rawPrompt: parsed.prompt,
      });
      emit({
        type: "cyborg:send_agent_prompt_response",
        payload: { requestId: parsed.requestId, status: "routed" },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to route prompt to agent",
        },
      });
    }
  }

  private async handleListDaemons(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListDaemonsRequestSchema.parse(msg);
    const ws = auth.workspaces.find((w) => w.id === parsed.workspaceId);
    if (!ws) {
      emit({
        type: "cyborg:error",
        payload: {
          code: "not_found",
          message: "Workspace not found",
          requestId: parsed.requestId,
        },
      });
      return;
    }

    const pg = this.storage.pg;
    let daemons = pg ? await pg.getDaemonsForWorkspace(parsed.workspaceId) : [];

    if (this.serverId && !daemons.some((d) => d.id === this.serverId)) {
      const hostname = await import("node:os").then((os) => os.hostname());
      daemons = [
        {
          id: this.serverId,
          label: hostname,
          ownerId: this.daemonOwnerId ?? "unclaimed",
          status: "online",
          lastSeenAt: Date.now(),
          meta: null,
        },
        ...daemons,
      ];
      if (pg) {
        pg.ensureWorkspaceDaemon(parsed.workspaceId, this.serverId).catch((err) => {
          this.logger?.error({ err }, "[CyborgDispatcher] ensureWorkspaceDaemon failed");
        });
      }
    }

    // Workspace-level slash config (admin-controlled, #opt-A) so the settings UI
    // can render it without a second call. Degrade to undefined on a PG miss.
    let workspaceSlashConfig:
      | {
          defaultSlashDaemonId: string | null;
          fallbackDaemons: string[];
          model: { provider: string; model: string } | null;
        }
      | undefined;
    if (this.storage.pg) {
      try {
        workspaceSlashConfig = await this.storage.pg.getWorkspaceSlashConfig(parsed.workspaceId);
      } catch (err) {
        this.logger?.error({ err }, "[list_daemons] getWorkspaceSlashConfig failed (omitting)");
      }
    }

    // Wrap under `payload` so the UI client's request() correlation resolves it:
    // it keys pending RPCs on `payload.requestId` (core/client.ts handleMessage),
    // so a flat top-level `requestId` never resolves and the call times out — which
    // left the local-daemon Fleet/header stuck at "0 of 0" while the relay path
    // (which always nests under `payload` via respond()) worked in prod. Matches
    // list_agents_response's shape.
    emit({
      type: "cyborg:list_daemons_response",
      payload: {
        requestId: parsed.requestId,
        daemons,
        workspaceSlashConfig,
      },
    });
  }

  private async handleSetWorkspaceSlashConfig(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetWorkspaceSlashConfigRequestSchema.parse(msg);
    const respond = (ok: boolean, error?: string, config?: unknown): void => {
      // Flat shape (matches the response schema + the relay handler + list_daemons).
      emit({
        type: "cyborg:set_workspace_slash_config_response",
        requestId: parsed.requestId,
        ok,
        error,
        config,
      });
    };
    // Owner/admin only: managing workspace daemons is an admin capability.
    // "manage_agents" is admin-gated; the explicit role check is belt-and-suspenders.
    const { allowed, role } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "manage_agents",
    );
    if (!allowed || (role !== "owner" && role !== "admin")) {
      respond(false, "only a workspace owner or admin can change the slash AI config");
      return;
    }
    const pg = this.storage.pg;
    if (!pg) {
      respond(false, "workspace slash config requires shared storage");
      return;
    }
    // Referenced daemons must belong to this workspace (no foreign designation).
    const wsDaemonIds = new Set(
      (await pg.getDaemonsForWorkspace(parsed.workspaceId)).map((d) => d.id),
    );
    const config: {
      defaultSlashDaemonId?: string | null;
      fallbackDaemons?: string[];
      model?: string | null;
    } = {};
    if (parsed.defaultSlashDaemonId !== undefined) {
      if (parsed.defaultSlashDaemonId !== null && !wsDaemonIds.has(parsed.defaultSlashDaemonId)) {
        respond(false, "that daemon does not belong to this workspace");
        return;
      }
      config.defaultSlashDaemonId = parsed.defaultSlashDaemonId;
    }
    if (parsed.fallbackDaemons !== undefined) {
      const foreign = parsed.fallbackDaemons.find((d) => !wsDaemonIds.has(d));
      if (foreign) {
        respond(false, `daemon ${foreign} does not belong to this workspace`);
        return;
      }
      config.fallbackDaemons = parsed.fallbackDaemons;
    }
    if (parsed.model !== undefined) config.model = parsed.model;
    // Daemon-access matrix (same gate as the spawn path): slash commands RUN on
    // the designated daemon, so introducing one requires owning it or holding a
    // daemon_access grant — admin role alone is not enough.
    const inaccessible = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: parsed.workspaceId,
      userId: auth.user.id,
      requested: config,
      current: await pg.getWorkspaceSlashConfig(parsed.workspaceId),
    });
    if (inaccessible) {
      respond(false, slashDaemonAccessError(inaccessible));
      return;
    }
    await pg.setWorkspaceSlashConfig(parsed.workspaceId, config);
    respond(true, undefined, await pg.getWorkspaceSlashConfig(parsed.workspaceId));
  }

  // Read-back for the AI settings tab. Any workspace member may read; without
  // shared storage (solo daemon) there's nothing to read → return empty defaults.
  private async handleGetWorkspaceSlashConfig(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgGetWorkspaceSlashConfigRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    const pg = this.storage.pg;
    const config =
      allowed && pg
        ? await pg.getWorkspaceSlashConfig(parsed.workspaceId)
        : { defaultSlashDaemonId: null, fallbackDaemons: [] as string[], model: null };
    emit({
      type: "cyborg:get_workspace_slash_config_response",
      requestId: parsed.requestId,
      config,
    });
  }

  // ─── Daemon Access ──────────────────────────────────────────────────

  private handleFetchDaemonInfo(msg: CyborgMsg, emit: EmitFn): undefined {
    const parsed = CyborgFetchDaemonInfoRequestSchema.parse(msg);
    emit({
      type: "cyborg:fetch_daemon_info_response",
      requestId: parsed.requestId,
      daemonId: this.serverId,
      ownerId: this.daemonOwnerId,
    });
    return undefined;
  }

  private async handleGrantDaemonAccess(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgGrantDaemonAccessRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === parsed.daemonId,
    );
    if (!daemon || daemon.ownerId !== auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the daemon owner can grant access",
        },
      });
      return;
    }

    await pg.grantDaemonAccess(parsed.workspaceId, parsed.daemonId, parsed.userId, auth.user.id);
    emit({
      type: "cyborg:grant_daemon_access_response",
      requestId: parsed.requestId,
      granted: true,
    });
  }

  // Idempotent scoped set (#705): local-daemon-mode mirror of the relay's
  // set_daemon_access. Owner-only (same gate as grant/revoke). Empty scopes
  // revoke; targeting the owner is rejected (owner is implicit admin).
  private async handleSetDaemonAccess(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetDaemonAccessRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === parsed.daemonId,
    );
    if (!daemon || daemon.ownerId !== auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the daemon owner can manage access",
        },
      });
      return;
    }
    if (parsed.userId === daemon.ownerId) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "invalid",
          message: "The daemon owner already has full access",
        },
      });
      return;
    }

    await pg.setDaemonAccess(
      parsed.workspaceId,
      parsed.daemonId,
      parsed.userId,
      parsed.scopes,
      auth.user.id,
    );
    emit({
      type: "cyborg:set_daemon_access_response",
      requestId: parsed.requestId,
      ok: true,
      daemonId: parsed.daemonId,
      userId: parsed.userId,
      scopes: parsed.scopes,
    });
  }

  private async handleRevokeDaemonAccess(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRevokeDaemonAccessRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === parsed.daemonId,
    );
    if (!daemon || daemon.ownerId !== auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the daemon owner can revoke access",
        },
      });
      return;
    }

    await pg.revokeDaemonAccess(parsed.workspaceId, parsed.daemonId, parsed.userId);
    emit({
      type: "cyborg:revoke_daemon_access_response",
      requestId: parsed.requestId,
      revoked: true,
    });
  }

  // Rename a daemon (#441) — owner-only; renameDaemon sets the sticky
  // label_user_set flag so hello upserts never overwrite the new name.
  private async handleRenameDaemon(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRenameDaemonRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === parsed.daemonId,
    );
    if (!daemon || daemon.ownerId !== auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the daemon owner can rename it",
        },
      });
      return;
    }

    await pg.renameDaemon(parsed.daemonId, parsed.label);
    emit({
      type: "cyborg:rename_daemon_response",
      requestId: parsed.requestId,
      daemonId: parsed.daemonId,
      label: parsed.label,
    });
  }

  private async handleFetchDaemonAccess(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchDaemonAccessRequestSchema.parse(msg);
    const ws = auth.workspaces.find((w) => w.id === parsed.workspaceId);
    if (!ws) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Workspace not found" },
      });
      return;
    }

    const pg = this.storage.pg;
    const accessList = pg ? await pg.getDaemonAccessForWorkspace(parsed.workspaceId) : [];
    // Wrap under `payload` (same reason as list_daemons_response): the UI client
    // resolves request() on `payload.requestId`, so a flat shape times out and the
    // Fleet card's member counts (daemonState.accessUserIds) never populate locally.
    emit({
      type: "cyborg:fetch_daemon_access_response",
      payload: {
        requestId: parsed.requestId,
        access: accessList,
      },
    });
  }

  // ─── Daemon Access Requests (#705 REQUEST → NOTIFY → APPROVE) ──────────
  //
  // Local-daemon-mode mirror of the relay's request/resolve/fetch handlers. Same
  // pg CRUD + messageRouter activity/push, so behavior is identical to the cloud
  // path. Owner gating is daemon.ownerId === auth.user.id (same as grant/revoke).

  private async handleRequestDaemonAccess(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRequestDaemonAccessRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === parsed.daemonId,
    );
    if (!daemon) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Daemon not found in this workspace",
        },
      });
      return;
    }
    // The owner is implicitly admin — a request from them is meaningless.
    if (daemon.ownerId === auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "invalid",
          message: "You already own this daemon",
        },
      });
      return;
    }

    // A request must name at least one scope — an empty request would normalize
    // to admin and silently over-ask (unlike set_daemon_access, where empty=revoke).
    if (!parsed.scopes || parsed.scopes.length === 0) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "invalid",
          message: "A request must include at least one access scope",
        },
      });
      return;
    }
    const requesterName = auth.user.name ?? auth.user.email ?? null;
    const reqScopes = [...normalizeScopes(parsed.scopes)];
    const created = await pg.createDaemonAccessRequest({
      workspaceId: parsed.workspaceId,
      daemonId: parsed.daemonId,
      requesterId: auth.user.id,
      requesterName,
      scopes: reqScopes,
    });
    const requestPayload = serializeDaemonAccessRequest(created);

    // Notify the OWNER: activity row (badge) + live request-changed push.
    const preview = `${requesterName ?? "Someone"} requested ${roleForScopes(
      reqScopes,
    )} access to ${daemon.label}`;
    this.messageRouter.emitDaemonActivity(daemon.ownerId, {
      workspaceId: parsed.workspaceId,
      eventType: "daemon_access_request",
      sourceId: created.id,
      previewText: preview,
      actorId: auth.user.id,
      actorName: requesterName,
    });
    this.messageRouter.pushToUser(daemon.ownerId, {
      type: "cyborg:daemon_access_request_changed",
      payload: { request: requestPayload },
    });

    // Wrap under `payload` (same reason as fetch_daemon_access_response): the UI
    // client resolves request() on payload.requestId, so a flat shape times out.
    emit({
      type: "cyborg:request_daemon_access_response",
      payload: { requestId: parsed.requestId, request: requestPayload },
    });
  }

  private async handleResolveDaemonAccessRequest(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgResolveDaemonAccessRequestRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "unavailable", message: "No PG" },
      });
      return;
    }

    const request = await pg.getDaemonAccessRequestById(parsed.requestIdToResolve);
    if (!request || request.workspaceId !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Request not found" },
      });
      return;
    }
    if (request.status !== "pending") {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "invalid",
          message: "Request already resolved",
        },
      });
      return;
    }
    const daemon = (await pg.getDaemonsForWorkspace(parsed.workspaceId)).find(
      (d) => d.id === request.daemonId,
    );
    // OWNER-ONLY gate.
    if (!daemon || daemon.ownerId !== auth.user.id) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Only the daemon owner can resolve access requests",
        },
      });
      return;
    }

    let grantedScopes: DaemonScope[] = [...normalizeScopes(request.scopes)];
    if (parsed.decision === "approve" && parsed.scopes !== undefined) {
      grantedScopes = [...normalizeScopes(parsed.scopes)];
    }
    // Resolve FIRST (atomic, pending-only), then grant ONLY if we won the race —
    // resolved === null means another admin already resolved it, so we must not
    // grant again (prevents a double grant on concurrent approvals).
    const resolved = await pg.resolveDaemonAccessRequest(
      parsed.requestIdToResolve,
      parsed.decision === "approve" ? "approved" : "denied",
      auth.user.id,
    );
    if (parsed.decision === "approve" && resolved) {
      await pg.setDaemonAccess(
        parsed.workspaceId,
        request.daemonId,
        request.requesterId,
        grantedScopes,
        auth.user.id,
      );
    }
    // resolveDaemonAccessRequest returns null only if the row vanished between the
    // load and the update (concurrent delete) — fall back to the loaded row with
    // the new status so the response/push still carries a complete row.
    const resolvedRow = resolved ?? {
      ...request,
      status: parsed.decision === "approve" ? "approved" : "denied",
      resolvedBy: auth.user.id,
      resolvedAt: new Date(),
    };
    const resolvedPayload = serializeDaemonAccessRequest(resolvedRow);

    // Notify the REQUESTER: activity row + live request-changed push.
    const preview =
      parsed.decision === "approve"
        ? `Your request for ${roleForScopes(grantedScopes)} access to ${daemon.label} was approved`
        : `Your request for access to ${daemon.label} was denied`;
    this.messageRouter.emitDaemonActivity(request.requesterId, {
      workspaceId: parsed.workspaceId,
      eventType: "daemon_access_request_resolved",
      sourceId: request.id,
      previewText: preview,
      actorId: auth.user.id,
      // Resolver's display name so the feed shows a human name, not the raw UUID
      // (the UI falls back to actor_id when actor_name is null).
      actorName: auth.user.name ?? auth.user.email ?? null,
    });
    this.messageRouter.pushToUser(request.requesterId, {
      type: "cyborg:daemon_access_request_changed",
      payload: { request: resolvedPayload },
    });
    // On approve, push the access change so the requester's daemonState refreshes.
    if (parsed.decision === "approve") {
      this.messageRouter.pushToUser(request.requesterId, {
        type: "cyborg:set_daemon_access_response",
        payload: {
          ok: true,
          daemonId: request.daemonId,
          userId: request.requesterId,
          scopes: grantedScopes,
        },
      });
    }

    // Wrap under `payload` (same reason as fetch_daemon_access_response): the UI
    // client resolves request() on payload.requestId.
    emit({
      type: "cyborg:resolve_daemon_access_request_response",
      payload: { requestId: parsed.requestId, request: resolvedPayload },
    });
  }

  private async handleFetchDaemonAccessRequests(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchDaemonAccessRequestsRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      // No PG (solo mode) → no shared requests; return an empty list, wrapped
      // under payload so the UI client resolves request() on payload.requestId
      // (same reason as fetch_daemon_access_response above).
      emit({
        type: "cyborg:fetch_daemon_access_requests_response",
        payload: { requestId: parsed.requestId, requests: [] },
      });
      return;
    }

    const pending = await pg.listDaemonAccessRequests(parsed.workspaceId, { status: "pending" });
    const wsDaemons = await pg.getDaemonsForWorkspace(parsed.workspaceId);
    const ownedDaemonIds = new Set(
      wsDaemons.filter((d) => d.ownerId === auth.user.id).map((d) => d.id),
    );
    // Owner inbox + requester outbox: requests for daemons I own, plus my own.
    const visible = pending.filter(
      (r) => ownedDaemonIds.has(r.daemonId) || r.requesterId === auth.user.id,
    );
    emit({
      type: "cyborg:fetch_daemon_access_requests_response",
      payload: {
        requestId: parsed.requestId,
        requests: visible.map(serializeDaemonAccessRequest),
      },
    });
  }

  // ─── Pairing ────────────────────────────────────────────────────────

  private handleGetPairingInfo(msg: CyborgMsg, emit: EmitFn): undefined {
    const parsed = CyborgGetPairingInfoSchema.parse(msg);
    if (!this.pairingOffer) {
      emit({
        type: "cyborg:get_pairing_info_response",
        payload: {
          requestId: parsed.requestId,
          available: false,
        },
      });
      return undefined;
    }
    emit({
      type: "cyborg:get_pairing_info_response",
      payload: {
        requestId: parsed.requestId,
        available: true,
        offer: this.pairingOffer,
      },
    });
    return undefined;
  }

  private handleDevToken(msg: CyborgMsg, emit: EmitFn): undefined {
    if (!this.cyborgAuth) {
      emit({
        type: "cyborg:error",
        payload: { code: "internal", message: "Auth service not configured" },
      });
      return undefined;
    }
    const parsed = CyborgDevTokenRequestSchema.parse(msg);
    const token = this.cyborgAuth.createToken(parsed.email, parsed.name);
    const requestId = parsed.requestId;
    emit({
      type: "cyborg:dev_token_response",
      payload: { requestId, token },
    });
    return undefined;
  }

  // ─── Provider credential handlers (per-daemon store, internal docs) ──
  //
  // Daemon-scoped: the credential lives in this daemon's encrypted file. The relay
  // forwards these by `daemonId` and never sees the secret. Setting a credential is
  // a privileged action, gated on the same "create_agent" admin gate as create_cybo.
  // SECRET HYGIENE: never log the secret; never echo it in any response.

  private async handleSetCyboCredential(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetCyboCredentialRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot set provider credential",
        },
      });
      return;
    }
    try {
      await this.credentialStore.setCredential(parsed.providerId, parsed.credential, {
        sink: this.messageRouter.auditSink,
        workspaceId: parsed.workspaceId,
        userId: auth.user.id,
      });
    } catch {
      // Never surface the secret in the error path; log only provider + type.
      this.logger?.warn(
        { providerId: parsed.providerId, type: parsed.credential.type },
        "cyborg: set_cybo_credential failed",
      );
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "internal",
          message: "Failed to store provider credential",
        },
      });
      return;
    }
    emit({
      type: "cyborg:set_cybo_credential_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleRemoveCyboCredential(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRemoveCyboCredentialRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot remove provider credential",
        },
      });
      return;
    }
    try {
      await this.credentialStore.removeCredential(parsed.providerId, {
        sink: this.messageRouter.auditSink,
        workspaceId: parsed.workspaceId,
        userId: auth.user.id,
      });
    } catch {
      this.logger?.warn({ providerId: parsed.providerId }, "cyborg: remove_cybo_credential failed");
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "internal",
          message: "Failed to remove provider credential",
        },
      });
      return;
    }
    emit({
      type: "cyborg:remove_cybo_credential_response",
      payload: { requestId: parsed.requestId, ok: true },
    });
  }

  private async handleListProviderAuth(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListProviderAuthRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot list provider credentials",
        },
      });
      return;
    }
    // METADATA ONLY — providerId, type, and (oauth) expires. Never the secret.
    const credentials = await this.credentialStore.listCredentialMeta();
    emit({
      type: "cyborg:list_provider_auth_response",
      payload: { requestId: parsed.requestId, credentials },
    });
  }

  // ─── Cybo handlers ─────────────────────────────────────────────────

  private handleCreateCybo(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): undefined {
    const parsed = CyborgCreateCyboRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot create cybo",
        },
      });
      return undefined;
    }

    const cybo = this.storage.createCybo({
      workspaceId: parsed.workspaceId,
      slug: parsed.slug,
      name: parsed.name,
      soul: parsed.soul,
      provider: parsed.provider,
      model: parsed.model,
      description: parsed.description,
      avatar: parsed.avatar,
      role: parsed.role,
      llmAuthMode: parsed.llmAuthMode,
      behaviorMode: parsed.behaviorMode,
      homeDaemonId: parsed.homeDaemonId,
      autonomyLevel: parsed.autonomyLevel,
      monthlySpendCap: parsed.monthlySpendCap,
      platformPermissions: parsed.platformPermissions,
      mcpServers: parsed.mcpServers,
      toolGrants: parsed.toolGrants,
      createdBy: auth.user.id,
    });

    emit({
      type: "cyborg:create_cybo_response",
      payload: {
        requestId: parsed.requestId,
        cybo: {
          id: cybo.id,
          slug: cybo.slug,
          name: cybo.name,
          provider: cybo.provider,
          model: cybo.model,
          isDefault: cybo.is_default === 1,
        },
      },
    });
    return undefined;
  }

  private async handleFetchCybos(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchCybosRequestSchema.parse(msg);
    const dbCybos = this.storage.getCybos(parsed.workspaceId);
    const localCybos = await scanLocalCybos();

    const dbSlugs = new Set(dbCybos.map((c) => c.slug));
    const merged = [...dbCybos, ...localCybos.filter((c) => !dbSlugs.has(c.slug))];

    emit({
      type: "cyborg:fetch_cybos_response",
      payload: {
        requestId: parsed.requestId,
        cybos: merged.map((c) => ({
          id: c.id,
          slug: c.slug,
          name: c.name,
          description: c.description,
          avatar: c.avatar,
          role: c.role,
          provider: c.provider,
          model: c.model,
          llmAuthMode: c.llm_auth_mode,
          behaviorMode: c.behavior_mode,
          homeDaemonId: c.home_daemon_id,
          autonomyLevel: c.autonomy_level,
          monthlySpendCap: c.monthly_spend_cap,
          platformPermissions: parseStringArray(c.platform_permissions),
          isDefault: c.is_default === 1,
          createdAt: c.created_at,
          // Provenance: a local (disk) cybo can ONLY spawn on this daemon's
          // machine. The client must target daemonId when starting it — sending
          // the spawn to another daemon ends in "Cybo not found" (the relay
          // can't enrich a cybo that isn't in PG).
          isLocal: c.id.startsWith("local:"),
          daemonId: c.id.startsWith("local:") ? (this.serverId ?? null) : null,
          // Server-computed "last active" (epoch ms). On this SQLite/daemon path
          // it's always null — local agent_sessions carry no cybo_id/updated_at
          // and are never written (see CyborgStorage.getCybos); the relay merges
          // PG's real value over workspace cybos. local: disk cybos have no
          // session row either, so null is correct there too.
          lastActiveAt: c.last_active_at ?? null,
        })),
      },
    });
    return undefined;
  }

  // Single cybo WITH soul (the editor's lazy-load). TOLERANT resolution: exact
  // id, then a workspace cybo by slug (covers a `local:<slug>` or bare-slug id
  // the client holds from a pre-merge roster), then a local (disk) cybo by
  // id/slug — soul is read off disk by resolveLocalCybo. A STRICT id lookup
  // returned `cybo: null` whenever the roster id didn't match the answering
  // daemon's local id (PG `cybo_…` vs `local:<slug>` vs not-on-this-daemon),
  // which surfaced as "The daemon answered but didn't return this cybo" in the
  // personality editor. Mirrors resolveCybo, the tolerant resolver the mutation
  // handlers already use. (PG-only cybos absent on this daemon are enriched by
  // the relay's fetch_cybo_response PG fallback.)
  private async handleFetchCybo(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchCyboRequestSchema.parse(msg);
    // TOLERANT resolution (mirrors resolveWorkspaceCybo, used by the mutation
    // handlers): exact id, then a workspace cybo by slug — STRIPPING a `local:`
    // prefix first so a `local:<slug>` roster id resolves to the `cybo_…` row —
    // then a disk cybo by id/slug. The strict id lookup returned `cybo: null`
    // whenever the roster id didn't match the answering daemon's local id (PG
    // `cybo_…` vs `local:<slug>` vs not-on-this-daemon).
    const lookupSlug = parsed.cyboId.startsWith("local:")
      ? parsed.cyboId.slice("local:".length)
      : parsed.cyboId;
    const cybo =
      this.storage.getCybo(parsed.cyboId) ??
      this.storage.getCyboBySlug(parsed.workspaceId, lookupSlug) ??
      // intentional: a disk-read failure = "no local cybo by this id"; the editor then shows not-found (or the relay PG fallback fills it in)
      (await resolveLocalCybo(parsed.cyboId).catch(() => undefined));
    // isLocal = a disk (`local:`) cybo with no workspace-DB row. A workspace cybo
    // resolves out of storage (by id or slug); a disk cybo only resolves via the
    // local fallback and carries a `local:` id.
    const isDbCybo =
      !!cybo &&
      !cybo.id.startsWith("local:") &&
      !!(
        this.storage.getCybo(cybo.id) ?? this.storage.getCyboBySlug(parsed.workspaceId, cybo.slug)
      );
    emit({
      type: "cyborg:fetch_cybo_response",
      payload: {
        requestId: parsed.requestId,
        cybo: cybo
          ? {
              id: cybo.id,
              slug: cybo.slug,
              name: cybo.name,
              description: cybo.description,
              avatar: cybo.avatar,
              role: cybo.role,
              provider: cybo.provider,
              model: cybo.model,
              soul: cybo.soul,
              mcpServers: cybo.mcp_servers
                ? (JSON.parse(cybo.mcp_servers) as Record<string, unknown>)
                : undefined,
              llmAuthMode: cybo.llm_auth_mode,
              behaviorMode: cybo.behavior_mode,
              homeDaemonId: cybo.home_daemon_id,
              autonomyLevel: cybo.autonomy_level,
              monthlySpendCap: cybo.monthly_spend_cap,
              platformPermissions: parseStringArray(cybo.platform_permissions),
              isLocal: !isDbCybo,
              isDefault: cybo.is_default === 1,
              createdAt: cybo.created_at,
            }
          : null,
      },
    });
    return undefined;
  }

  // One-way snapshot: copy a local (disk) cybo — including its soul.md content —
  // into the workspace DB so it becomes editable/shareable. No back-sync.
  private async handleImportCybo(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgImportCyboRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot import cybo" },
      });
      return undefined;
    }

    if (this.storage.getCyboBySlug(parsed.workspaceId, parsed.slug)) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "conflict",
          message: `A cybo with slug "${parsed.slug}" already exists in this workspace`,
        },
      });
      return undefined;
    }

    const local = await resolveLocalCybo(parsed.slug);
    if (!local) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: `No local cybo "${parsed.slug}" found on this daemon`,
        },
      });
      return undefined;
    }

    const cybo = this.storage.createCybo({
      workspaceId: parsed.workspaceId,
      slug: local.slug,
      name: local.name,
      soul: local.soul,
      provider: local.provider,
      model: local.model ?? undefined,
      description: local.description ?? undefined,
      avatar: local.avatar ?? undefined,
      role: local.role ?? undefined,
      // Carry over config/permissions so the import is a faithful snapshot
      // (local cybo.json usually omits these — they fall back to defaults).
      llmAuthMode: local.llm_auth_mode ?? undefined,
      behaviorMode: local.behavior_mode ?? undefined,
      homeDaemonId: local.home_daemon_id ?? undefined,
      autonomyLevel: local.autonomy_level ?? undefined,
      monthlySpendCap: local.monthly_spend_cap,
      platformPermissions: parseStringArray(local.platform_permissions),
      mcpServers: local.mcp_servers
        ? (JSON.parse(local.mcp_servers) as Record<string, unknown>)
        : undefined,
      toolGrants: local.tool_grants
        ? (JSON.parse(local.tool_grants) as Record<string, unknown>)
        : undefined,
      createdBy: auth.user.id,
    });

    emit({
      type: "cyborg:import_cybo_response",
      payload: {
        requestId: parsed.requestId,
        cybo: {
          id: cybo.id,
          slug: cybo.slug,
          name: cybo.name,
          provider: cybo.provider,
          model: cybo.model,
          isDefault: cybo.is_default === 1,
        },
      },
    });
    return undefined;
  }

  // Probe the host `pi` CLI (Cybos run on PI). Daemon-side because the CLI lives
  // on the daemon's machine, not the relay. No npm-latest comparison here — the
  // UI only needs installed/version + an install CTA when missing.
  private async handleCyboCliStatus(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCyboCliStatusRequestSchema.parse(msg);
    const status = await detectPiCli();
    emit({
      type: "cyborg:cybo_cli_status_response",
      payload: { requestId: parsed.requestId, ...status },
    });
    // Passive reconciliation: if the CLI is installed but the boot-time snapshot
    // still says pi unavailable, refresh it (fire-and-forget — don't delay the
    // status response). Cheap + self-bounding; pairs with the agents-pane probe.
    void reconcilePiSnapshotOnStatus(this.providerSnapshotManager, status, this.logger);
  }

  // Settings → Daemon → "Re-check providers": force a snapshot refresh and answer
  // with the settled statuses. Read-only against the host (just re-runs the same
  // availability probes the boot warm-up runs), so no permission gate — any
  // workspace member who can see the daemon can re-check it. Rate-limited
  // though: each call shells out the FULL probe suite, so a raw client must not
  // be able to spam it (the UI single-flights; this is the backstop).
  private async handleRefreshProviders(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRefreshProvidersRequestSchema.parse(msg);
    const rl = this.rateLimiter.check(`${auth.user.id}:${parsed.workspaceId}`, "provider_recheck");
    if (!rl.allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "rate_limited",
          message: "Providers were just re-checked — wait a moment and try again.",
        },
      });
      return;
    }
    const providers = await recheckProviders(this.providerSnapshotManager, this.logger);
    emit({
      type: "cyborg:refresh_providers_response",
      payload: { requestId: parsed.requestId, providers },
    });
  }

  private async handleCyboCliUpdate(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCyboCliUpdateRequestSchema.parse(msg);
    // Running `npm i -g` mutates the daemon host — gate it like other host-affecting
    // ops (create_agent), since this request carries the workspace it targets.
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "You don't have permission to update the cybo runtime on this daemon.",
        },
      });
      return;
    }
    // Route the updater's progress/error output to the daemon logger (#736) —
    // its default sink is console.error, which the supervisor pipes to /dev/null.
    const result = await updateCyboCli({ log: (m) => this.logger?.info(m) });
    // The boot-time provider snapshot still reports pi unavailable until restart;
    // a fresh install just linked `pi` onto PATH. Refresh the Pi snapshot BEFORE
    // responding so the client's post-install re-fetch (and the next cybo-spawn
    // provider-check) sees pi available — no daemon restart needed.
    await refreshPiSnapshotAfterInstall(this.providerSnapshotManager, result, this.logger);
    emit({
      type: "cyborg:cybo_cli_update_response",
      payload: { requestId: parsed.requestId, ...result },
    });
  }

  // Read-only "what's the latest @cyborg7/cybo" check (npm view on the daemon host).
  // No permission gate — it mutates nothing (unlike cybo_cli_update); any member who
  // can see the daemon may check for an update.
  private async handleCyboCliLatest(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCyboCliLatestRequestSchema.parse(msg);
    const result = await latestCyboCliVersion();
    emit({
      type: "cyborg:cybo_cli_latest_response",
      payload: { requestId: parsed.requestId, ...result },
    });
  }

  // Remote daemon self-update (#663): launch #662's `cyborg daemon update`
  // (which restarts this daemon) and ACK "restarting" — the WS is about to drop,
  // so we don't await a new version; it surfaces via the next heartbeat. Gated
  // like cybo_cli_update (host-mutating → create_agent), AND the relay already
  // enforced daemon access (owner/grant) before forwarding.
  private async handleUpdateDaemon(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateDaemonRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "You don't have permission to update this daemon.",
        },
      });
      return;
    }
    const result = runDaemonSelfUpdate(defaultDaemonSelfUpdateDeps);
    emit({
      type: "cyborg:update_daemon_response",
      payload: { requestId: parsed.requestId, ...result },
    });
  }

  private async handleDaemonUpdateLatest(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDaemonUpdateLatestRequestSchema.parse(msg);
    const result = await latestDaemonVersion((cmd, args) =>
      execFileAsync(cmd, args, { timeout: 20_000, shell: process.platform === "win32" }),
    );
    emit({
      type: "cyborg:daemon_update_latest_response",
      payload: { requestId: parsed.requestId, ...result },
    });
  }

  private handleUpdateCybo(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): undefined {
    const parsed = CyborgUpdateCyboRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot update cybo",
        },
      });
      return undefined;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.name !== undefined) updates.name = parsed.name;
    if (parsed.description !== undefined) updates.description = parsed.description;
    if (parsed.avatar !== undefined) updates.avatar = parsed.avatar;
    if (parsed.role !== undefined) updates.role = parsed.role;
    if (parsed.soul !== undefined) updates.soul = parsed.soul;
    if (parsed.provider !== undefined) updates.provider = parsed.provider;
    if (parsed.model !== undefined) updates.model = parsed.model;
    if (parsed.llmAuthMode !== undefined) updates.llmAuthMode = parsed.llmAuthMode;
    if (parsed.behaviorMode !== undefined) updates.behaviorMode = parsed.behaviorMode;
    if (parsed.homeDaemonId !== undefined) updates.homeDaemonId = parsed.homeDaemonId;
    if (parsed.autonomyLevel !== undefined) updates.autonomyLevel = parsed.autonomyLevel;
    if (parsed.monthlySpendCap !== undefined) updates.monthlySpendCap = parsed.monthlySpendCap;
    if (parsed.platformPermissions !== undefined)
      updates.platformPermissions = parsed.platformPermissions;
    if (parsed.mcpServers !== undefined) updates.mcpServers = parsed.mcpServers;
    if (parsed.toolGrants !== undefined) updates.toolGrants = parsed.toolGrants;

    const cybo = this.storage.updateCybo(parsed.cyboId, updates);
    if (!cybo) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "not_found",
          message: "Cybo not found",
        },
      });
      return undefined;
    }

    emit({
      type: "cyborg:update_cybo_response",
      payload: {
        requestId: parsed.requestId,
        cybo: {
          id: cybo.id,
          slug: cybo.slug,
          name: cybo.name,
          provider: cybo.provider,
          model: cybo.model,
        },
      },
    });
    return undefined;
  }

  // Pre-spawn harness gate (internal docs). Returns true when the spawn was
  // REFUSED (the refusal has been emitted); false lets the spawn proceed.
  // Blocks only on explicit unavailability — transient snapshot errors and an
  // unresolvable cybo fall through (spawnCybo raises its established errors).
  //
  // Provider IS the harness: native claude/codex verify the daemon's OWN
  // provider; everything else routes through the Cybo runtime with the
  // per-backend gate (#402) + lazy re-probe (#369/#416) preserved below. Every
  // refusal carries the classified reason (reasonKind/unavailableReason) so the
  // UI shows the EXACT remedy instead of a bare "needs X".
  private async spawnHarnessGateBlocked(
    parsed: {
      requestId: string;
      workspaceId: string;
      cyboIdOrSlug: string;
      resolvedCybo?: unknown;
    },
    emit: EmitFn,
  ): Promise<boolean> {
    if (!this.providerSnapshotManager) return false;
    const refuse = (
      message: string,
      extra?: {
        backend?: string;
        reasonKind?: ReturnType<typeof classifyProviderError>["kind"];
        unavailableReason?: string;
      },
    ): true => {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message,
          ...(extra?.backend ? { backend: extra.backend } : {}),
          ...(extra?.reasonKind ? { reasonKind: extra.reasonKind } : {}),
          ...(extra?.unavailableReason ? { unavailableReason: extra.unavailableReason } : {}),
        },
      });
      return true;
    };
    try {
      // Resolution mirrors the spawn's own (relay-enriched or local).
      const gateCybo =
        (parsed.resolvedCybo as StoredCybo | undefined) ??
        (await resolveCybo(this.storage, parsed.workspaceId, parsed.cyboIdOrSlug).catch(
          () => undefined,
        ));
      const harness = gateCybo
        ? resolveCyboHarness(gateCybo.provider, gateCybo.model)
        : ({ provider: "pi", model: undefined } as const);

      if (harness.provider !== "pi") {
        // NATIVE harness (claude/codex): the daemon's own provider must be
        // available — "Apex runs on Claude — Claude isn't available…". Classify
        // its diagnostic so a usage-gate / expired token surfaces the remedy.
        const entries = await this.providerSnapshotManager.listProviders({
          wait: true,
          providers: [harness.provider],
        });
        const native = entries.find((p) => p.provider === harness.provider);
        if (!native || native.status === "unavailable") {
          const reason = await this.classifyRuntimeGapReason(harness.provider);
          return refuse(
            nativeHarnessGapMessage(
              gateCybo ? gateCybo.name || gateCybo.slug : "This cybo",
              harness.provider,
              this.daemonLabel,
            ),
            { backend: harness.provider, ...reason },
          );
        }
        // The snapshot's "available" bottoms out on Paseo's isAvailable() which
        // only checks the BINARY, not the login (internal docs). A harness
        // installed but signed OUT therefore passes the status check above and
        // would die on the FIRST TURN with an auth error. The cyborg-side
        // read-only login probe refuses a logged-out native harness pre-spawn
        // with a Connect/login remedy (not_configured).
        const loginGap = await this.nativeHarnessLoginGap(harness.provider);
        if (loginGap) {
          return refuse(
            nativeHarnessGapMessage(
              gateCybo ? gateCybo.name || gateCybo.slug : "This cybo",
              harness.provider,
              this.daemonLabel,
            ),
            { backend: harness.provider, ...loginGap },
          );
        }
        return false;
      }

      // RUNTIME route: binary check with one lazy re-probe (a settled
      // "unavailable" is sticky — #369), then the per-backend gate (#402): a
      // cybo pinned to a backend the runtime has NOT configured would die on
      // the FIRST TURN with the runtime's raw "No API key found". Pass the
      // required backend to the re-probe so a model list pre-dating a fresh
      // `cybo login` is refreshed (#416 — else an Anthropic cybo is wrongly
      // refused right after the user connected Anthropic).
      const requiredBackend = gateCybo
        ? cyboRequiredBackend(gateCybo.provider, gateCybo.model)
        : null;
      const pi = await reprobePiBeforeSpawn(
        this.providerSnapshotManager,
        requiredBackend,
        this.logger,
      );
      if (!pi || pi.status === "unavailable") {
        return refuse(
          "Cybo isn't set up on this daemon yet — connect a model provider to run cybos. Set it up from the daemon page.",
        );
      }
      if (gateCybo) {
        const gap = findBackendGap(
          (pi.models ?? []).map((m) => m.id),
          requiredBackend,
        );
        if (gap) {
          // The runtime diagnostic carries provider-side rejections — attach the
          // classified reason so the UI shows the EXACT remedy.
          const reason = await this.classifyRuntimeGapReason(pi.provider);
          return refuse(spawnBackendGapMessage(gateCybo.name || gateCybo.slug, gap), {
            backend: gap,
            ...reason,
          });
        }
      }
      return false;
    } catch {
      // Snapshot read failed — don't block the spawn on a transient error.
      return false;
    }
  }

  // Read-only login gap for a native harness (internal docs): returns the
  // classified refusal reason when the harness is installed-but-signed-OUT, or
  // null when it's logged in / not a native harness / the probe couldn't decide
  // (fail-open — a real auth gap still surfaces at turn time). Pulled out of
  // spawnHarnessGateBlocked to keep that method under the complexity budget.
  private async nativeHarnessLoginGap(provider: string): Promise<{
    reasonKind: "not_configured";
    unavailableReason: string;
  } | null> {
    if (!isNativeHarnessProvider(provider)) return null;
    const login = await probeNativeHarnessLogin(provider);
    if (login.state !== "logged_out") return null;
    return { reasonKind: "not_configured", unavailableReason: login.reason };
  }

  // FIX 1 (internal docs): the @-mention spawn path (handleInvokeCyboMention)
  // does NOT run spawnHarnessGateBlocked, so a native-claude/codex cybo on a
  // SIGNED-OUT daemon spawns fine and then auth-fails on the first turn into the
  // ephemeral drain's silent black hole (no channel reply). Resolve the cybo the
  // same way the spawn does, and when its NATIVE harness is signed out, return
  // the branded gap message so the caller can post a clear channel notice and
  // skip the dead spawn. null = run normally (PI cybo, logged-in native, or the
  // probe couldn't decide — fail-open, a real gap still surfaces at turn time).
  private async mentionNativeHarnessGap(
    workspaceId: string,
    cyboIdOrSlug: string,
    resolvedCybo: StoredCybo | undefined,
  ): Promise<{ harness: string; message: string } | null> {
    const gateCybo =
      resolvedCybo ??
      // intentional: an unresolvable cybo falls through (return null) so the spawn
      // proceeds and raises its own established CyboNotFoundError — mirrors
      // spawnHarnessGateBlocked. The gate only refuses on a KNOWN native login gap.
      (await resolveCybo(this.storage, workspaceId, cyboIdOrSlug).catch(
        () => undefined, // intentional: see comment above — fall through to the spawn's own error
      ));
    if (!gateCybo) return null;
    const harness = resolveCyboHarness(gateCybo.provider, gateCybo.model);
    if (harness.provider === "pi") return null;
    const loginGap = await this.nativeHarnessLoginGap(harness.provider);
    if (!loginGap) return null;
    return {
      harness: harness.provider,
      message: nativeHarnessGapMessage(
        gateCybo.name || gateCybo.slug,
        harness.provider,
        this.daemonLabel,
      ),
    };
  }

  // Best-effort: read + classify the runtime's diagnostic for a backend gap so the
  // refusal carries the EXACT remedy (e.g. usage_gated vs not_configured) when the
  // diagnostic exposes it. Never throws — a probe failure just yields {}.
  //
  // NOTE (deliberate limitation): the in-process diagnostic is built from the model
  // CATALOG and is provider-level, so a per-backend AUTH rejection (Claude's
  // usage-gate 400, expired token, bad key) is NOT in it — those only surface when
  // the harness actually runs a turn. We do NOT shell out to `pi` to force them:
  // `pi` is interactive/PTY-bound and HANGS under the daemon's non-TTY execFile
  // (verified — SIGKILLed with no output), which would add a multi-second stall + a
  // zombie process to every gap-path spawn for zero gain. So for the usage-gate
  // case this returns {} → the UI shows the honest unavailable panel + remedy
  // buttons (reconnect / use API key) rather than a wrong "needs login". Surfacing
  // the EXACT usage-gate reason is a follow-up via the inference-time turn_failed
  // error (where the harness reports it through the daemon's existing runtime).
  private async classifyRuntimeGapReason(
    provider: Parameters<ProviderSnapshotManager["getProviderDiagnostic"]>[0],
  ): Promise<{
    reasonKind?: ReturnType<typeof classifyProviderError>["kind"];
    unavailableReason?: string;
  }> {
    if (!this.providerSnapshotManager) return {};
    try {
      const diag = await this.providerSnapshotManager.getProviderDiagnostic(provider);
      const classified = classifyProviderError(diag?.diagnostic);
      if (classified.kind !== "unknown") {
        return { reasonKind: classified.kind, unavailableReason: classified.reason };
      }
    } catch {
      // best-effort — a probe failure must not affect the spawn decision
    }
    return {};
  }

  // Cloud cybo-mention invocation: forwarded by the relay AFTER it persisted
  // the mentioning channel message and resolved the cybo against the channel's
  // cybo MEMBERS (cybo-mention-invoke.ts). Spawns the cybo EPHEMERAL bound to
  // the channel and routes the prompt — the same shape as /ask's handleAskCybo.
  // Failures emit an author-only ephemeral notice (cyborg:cybo_mention_notice
  // broadcast, P2) instead of dying silently. Gated on send_message like the
  // slash path: the author already posted in this channel via the relay.
  private async handleInvokeCyboMention(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgInvokeCyboMentionRequestSchema.parse(msg);
    const cyboLabel = (parsed.resolvedCybo?.slug as string | undefined) ?? parsed.cyboId;
    const notify = (text: string): void => {
      emit({
        type: "cyborg:cybo_mention_notice",
        payload: {
          toUserId: auth.user.id,
          workspaceId: parsed.workspaceId,
          channelId: parsed.channelId,
          text,
        },
      });
    };
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) return;
    if (!this.agentManager) {
      notify(`@${cyboLabel} can't run on this daemon right now (no agent manager).`);
      return;
    }
    // One invocation per (messageId, cyboId): shared with the local-mode
    // message-router path, so a replayed/duplicated forward — or a daemon that
    // sees the message through both paths — can't summon the cybo twice.
    if (!mentionInvocationGuard.shouldInvoke(parsed.messageId, parsed.cyboId)) return;
    // Per-workspace spawn rate-limit: the @-mention path was previously
    // UNTHROTTLED (a mention storm → unbounded ephemeral spawns). Share the
    // slash path's agent_spawn bucket (same RateLimiter instance, keyed by
    // workspace) so mentions + slash invocations draw on ONE budget. Over budget
    // → tell the author and skip, rather than spawning.
    if (!this.rateLimiter.check(parsed.workspaceId, "agent_spawn").allowed) {
      this.logger?.warn(
        { cybo: cyboLabel, workspaceId: parsed.workspaceId },
        "[cybo-mention] rate-limited (agent_spawn budget exhausted)",
      );
      notify(
        `@${cyboLabel} is being summoned too often in this workspace right now — wait a moment and try again.`,
      );
      return;
    }
    // FIX 1 (internal docs): apply the native-harness login gate the explicit
    // spawn path uses. On a SIGNED-OUT daemon a native cybo would otherwise spawn
    // and auth-fail into the silent ephemeral-drain black hole — no channel reply
    // at all. Refuse pre-spawn with a clear channel notice instead.
    const mentionGap = await this.mentionNativeHarnessGap(
      parsed.workspaceId,
      parsed.cyboId,
      parsed.resolvedCybo as StoredCybo | undefined,
    );
    if (mentionGap) {
      this.logger?.warn(
        { cybo: cyboLabel, workspaceId: parsed.workspaceId, harness: mentionGap.harness },
        `[cybo-mention] refusing ${cyboLabel}: native harness '${mentionGap.harness}' signed out on this daemon`,
      );
      notify(mentionGap.message);
      return;
    }
    try {
      const result = await spawnCybo({
        storage: this.storage,
        agentManager: this.agentManager,
        workspaceId: parsed.workspaceId,
        cyboIdOrSlug: parsed.cyboId,
        userId: auth.user.id,
        serverId: this.serverId ?? undefined,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
        ephemeral: true,
        context: { channelId: parsed.channelId, channelName: parsed.channelName },
        resolvedCybo: parsed.resolvedCybo as unknown as StoredCybo | undefined,
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger ?? undefined,
      });
      void this.messageRouter
        .routeToAgent(result.agentId, parsed.prompt, {
          rawPrompt: parsed.rawPrompt ?? parsed.prompt,
        })
        .catch((err) => this.logger?.warn({ err }, "[cybo-mention] route to cybo failed"));
    } catch (err) {
      let reason: string;
      if (err instanceof CyboNotFoundError) {
        reason = "it wasn't found on this daemon";
      } else {
        reason = err instanceof Error ? err.message : String(err);
      }
      this.logger?.error({ err }, `[cybo-mention] invoke of ${cyboLabel} failed`);
      notify(`@${cyboLabel} couldn't start: ${reason}`);
    }
  }

  // Tasks Phase 2 — cloud channel-watcher invocation: forwarded by the relay
  // AFTER it persisted an UN-mentioned human channel message in a channel with
  // auto_tasks_enabled, gated (auto-tasks + rate limit), resolved the first online
  // cybo in the channel's watcher fallback chain, and built the watcher prompt
  // (buildWatcherPrompt). Sibling of handleInvokeCyboMention: spawns the cybo
  // EPHEMERAL bound to the channel and routes the pre-built prompt — identical
  // tail. Differences: the dedup namespace is "watch:<messageId>" (one watch per
  // message, DISTINCT from the mention guard), and failures stay SILENT (the
  // watcher is best-effort and never user-facing — no author notice).
  private async handleInvokeChannelWatch(msg: CyborgMsg, auth: CyborgAuthContext): Promise<void> {
    const parsed = CyborgInvokeChannelWatchRequestSchema.parse(msg);
    const cyboLabel = (parsed.resolvedCybo?.slug as string | undefined) ?? parsed.cyboId;
    // Gated on send_message like the mention path: the author already posted in
    // this channel via the relay.
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) return;
    // Defense-in-depth: the per-workspace autonomy master switch (DEFAULT ON). The
    // relay already gates the forward, but a forward racing a toggle-OFF (or a daemon
    // that sees the message via another path) must still not spawn an un-mentioned
    // watcher. Read LIVE from PG. @-mentions are UNAFFECTED — this is the watch path,
    // never handleInvokeCyboMention.
    if (this.storage.pg) {
      try {
        if (!(await this.storage.pg.getWorkspaceAutonomyEnabled(parsed.workspaceId))) return;
      } catch {
        return;
      }
    }
    if (!this.agentManager) return;
    // One watch spawn per message — namespace "watch:<messageId>", shared with the
    // local message-router path, so a replayed/duplicated forward (or a daemon that
    // sees the message via both paths) can't spawn the watcher twice.
    if (!watchInvocationGuard.shouldWatch(parsed.messageId)) return;
    // Native-harness login gate (same as the mention path): a native cybo on a
    // signed-out daemon would spawn and auth-fail into the silent ephemeral drain.
    // The watcher is silent anyway, so just skip the dead spawn (no notice).
    const watchGap = await this.mentionNativeHarnessGap(
      parsed.workspaceId,
      parsed.cyboId,
      parsed.resolvedCybo as StoredCybo | undefined,
    );
    if (watchGap) {
      this.logger?.warn(
        { cybo: cyboLabel, workspaceId: parsed.workspaceId, harness: watchGap.harness },
        `[channel-watch] skipping ${cyboLabel}: native harness '${watchGap.harness}' signed out`,
      );
      return;
    }
    try {
      const result = await spawnCybo({
        storage: this.storage,
        agentManager: this.agentManager,
        workspaceId: parsed.workspaceId,
        cyboIdOrSlug: parsed.cyboId,
        userId: auth.user.id,
        serverId: this.serverId ?? undefined,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
        ephemeral: true,
        context: { channelId: parsed.channelId, channelName: parsed.channelName },
        resolvedCybo: parsed.resolvedCybo as unknown as StoredCybo | undefined,
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger ?? undefined,
      });
      void this.messageRouter
        .routeToAgent(result.agentId, parsed.prompt, {
          rawPrompt: parsed.rawPrompt ?? parsed.prompt,
        })
        .catch((err) => this.logger?.warn({ err }, "[channel-watch] route to cybo failed"));
    } catch (err) {
      // Best-effort + silent: log only, no author notice (the watcher was never
      // requested by the author, so a failure must not surface in the channel).
      this.logger?.error({ err }, `[channel-watch] invoke of ${cyboLabel} failed`);
    }
  }

  private async handleSpawnCybo(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSpawnCyboRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot spawn cybo",
        },
      });
      return;
    }
    if (!this.agentManager) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "unavailable",
          message: "Agent manager not available",
        },
      });
      return;
    }
    // Authorize the TARGET daemon: the user must OWN it or hold a daemon_access
    // grant. Without this, a mis-selected daemon in the UI (or a crafted request)
    // would spawn a cybo on someone else's machine. PG-only (cloud); in solo mode
    // there's just the caller's own daemon, so there's nothing to cross.
    const targetDaemonId = parsed.daemonId ?? this.serverId ?? undefined;
    const daemonPg = this.storage.pg;
    if (targetDaemonId && daemonPg) {
      const canAccess = await daemonPg.canUserAccessDaemon(
        parsed.workspaceId,
        targetDaemonId,
        auth.user.id,
      );
      if (!canAccess) {
        emit({
          type: "cyborg:error",
          payload: {
            requestId: parsed.requestId,
            code: "forbidden",
            message: "No access to this daemon",
          },
        });
        return;
      }
    }

    const rl = this.rateLimiter.check(parsed.workspaceId, "agent_spawn");
    if (!rl.allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "rate_limited",
          message: "Too many agents created",
        },
      });
      return;
    }

    // Provider IS the harness (internal docs): verify the CHOSEN harness with
    // no silent fallback — native claude/codex on the daemon's own provider,
    // everything else through the Cybo runtime (per-backend gate + lazy
    // re-probe preserved). Emits the refusal itself, classified reason attached.
    if (await this.spawnHarnessGateBlocked(parsed, emit)) return;

    try {
      const channel = parsed.channelId ? this.storage.getChannel(parsed.channelId) : undefined;

      const result = await spawnCybo({
        storage: this.storage,
        agentManager: this.agentManager,
        workspaceId: parsed.workspaceId,
        cyboIdOrSlug: parsed.cyboIdOrSlug,
        userId: auth.user.id,
        // Real initiator email so this (NON-ephemeral) cybo session attributes to
        // its owner in the offline visibility filter — not <id>@remote.local (#810).
        initiatedByEmail: auth.user.email ?? null,
        serverId: this.serverId ?? undefined,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
        context: {
          channelId: parsed.channelId,
          channelName: channel?.name,
          cwd: parsed.cwd,
        },
        // Cloud: the relay resolved the cybo from PG (the daemon's local SQLite may
        // not have it). Without this, resolveCybo throws "Cybo not found".
        resolvedCybo: parsed.resolvedCybo as StoredCybo | undefined,
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger ?? undefined,
      });

      emit({
        type: "cyborg:spawn_cybo_response",
        payload: {
          requestId: parsed.requestId,
          agentId: result.agentId,
          cyboId: result.cyboId,
          cyboSlug: result.cyboSlug,
          provider: result.provider,
          model: result.model,
        },
      });
    } catch (err) {
      if (err instanceof CyboNotFoundError) {
        const enriched = parsed.resolvedCybo != null;
        // Server-side diagnostic: pinpoints relay PG-miss (unenriched forward of a
        // local-disk cybo to the wrong daemon) vs workspace mismatch on enrich.
        this.logger?.error(
          `[spawn_cybo] not found: "${parsed.cyboIdOrSlug}" (enriched=${enriched}, daemon=${this.serverId}, workspace=${parsed.workspaceId})`,
        );
        emit({
          type: "cyborg:error",
          payload: {
            requestId: parsed.requestId,
            code: "not_found",
            message: describeSpawnCyboNotFound(parsed.cyboIdOrSlug, {
              enriched,
              daemonId: this.serverId,
            }),
          },
        });
        return;
      }
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to spawn cybo",
        },
      });
    }
  }

  private handleDeleteCybo(msg: CyborgMsg, auth: CyborgAuthContext, emit: EmitFn): undefined {
    const parsed = CyborgDeleteCyboRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "manage_workspace",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Cannot delete cybo" },
      });
      return undefined;
    }
    // Tolerant resolution (mirrors the relay's resolveWorkspaceCybo, Bug T3): the
    // relay's delete fan-out (#1020) targets the canonical PG id, but this daemon may
    // hold the cybo's local SQLite row under a slug-derived id. Resolve by exact id
    // first, then by slug within the workspace, so the prune can't miss — otherwise
    // the surviving SQLite row re-surfaces on the next fetch_cybos ("delete resurrects").
    const cybo =
      this.storage.getCybo(parsed.cyboId) ??
      this.storage.getCyboBySlug(parsed.workspaceId, parsed.cyboId);
    if (cybo && cybo.workspace_id === parsed.workspaceId) {
      this.storage.deleteCybo(cybo.id);
    }
    // Idempotent no-op when this daemon doesn't hold the cybo. The relay fans the
    // delete out to EVERY online workspace daemon, so most receive a delete for a
    // cybo they never had; a hard "Cybo not found" error here was forwarded back and
    // broadcast to all guests as spurious error toasts. Delete is idempotent — a
    // missing row is success, not an error.
    emit({
      type: "cyborg:delete_cybo_response",
      payload: { requestId: parsed.requestId, deleted: true },
    });
    return undefined;
  }

  // ─── Schedule handlers (local daemon mode) ───────────────────────
  // Human CRUD over the cybo schedules the ScheduleRunner executes. In local
  // mode these run on the daemon directly (DualStorage = SQLite truth + PG
  // mirror); in cloud mode the relay forwards the writes here and reads list
  // straight from the PG mirror. Scheduling a cybo is recurring code execution,
  // so writes require create_agent — the same authority as spawning it.

  private scheduleView(s: StoredSchedule): CyborgScheduleView {
    return {
      id: s.id,
      workspaceId: s.workspace_id,
      cyboId: s.cybo_id,
      cyboName: this.storage.getCybo(s.cybo_id)?.name ?? null,
      channelId: s.channel_id,
      taskId: s.task_id,
      cron: s.cron_expr,
      timezone: s.timezone,
      prompt: s.prompt,
      enabled: s.enabled === 1,
      lastRunAt: s.last_run_at,
      nextRunAt: s.next_run_at,
      // Phase 2 (#619) lifecycle fields. stale is omitted here — it's a cloud
      // read-time computation (daemon vs heartbeat registry) the relay adds; a
      // local daemon answering its own schedules is by definition not stale.
      maxRuns: s.max_runs,
      runCount: s.run_count,
      catchUp: s.catch_up === 1,
      createdBy: s.created_by,
      createdAt: s.created_at,
    };
  }

  private scheduleRunView(r: StoredScheduleRun): CyborgScheduleRunView {
    return {
      id: r.id,
      scheduleId: r.schedule_id,
      scheduledFor: r.scheduled_for,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      skipReason: r.skip_reason,
      agentId: r.agent_id,
      error: r.error,
    };
  }

  private emitScheduleError(emit: EmitFn, requestId: string, op: string, message: string): void {
    emit({
      type: "cyborg:schedule_mutated",
      payload: { requestId, ok: false, op, scheduleId: null, error: message },
    });
  }

  private async handleCreateSchedule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateScheduleRequestSchema.parse(msg);
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      this.emitScheduleError(emit, parsed.requestId, "create", "Cannot create schedules here");
      return;
    }
    // Resolve the cybo by id or slug, workspace-scoped (#206) — same rule as the
    // MCP schedule tool. A relay-enriched resolvedCybo (cloud) wins when the
    // daemon's SQLite lacks the row. Returns the cybo id (the only field the
    // schedule row needs).
    const targetCyboId = this.resolveWorkspaceCyboId(
      parsed.workspaceId,
      parsed.cyboIdOrSlug,
      parsed.resolvedCybo,
    );
    if (!targetCyboId) {
      this.emitScheduleError(
        emit,
        parsed.requestId,
        "create",
        `No cybo "${parsed.cyboIdOrSlug}" in this workspace`,
      );
      return;
    }
    const cadence = {
      type: "cron" as const,
      expression: parsed.cron,
      timezone: parsed.timezone ?? undefined,
    };
    try {
      validateScheduleCadence(cadence);
    } catch (err) {
      const m = err instanceof Error ? err.message : "invalid cron expression";
      this.emitScheduleError(emit, parsed.requestId, "create", `Invalid cron: ${m}`);
      return;
    }
    const nextRunAt = computeNextRunAt(cadence, new Date()).getTime();
    const schedule = this.storage.createSchedule({
      workspaceId: parsed.workspaceId,
      cyboId: targetCyboId,
      cronExpr: parsed.cron,
      prompt: parsed.prompt,
      createdBy: auth.user.id,
      channelId: parsed.channelId ?? null,
      taskId: parsed.taskId ?? null,
      timezone: parsed.timezone ?? null,
      nextRunAt,
      // Phase 2 (#619): one-shot cap + catch-up policy (both optional → defaults).
      maxRuns: parsed.maxRuns ?? null,
      catchUp: parsed.catchUp,
    });
    emit({
      type: "cyborg:schedule_mutated",
      payload: {
        requestId: parsed.requestId,
        ok: true,
        op: "create",
        scheduleId: schedule.id,
        schedule: this.scheduleView(schedule),
      },
    });
    return undefined;
  }

  private handleListSchedules(msg: CyborgMsg, _auth: CyborgAuthContext, emit: EmitFn): undefined {
    const parsed = CyborgListSchedulesRequestSchema.parse(msg);
    const all = this.storage.listSchedules(parsed.workspaceId);
    const filtered = parsed.cyboId ? all.filter((s) => s.cybo_id === parsed.cyboId) : all;
    emit({
      type: "cyborg:schedule_list_response",
      payload: {
        requestId: parsed.requestId,
        schedules: filtered.map((s) => this.scheduleView(s)),
      },
    });
    return undefined;
  }

  private async handleUpdateSchedule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateScheduleRequestSchema.parse(msg);
    const existing = this.requireOwnedSchedule(
      parsed.requestId,
      parsed.workspaceId,
      parsed.scheduleId,
      auth,
      emit,
      "update",
    );
    if (!existing) return;
    const fields: {
      cronExpr?: string;
      prompt?: string;
      channelId?: string | null;
      taskId?: string | null;
      timezone?: string | null;
      nextRunAt?: number | null;
    } = {};
    if (parsed.prompt !== undefined) fields.prompt = parsed.prompt;
    if (parsed.channelId !== undefined) fields.channelId = parsed.channelId;
    if (parsed.taskId !== undefined) fields.taskId = parsed.taskId;
    // A cron OR timezone change re-validates and recomputes next_run_at so the
    // edit takes effect on the next tick, not the old slot.
    if (parsed.cron !== undefined || parsed.timezone !== undefined) {
      const expression = parsed.cron ?? existing.cron_expr;
      const timezone = parsed.timezone !== undefined ? parsed.timezone : existing.timezone;
      const cadence = { type: "cron" as const, expression, timezone: timezone ?? undefined };
      try {
        validateScheduleCadence(cadence);
      } catch (err) {
        const m = err instanceof Error ? err.message : "invalid cron expression";
        this.emitScheduleError(emit, parsed.requestId, "update", `Invalid cron: ${m}`);
        return;
      }
      if (parsed.cron !== undefined) fields.cronExpr = parsed.cron;
      if (parsed.timezone !== undefined) fields.timezone = parsed.timezone;
      fields.nextRunAt = computeNextRunAt(cadence, new Date()).getTime();
    }
    const updated = this.storage.updateSchedule(parsed.scheduleId, fields);
    emit({
      type: "cyborg:schedule_mutated",
      payload: {
        requestId: parsed.requestId,
        ok: true,
        op: "update",
        scheduleId: parsed.scheduleId,
        schedule: updated ? this.scheduleView(updated) : null,
      },
    });
    return undefined;
  }

  private async handleSetScheduleEnabled(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetScheduleEnabledRequestSchema.parse(msg);
    const existing = this.requireOwnedSchedule(
      parsed.requestId,
      parsed.workspaceId,
      parsed.scheduleId,
      auth,
      emit,
      "set_enabled",
    );
    if (!existing) return;
    // Resuming a schedule whose next_run_at is in the past (paused for a while)
    // recomputes it forward, so it doesn't immediately fire a backlog on resume.
    let nextRunAt: number | null | undefined;
    if (parsed.enabled && (existing.next_run_at == null || existing.next_run_at <= Date.now())) {
      try {
        nextRunAt = computeNextRunAt(
          {
            type: "cron",
            expression: existing.cron_expr,
            timezone: existing.timezone ?? undefined,
          },
          new Date(),
        ).getTime();
      } catch {
        nextRunAt = undefined; // unparseable cron — leave it; the runner disables on tick
      }
    }
    this.storage.setScheduleEnabled(parsed.scheduleId, parsed.enabled, nextRunAt);
    const updated = this.storage.getSchedule(parsed.scheduleId);
    emit({
      type: "cyborg:schedule_mutated",
      payload: {
        requestId: parsed.requestId,
        ok: true,
        op: "set_enabled",
        scheduleId: parsed.scheduleId,
        schedule: updated ? this.scheduleView(updated) : null,
      },
    });
    return undefined;
  }

  private async handleDeleteSchedule(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteScheduleRequestSchema.parse(msg);
    const existing = this.requireOwnedSchedule(
      parsed.requestId,
      parsed.workspaceId,
      parsed.scheduleId,
      auth,
      emit,
      "delete",
    );
    if (!existing) return;
    this.storage.deleteSchedule(parsed.scheduleId);
    emit({
      type: "cyborg:schedule_mutated",
      payload: {
        requestId: parsed.requestId,
        ok: true,
        op: "delete",
        scheduleId: parsed.scheduleId,
      },
    });
    return undefined;
  }

  private async handleRunScheduleOnce(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRunScheduleOnceRequestSchema.parse(msg);
    const existing = this.requireOwnedSchedule(
      parsed.requestId,
      parsed.workspaceId,
      parsed.scheduleId,
      auth,
      emit,
      "run_once",
    );
    if (!existing) return;
    if (!this.scheduleRunner) {
      this.emitScheduleError(
        emit,
        parsed.requestId,
        "run_once",
        "Scheduler not available on this daemon",
      );
      return;
    }
    const reason = await this.scheduleRunner.runOnce(parsed.scheduleId);
    if (reason) {
      this.emitScheduleError(emit, parsed.requestId, "run_once", reason);
      return;
    }
    emit({
      type: "cyborg:schedule_mutated",
      payload: {
        requestId: parsed.requestId,
        ok: true,
        op: "run_once",
        scheduleId: parsed.scheduleId,
      },
    });
    return undefined;
  }

  // Run history for a schedule (the "Last runs" drawer, #619). A read scoped to
  // the workspace: the schedule must belong to it (mirrors handleListSchedules,
  // which is read-only and unguarded beyond workspace scope). In cloud mode the
  // relay answers this off the PG mirror instead (see relay-standalone).
  private handleListScheduleRuns(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgListScheduleRunsRequestSchema.parse(msg);
    const schedule = this.storage.getSchedule(parsed.scheduleId);
    // Don't leak runs for a schedule in another workspace; an unknown/foreign id
    // just returns an empty list (a read, so no error surface).
    const runs =
      schedule && schedule.workspace_id === parsed.workspaceId
        ? this.storage.listScheduleRuns(parsed.scheduleId, parsed.limit)
        : [];
    emit({
      type: "cyborg:schedule_runs_response",
      payload: {
        requestId: parsed.requestId,
        scheduleId: parsed.scheduleId,
        runs: runs.map((r) => this.scheduleRunView(r)),
      },
    });
    return undefined;
  }

  // ─── Scheduled messages (user "send later", #607) ────────────────
  // Human create/list/cancel over their OWN deferred messages — distinct from the
  // cybo-schedule handlers above. The ScheduledMessageRunner fires due rows on the
  // shared tick. Authority is checked at create time (send_message) AND re-checked
  // at SEND time (the author may lose access in between). Dual-routed: these run
  // here in local mode; the relay has its own copies in relay-standalone.ts.

  private async handleScheduleMessageCreate(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgScheduleMessageCreateRequestSchema.parse(msg);
    const ack = (ok: boolean, error?: string, message?: StoredScheduledMessage): void => {
      emit({
        type: "cyborg:schedule_message_create_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          op: "create",
          ...(message ? { message: scheduledMessageView(message) } : {}),
          ...(error ? { error } : {}),
        },
      });
    };

    // EXACTLY ONE of channelId / toId — reject a malformed target up front rather
    // than persisting a row that can never fire.
    const hasChannel = typeof parsed.channelId === "string" && parsed.channelId.length > 0;
    const hasTo = typeof parsed.toId === "string" && parsed.toId.length > 0;
    if (hasChannel === hasTo) {
      ack(false, "Specify exactly one of a channel or a DM recipient.");
      return;
    }
    if (parsed.text.trim().length === 0) {
      ack(false, "Message text is required.");
      return;
    }
    // Must be in the future — a past time would fire on the very next tick, which
    // is almost never the intent; the client gates this too.
    if (!Number.isFinite(parsed.sendAt) || parsed.sendAt <= Date.now()) {
      ack(false, "Pick a time in the future.");
      return;
    }
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) {
      ack(false, "You can't send messages in this workspace.");
      return;
    }
    // Channel target must exist in this workspace and not be archived.
    if (hasChannel) {
      const channel = this.storage.getChannel(parsed.channelId as string);
      if (!channel || channel.workspace_id !== parsed.workspaceId) {
        ack(false, "Channel not found.");
        return;
      }
      if (channel.is_archived === 1) {
        ack(false, "Channel is archived.");
        return;
      }
    }

    const row = this.storage.createScheduledMessage({
      workspaceId: parsed.workspaceId,
      fromId: auth.user.id,
      text: parsed.text,
      sendAt: parsed.sendAt,
      channelId: hasChannel ? (parsed.channelId as string) : null,
      toId: hasTo ? (parsed.toId as string) : null,
      mentions: parsed.mentions ?? null,
    });
    ack(true, undefined, row);
    return undefined;
  }

  private handleScheduleMessageList(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgScheduleMessageListRequestSchema.parse(msg);
    // The caller only ever sees their OWN scheduled messages (keyed by from_id).
    const rows = this.storage.listScheduledMessages(parsed.workspaceId, auth.user.id);
    emit({
      type: "cyborg:schedule_message_list_response",
      payload: {
        requestId: parsed.requestId,
        messages: rows.map(scheduledMessageView),
      },
    });
    return undefined;
  }

  private handleScheduleMessageCancel(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgScheduleMessageCancelRequestSchema.parse(msg);
    const ack = (ok: boolean, error?: string): void => {
      emit({
        type: "cyborg:schedule_message_cancel_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          op: "cancel",
          id: parsed.id,
          ...(error ? { error } : {}),
        },
      });
    };
    // Only the author may cancel their own row, and only while it's still pending.
    const existing = this.storage.getScheduledMessage(parsed.id);
    if (
      !existing ||
      existing.workspace_id !== parsed.workspaceId ||
      existing.from_id !== auth.user.id
    ) {
      ack(false, "Scheduled message not found.");
      return;
    }
    if (existing.processed_at !== null) {
      ack(false, "This message already sent.");
      return;
    }
    const deleted = this.storage.deleteScheduledMessage(parsed.id);
    ack(deleted, deleted ? undefined : "This message already sent.");
    return undefined;
  }

  // ─── Outgoing webhooks (#598) ───────────────────────────────────
  // Workspace+channel-scoped OUTBOUND webhooks. WORKSPACE-LEVEL config (like
  // channels), so the local daemon mutates PG directly here (NOT daemon-forward),
  // mirroring relay-standalone's guest switch. PG-only: a solo daemon (no PG
  // connection) reports the feature unavailable rather than persisting to SQLite,
  // since the delivery runner reads from PG. The signing secret is generated +
  // hashed here and returned to the client ONCE; never re-shown, never logged.

  private webhookMutated(
    emit: EmitFn,
    requestId: string,
    op: "create" | "update" | "delete",
    opts: {
      ok: boolean;
      id?: string | null;
      webhook?: CyborgOutgoingWebhookView | null;
      secret?: string;
      error?: string;
    },
  ): void {
    emit({
      type: "cyborg:outgoing_webhook_mutated",
      payload: {
        requestId,
        ok: opts.ok,
        op,
        id: opts.id ?? null,
        ...(opts.webhook !== undefined ? { webhook: opts.webhook } : {}),
        ...(opts.secret !== undefined ? { secret: opts.secret } : {}),
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      },
    });
  }

  private async handleCreateOutgoingWebhook(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateOutgoingWebhookRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      this.webhookMutated(emit, parsed.requestId, "create", {
        ok: false,
        error: "Webhooks require a cloud-connected workspace.",
      });
      return;
    }
    // A workspace MEMBER may create (records created_by). Viewers cannot.
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_channel",
    );
    if (!allowed) {
      this.webhookMutated(emit, parsed.requestId, "create", {
        ok: false,
        error: "You can't create webhooks in this workspace.",
      });
      return;
    }
    const urlError = validateWebhookUrl(parsed.url);
    if (urlError) {
      this.webhookMutated(emit, parsed.requestId, "create", { ok: false, error: urlError });
      return;
    }
    // Channel must exist in this workspace.
    const channel = this.storage.getChannel(parsed.channelId);
    if (!channel || channel.workspace_id !== parsed.workspaceId) {
      this.webhookMutated(emit, parsed.requestId, "create", {
        ok: false,
        error: "Channel not found.",
      });
      return;
    }
    const secret = generateWebhookSecret();
    const events = parsed.events ? normalizeEventFlags(parsed.events) : { "message.created": true };
    const webhook = await pg.createOutgoingWebhook({
      id: newOutgoingWebhookId(),
      workspaceId: parsed.workspaceId,
      channelId: parsed.channelId,
      url: parsed.url,
      secretKeyHash: secret.hash,
      name: parsed.name,
      events,
      createdBy: auth.user.id,
    });
    // The raw secret is returned ONCE here and never persisted/logged.
    this.webhookMutated(emit, parsed.requestId, "create", {
      ok: true,
      id: webhook.id,
      webhook,
      secret: secret.raw,
    });
  }

  private async handleUpdateOutgoingWebhook(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateOutgoingWebhookRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      this.webhookMutated(emit, parsed.requestId, "update", {
        ok: false,
        id: parsed.id,
        error: "Webhooks require a cloud-connected workspace.",
      });
      return;
    }
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_channel",
    );
    if (!allowed) {
      this.webhookMutated(emit, parsed.requestId, "update", {
        ok: false,
        id: parsed.id,
        error: "You can't manage webhooks in this workspace.",
      });
      return;
    }
    if (parsed.url !== undefined) {
      const urlError = validateWebhookUrl(parsed.url);
      if (urlError) {
        this.webhookMutated(emit, parsed.requestId, "update", {
          ok: false,
          id: parsed.id,
          error: urlError,
        });
        return;
      }
    }
    const secret = parsed.regenerateSecret ? generateWebhookSecret() : null;
    const webhook = await pg.updateOutgoingWebhook(parsed.id, parsed.workspaceId, {
      name: parsed.name,
      url: parsed.url,
      events: parsed.events ? normalizeEventFlags(parsed.events) : undefined,
      isActive: parsed.isActive,
      secretKeyHash: secret?.hash,
    });
    if (!webhook) {
      this.webhookMutated(emit, parsed.requestId, "update", {
        ok: false,
        id: parsed.id,
        error: "Webhook not found.",
      });
      return;
    }
    this.webhookMutated(emit, parsed.requestId, "update", {
      ok: true,
      id: webhook.id,
      webhook,
      ...(secret ? { secret: secret.raw } : {}),
    });
  }

  private async handleDeleteOutgoingWebhook(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteOutgoingWebhookRequestSchema.parse(msg);
    const pg = this.storage.pg;
    if (!pg) {
      this.webhookMutated(emit, parsed.requestId, "delete", {
        ok: false,
        id: parsed.id,
        error: "Webhooks require a cloud-connected workspace.",
      });
      return;
    }
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_channel",
    );
    if (!allowed) {
      this.webhookMutated(emit, parsed.requestId, "delete", {
        ok: false,
        id: parsed.id,
        error: "You can't manage webhooks in this workspace.",
      });
      return;
    }
    const deleted = await pg.deleteOutgoingWebhook(parsed.id, parsed.workspaceId);
    this.webhookMutated(emit, parsed.requestId, "delete", {
      ok: deleted,
      id: parsed.id,
      ...(deleted ? {} : { error: "Webhook not found." }),
    });
  }

  private async handleFetchOutgoingWebhooks(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchOutgoingWebhooksRequestSchema.parse(msg);
    const pg = this.storage.pg;
    // A member (or viewer with view permission) may list — secrets are never in
    // the view, so listing is safe at view level.
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) {
      emit({
        type: "cyborg:fetch_outgoing_webhooks_response",
        payload: { requestId: parsed.requestId, webhooks: [] },
      });
      return;
    }
    const webhooks = pg ? await pg.listOutgoingWebhooks(parsed.workspaceId, parsed.channelId) : [];
    emit({
      type: "cyborg:fetch_outgoing_webhooks_response",
      payload: { requestId: parsed.requestId, webhooks },
    });
  }

  // ─── Prompt templates (#602 — reusable composer snippets) ────────
  // WORKSPACE-MEMBER gated CRUD (member level, mirroring send_message — viewers
  // and non-members are refused). The name is a per-workspace unique handle, so a
  // create/rename clash returns a friendly error instead of a UNIQUE throw.

  private handleCreatePromptTemplate(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgCreatePromptTemplateRequestSchema.parse(msg);
    const ack = (ok: boolean, error?: string, template?: StoredPromptTemplate): void => {
      emit({
        type: "cyborg:create_prompt_template_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          op: "create",
          ...(template ? { template: promptTemplateView(template) } : {}),
          ...(error ? { error } : {}),
        },
      });
    };
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) {
      ack(false, "You can't manage prompt templates in this workspace.");
      return;
    }
    const name = parsed.name.trim();
    if (name.length === 0) {
      ack(false, "Template name is required.");
      return;
    }
    // Body content validation (length + non-empty) shared with the author-time UI
    // check; unknownVars is a non-blocking warning, not an error here.
    const validation = validatePromptTemplate(parsed.body);
    if (!validation.ok) {
      ack(false, validation.error ?? "Invalid template body.");
      return;
    }
    if (this.storage.getPromptTemplateByName(parsed.workspaceId, name)) {
      ack(false, `A template named "${name}" already exists.`);
      return;
    }
    const row = this.storage.createPromptTemplate({
      workspaceId: parsed.workspaceId,
      name,
      body: parsed.body,
      createdBy: auth.user.id,
    });
    ack(true, undefined, row);
    return undefined;
  }

  private handleUpdatePromptTemplate(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgUpdatePromptTemplateRequestSchema.parse(msg);
    const ack = (ok: boolean, error?: string, template?: StoredPromptTemplate): void => {
      emit({
        type: "cyborg:update_prompt_template_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          op: "update",
          ...(template ? { template: promptTemplateView(template) } : {}),
          ...(error ? { error } : {}),
        },
      });
    };
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) {
      ack(false, "You can't manage prompt templates in this workspace.");
      return;
    }
    const existing = this.storage.getPromptTemplate(parsed.id);
    if (!existing || existing.workspace_id !== parsed.workspaceId) {
      ack(false, "Template not found.");
      return;
    }
    const name = parsed.name?.trim();
    if (parsed.name !== undefined && (name === undefined || name.length === 0)) {
      ack(false, "Template name is required.");
      return;
    }
    if (parsed.body !== undefined) {
      const validation = validatePromptTemplate(parsed.body);
      if (!validation.ok) {
        ack(false, validation.error ?? "Invalid template body.");
        return;
      }
    }
    if (name === undefined && parsed.body === undefined) {
      ack(false, "Nothing to update.");
      return;
    }
    // Renaming onto another template's name is a clash (a no-op rename to its OWN
    // current name is allowed).
    if (name !== undefined && name !== existing.name) {
      const clash = this.storage.getPromptTemplateByName(parsed.workspaceId, name);
      if (clash && clash.id !== parsed.id) {
        ack(false, `A template named "${name}" already exists.`);
        return;
      }
    }
    const row = this.storage.updatePromptTemplate(parsed.id, {
      ...(name !== undefined ? { name } : {}),
      ...(parsed.body !== undefined ? { body: parsed.body } : {}),
    });
    ack(true, undefined, row);
    return undefined;
  }

  private handleDeletePromptTemplate(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgDeletePromptTemplateRequestSchema.parse(msg);
    const ack = (ok: boolean, error?: string): void => {
      emit({
        type: "cyborg:delete_prompt_template_response",
        payload: {
          requestId: parsed.requestId,
          ok,
          op: "delete",
          id: parsed.id,
          ...(error ? { error } : {}),
        },
      });
    };
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) {
      ack(false, "You can't manage prompt templates in this workspace.");
      return;
    }
    const existing = this.storage.getPromptTemplate(parsed.id);
    if (!existing || existing.workspace_id !== parsed.workspaceId) {
      ack(false, "Template not found.");
      return;
    }
    const deleted = this.storage.deletePromptTemplate(parsed.id);
    ack(deleted, deleted ? undefined : "Template not found.");
    return undefined;
  }

  private handleListPromptTemplates(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): undefined {
    const parsed = CyborgListPromptTemplatesRequestSchema.parse(msg);
    // Any workspace member may read the templates (member-gated, like the list
    // itself). A non-member gets an empty list rather than foreign config.
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "send_message",
    );
    const templates = allowed ? this.storage.listPromptTemplates(parsed.workspaceId) : [];
    emit({
      type: "cyborg:list_prompt_templates_response",
      payload: {
        requestId: parsed.requestId,
        templates: templates.map(promptTemplateView),
      },
    });
    return undefined;
  }

  // Resolve a cybo to its id by id or slug, workspace-scoped (a global id match
  // is only accepted when it's in THIS workspace — #206). A relay-enriched
  // resolvedCybo (cloud, where the daemon's SQLite may lack the row) is trusted
  // ONLY for its id — we read the single `id` field with a runtime type check
  // rather than casting the whole untrusted RPC object to StoredCybo.
  private resolveWorkspaceCyboId(
    workspaceId: string,
    idOrSlug: string,
    resolvedCybo?: Record<string, unknown>,
  ): string | null {
    if (resolvedCybo && typeof resolvedCybo.id === "string") {
      return resolvedCybo.id;
    }
    const byId = this.storage.getCybo(idOrSlug);
    if (byId && byId.workspace_id === workspaceId) return byId.id;
    return this.storage.getCyboBySlug(workspaceId, idOrSlug)?.id ?? null;
  }

  // Load a schedule and assert (a) it's in the caller's workspace and (b) the
  // caller can manage it (create_agent permission). Emits the error + returns
  // null on any failure so handlers can early-return.
  private requireOwnedSchedule(
    requestId: string,
    workspaceId: string,
    scheduleId: string,
    auth: CyborgAuthContext,
    emit: EmitFn,
    op: string,
  ): StoredSchedule | null {
    const { allowed } = this.workspaceManager.checkPermission(
      workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      this.emitScheduleError(emit, requestId, op, "Cannot manage schedules here");
      return null;
    }
    const schedule = this.storage.getSchedule(scheduleId);
    if (!schedule || schedule.workspace_id !== workspaceId) {
      this.emitScheduleError(emit, requestId, op, "Schedule not found");
      return null;
    }
    return schedule;
  }

  // ─── Agent state & timeline handlers ─────────────────────────────

  // oxlint-disable-next-line eslint/complexity -- builds a detailed response object
  private async handleFetchAgentState(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchAgentStateRequestSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:fetch_agent_state_response",
        payload: { requestId: parsed.requestId, agent: null },
      });
      return;
    }

    const live = this.agentManager?.getAgent(parsed.agentId);
    const attention = live?.attention;
    emit({
      type: "cyborg:fetch_agent_state_response",
      payload: {
        requestId: parsed.requestId,
        agent: {
          agentId: parsed.agentId,
          provider: binding.provider,
          lifecycle: live?.lifecycle ?? "unknown",
          model: live?.config.model ?? binding.model ?? null,
          modeId: live?.currentModeId ?? null,
          availableModes: live?.availableModes ?? [],
          thinkingOptionId:
            live?.runtimeInfo?.thinkingOptionId ?? live?.config.thinkingOptionId ?? null,
          cwd: live?.cwd ?? null,
          cyboId: binding.cybo_id,
          channelId: binding.channel_id,
          daemonLocal: live != null,
          createdAt: live?.createdAt?.toISOString(),
          lastUserMessageAt: live?.lastUserMessageAt?.toISOString() ?? null,
          attention: attention
            ? {
                requiresAttention: attention.requiresAttention,
                reason: attention.requiresAttention ? attention.attentionReason : null,
              }
            : undefined,
          usage: live?.lastUsage ?? null,
        },
      },
    });
  }

  // The live in-memory window's minSeq is the reattach SEED floor, not the true
  // history floor: on reattach the in-memory store is seeded with nextSeq only (no
  // rows), so a resident agent's window holds just the current session's tail (e.g.
  // seq 501+) while the durable store holds the full history (seq 1..N). Its hasOlder
  // is therefore structurally false even when older committed rows exist — silently
  // disabling scroll-up "load older" for live agent sessions (Claude stays resident;
  // channels are unaffected since they page PG directly). When the live path served
  // the initial page and reported no older history, probe the durable store for any
  // row BEFORE the oldest row we served; if found, arm backward paging from THAT seq
  // (not the durable tail, which would skip the rows between the durable tail and the
  // live window). The direction:"older" branch reads the durable store, so paging
  // continues correctly from here. No-op (returns input) at the true floor.
  private async reconcileLiveOlder(args: {
    agentId: string;
    isLive: boolean;
    wantOlder: boolean;
    hasOlder: boolean;
    olderCursor: string | null;
    itemCount: number;
    oldestHeldSeq: number | null;
    epoch: string | null;
  }): Promise<{ hasOlder: boolean; olderCursor: string | null }> {
    const unchanged = { hasOlder: args.hasOlder, olderCursor: args.olderCursor };
    if (!args.isLive || args.wantOlder || args.hasOlder || args.itemCount === 0) return unchanged;
    if (args.oldestHeldSeq === null || args.epoch === null || !this.durableTimelineStore) {
      return unchanged;
    }
    // L3: this cursor targets the DURABLE store, which keys rows by seq only and
    // ignores cursor.epoch (it always uses/reports "committed"). The live window's
    // epoch (a per-process randomUUID) is meaningless against the durable store, so
    // stamp both the probe cursor and the returned olderCursor with the durable
    // epoch — keeping it consistent with the durable-path olderCursors the client
    // is handed elsewhere (and with where this olderCursor is later consumed: the
    // "older" page always reads the durable store).
    const durableEpoch = "committed";
    try {
      const probe = await this.durableTimelineStore.fetchCommitted(args.agentId, {
        direction: "before",
        cursor: { epoch: durableEpoch, seq: args.oldestHeldSeq },
        limit: 1,
      });
      if (probe.rows.length === 0) return unchanged;
      return {
        hasOlder: true,
        olderCursor: JSON.stringify({ epoch: durableEpoch, seq: args.oldestHeldSeq }),
      };
    } catch (err) {
      // M1: arming scroll-up is a best-effort enhancement on a path that otherwise
      // does ZERO durable I/O. A durable probe error (SQLite busy/locked/disk) must
      // NOT propagate — it would reach the handler's non-Zod rethrow and hang the
      // fetch with no response. Degrade to pre-fix behavior (scroll-up stays off);
      // the in-memory load still succeeds.
      this.logger?.warn(
        { err, agentId: args.agentId },
        "[timeline] reconcileLiveOlder durable probe failed — leaving hasOlder unchanged",
      );
      return unchanged;
    }
  }

  // Audit-visibility predicate (sessions-daemon-audit-visibility, Decision 2):
  // a session on THIS daemon is auditable by a caller holding the `admin` daemon
  // scope — which the daemon OWNER holds implicitly. Defined inline so this
  // change is self-contained until the sibling change lands; the parent
  // reconciles at merge. Solo mode (no shared daemon-access store) is single-
  // tenant — the local caller IS the host, so the audit is permitted.
  private async isAuditVisible(workspaceId: string, userId: string): Promise<boolean> {
    const pg = this.storage.pg;
    if (!pg) return true; // solo / single-tenant host
    const daemonId = this.serverId;
    if (!daemonId) return false;
    const scopes = await pg.getUserDaemonScopes(workspaceId, daemonId, userId);
    return scopes.has("admin");
  }

  // Serve a torn-down ephemeral session's durable transcript to an auditor, or
  // emit not_found. Pure durable read — never revives. Extracted from
  // handleFetchAgentTimeline (complexity budget).
  private async serveTornDownTimeline(
    parsed: {
      requestId: string;
      workspaceId: string;
      agentId: string;
      cursor?: string;
      limit?: number;
      direction?: "older" | "newer";
    },
    userId: string,
    emit: EmitFn,
  ): Promise<void> {
    if (await this.isTornDownEphemeralAuditable(parsed.workspaceId, parsed.agentId, userId)) {
      const items = await this.fetchDurableTimelineRows(parsed);
      emit({
        type: "cyborg:fetch_agent_timeline_response",
        payload: { requestId: parsed.requestId, ...items },
      });
      return;
    }
    emit({
      type: "cyborg:error",
      payload: {
        requestId: parsed.requestId,
        code: "not_found",
        message: "Agent not found in workspace",
      },
    });
  }

  // True when an absent-binding session is a torn-down ephemeral one this
  // requester may audit: we captured its context for THIS workspace AND the
  // requester passes the audit predicate (#994). Keeps handleFetchAgentTimeline's
  // complexity in budget.
  private async isTornDownEphemeralAuditable(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<boolean> {
    const captured = this.storage.getEphemeralSessionContext(agentId);
    if (!captured || captured.workspace_id !== workspaceId) return false;
    return this.isAuditVisible(workspaceId, userId);
  }

  // Durable-only timeline read for an audit-visible session whose live binding is
  // gone (torn-down ephemeral). Mirrors the durable branch of
  // handleFetchAgentTimeline (pagination + agent-image URL rewrite) but never
  // touches the live window or any revive path. Returns an empty page when no
  // durable store is wired.
  private async fetchDurableTimelineRows(parsed: {
    agentId: string;
    cursor?: string;
    limit?: number;
    direction?: "older" | "newer";
  }): Promise<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
    hasMore: boolean;
    olderCursor: string | null;
    hasOlder: boolean;
  }> {
    if (!this.durableTimelineStore) {
      return { items: [], nextCursor: null, hasMore: false, olderCursor: null, hasOlder: false };
    }
    const cursor = parsed.cursor ? JSON.parse(parsed.cursor) : undefined;
    const limit = parsed.limit ?? 50;
    const wantOlder = parsed.direction === "older";
    let durableDirection: "before" | "after" | "tail";
    if (wantOlder) durableDirection = "before";
    else if (cursor) durableDirection = "after";
    else durableDirection = "tail";
    const result = await this.durableTimelineStore.fetchCommitted(parsed.agentId, {
      direction: durableDirection,
      cursor,
      limit,
    });
    const items = result.rows.map((row) => row.item as Record<string, unknown>);
    for (const item of items) {
      if (item.type === "assistant_message" && typeof item.text === "string") {
        item.text = rewriteAgentImageUrls(item.text);
      }
    }
    const olderCursor =
      result.hasOlder && result.rows.length > 0
        ? JSON.stringify({ epoch: result.epoch, seq: result.rows[0].seq })
        : null;
    return {
      items,
      nextCursor: result.hasNewer
        ? JSON.stringify({ epoch: result.epoch, seq: result.window.maxSeq })
        : null,
      hasMore: result.hasNewer,
      olderCursor,
      hasOlder: result.hasOlder ?? false,
    };
  }

  // Read-only session viewer (#994): serve the captured INJECTED CONTEXT bundle
  // for an ephemeral session (system prompt + tools made available + routed/raw
  // prompt), with secrets redacted. context:null for a non-ephemeral agent (the
  // viewer then shows only the transcript). Authorized by the SAME audit
  // predicate as the timeline read. PURE READ — never attaches/loads/revives.
  private async handleFetchSessionContext(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchSessionContextRequestSchema.parse(msg);
    if (!(await this.isAuditVisible(parsed.workspaceId, auth.user.id))) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "forbidden", message: "Not authorized" },
      });
      return;
    }
    const captured = this.storage.getEphemeralSessionContext(parsed.agentId);
    const context =
      captured && captured.workspace_id === parsed.workspaceId
        ? toRedactedSessionContext(captured)
        : null;
    emit({
      type: "cyborg:fetch_session_context_response",
      payload: { requestId: parsed.requestId, context },
    });
  }

  private async handleFetchAgentTimeline(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchAgentTimelineRequestSchema.parse(msg);
    const binding = this.storage.getAgentBinding(parsed.agentId);
    if (!binding || binding.workspace_id !== parsed.workspaceId) {
      // No live binding — a TORN-DOWN ephemeral session still has durable rows.
      // Serve them attach-free to an auditor, else not_found (#994). Extracted to
      // keep this handler's complexity in budget.
      await this.serveTornDownTimeline(parsed, _auth.user.id, emit);
      return;
    }

    if (!this.agentManager) {
      emit({
        type: "cyborg:fetch_agent_timeline_response",
        payload: { requestId: parsed.requestId, items: [], nextCursor: null, hasMore: false },
      });
      return;
    }

    const cursor = parsed.cursor ? JSON.parse(parsed.cursor) : undefined;
    const limit = parsed.limit ?? 50;
    // Scroll-up lazy-load: page BACKWARD from the cursor (the oldest entry the
    // client holds). The legacy path (no direction) keeps tail/after semantics.
    const wantOlder = parsed.direction === "older";

    let items: Record<string, unknown>[] = [];
    let nextCursor: string | null = null;
    let hasMore = false;
    let olderCursor: string | null = null;
    let hasOlder = false;

    // The cursor to page FURTHER back: the oldest row's seq (rows are ascending),
    // emitted only while older history remains.
    const buildOlderCursor = (
      rows: Array<{ seq: number }>,
      more: boolean | undefined,
      epoch: unknown,
    ): string | null =>
      more && rows.length > 0 ? JSON.stringify({ epoch, seq: rows[0].seq }) : null;

    // "older" always reads the durable store: the live in-memory window only serves
    // tail/after, so it can't page backward.
    const live = wantOlder ? null : this.agentManager.getAgent(parsed.agentId);
    let liveWindowMinSeq: number | null = null;
    let liveEpoch: string | null = null;
    if (live) {
      const result = this.agentManager.fetchTimeline(parsed.agentId, { cursor, limit });
      items = result.rows.map((row) => row.item as Record<string, unknown>);
      nextCursor = result.hasNewer
        ? JSON.stringify({ epoch: result.epoch, seq: result.window.maxSeq })
        : null;
      hasMore = result.hasNewer;
      hasOlder = result.hasOlder ?? false;
      olderCursor = buildOlderCursor(result.rows, result.hasOlder, result.epoch);
      liveWindowMinSeq = result.window.minSeq;
      liveEpoch = result.epoch;
    }

    // Reconcile a live agent's (possibly false) hasOlder against the durable store —
    // see reconcileLiveOlder for the why. Extracted to keep this handler's complexity
    // in budget.
    ({ hasOlder, olderCursor } = await this.reconcileLiveOlder({
      agentId: parsed.agentId,
      isLive: !!live,
      wantOlder,
      hasOlder,
      olderCursor,
      itemCount: items.length,
      oldestHeldSeq: liveWindowMinSeq,
      epoch: liveEpoch,
    }));

    if ((items.length === 0 || wantOlder) && this.durableTimelineStore) {
      let durableDirection: "before" | "after" | "tail";
      if (wantOlder) durableDirection = "before";
      else if (cursor) durableDirection = "after";
      else durableDirection = "tail";
      const result = await this.durableTimelineStore.fetchCommitted(parsed.agentId, {
        direction: durableDirection,
        cursor,
        limit,
      });
      items = result.rows.map((row) => row.item as Record<string, unknown>);
      nextCursor = result.hasNewer
        ? JSON.stringify({ epoch: result.epoch, seq: result.window.maxSeq })
        : null;
      hasMore = result.hasNewer;
      hasOlder = result.hasOlder ?? false;
      olderCursor = buildOlderCursor(result.rows, result.hasOlder, result.epoch);
    }

    // #845 inline render: rewrite any agent-image local path to its uploaded S3
    // URL. The durable rows are rewritten on upload, but the LIVE in-memory window
    // (served while the agent is still running) still holds the original local
    // token — this covers a soft reload mid-session. No-op once the token is
    // already an S3 URL (durable path).
    for (const item of items) {
      if (item.type === "assistant_message" && typeof item.text === "string") {
        item.text = rewriteAgentImageUrls(item.text);
      }
    }

    emit({
      type: "cyborg:fetch_agent_timeline_response",
      payload: { requestId: parsed.requestId, items, nextCursor, hasMore, olderCursor, hasOlder },
    });
  }

  // ─── Archived Sessions ──────────────────────────────────────────

  // oxlint-disable-next-line eslint/complexity -- flat control flow, just many null-coalescing chains
  private async handleArchiveAgent(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgArchiveAgentRequestSchema.parse(msg);
    const agent = this.agentManager?.getAgent(parsed.agentId);
    const binding = this.storage.getAgentBinding(parsed.agentId);

    if (!agent && !binding) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, error: "Agent not found" },
      });
      return;
    }

    // Ownership guard (#810 security fix; previously _auth was unused, so any
    // member could archive anyone's private session). The SAME rule the relay's
    // offline-clear path uses: a SHARED channel agent (channel-bound AND
    // non-ephemeral) is archivable by ANY member; otherwise the session is PRIVATE
    // and archivable only by its INITIATOR (bridged by email/id) OR a workspace
    // OWNER/ADMIN (so an owner can clear members' clutter). Applied REGARDLESS of
    // whether a binding row exists — a LIVE agent with a null/orphaned binding must
    // NOT bypass the check. Identity is derived from the binding when present, else
    // the live agent's labels (which never carry the initiator), so a null-binding
    // PRIVATE session is archivable only by an owner/admin, never a random member.
    {
      const channelId = binding?.channel_id ?? agent?.labels?.channelId ?? null;
      // PG/SQLite ephemeral bindings are torn down with their agent, so a non-null
      // binding tells us ephemeral-ness; a null binding ⇒ treat as non-ephemeral.
      const isEphemeral = binding ? binding.ephemeral === 1 : false;
      const isSharedChannelAgent = !!channelId && !isEphemeral;
      if (!isSharedChannelAgent) {
        // PRIVATE: allow the initiator OR a workspace owner/admin.
        const initiatorId = binding?.initiated_by ?? null;
        let isInitiator = false;
        if (initiatorId) {
          // initiatorId is a LOCAL SQLite id; auth.user.id can be a CLOUD id for
          // the same person (divergent namespaces). Bridge by email when the raw
          // ids differ — only a genuinely different account fails the match.
          if (initiatorId === auth.user.id) {
            isInitiator = true;
          } else {
            const initiator = this.storage.getUserById(initiatorId);
            isInitiator =
              !!initiator?.email && !!auth.user.email && initiator.email === auth.user.email;
          }
        }
        const role = this.workspaceManager.getMemberRole(parsed.workspaceId, auth.user.id);
        const isAdmin = role === "owner" || role === "admin";
        if (!isInitiator && !isAdmin) {
          emit({
            type: "cyborg:error",
            payload: {
              requestId: parsed.requestId,
              code: "forbidden",
              message: "Cannot archive another user's private agent session",
            },
          });
          return;
        }
      }
    }

    const provider = agent?.provider ?? binding?.provider ?? "unknown";
    const providerHandleId =
      agent?.persistence?.nativeHandle ?? agent?.persistence?.sessionId ?? "";
    const rawTitle = agent?.persistence?.metadata?.title;
    const title = typeof rawTitle === "string" ? rawTitle : null;
    const model =
      typeof agent?.config?.model === "string" ? agent.config.model : (binding?.model ?? null);
    const cwd = agent?.cwd ?? null;
    const cyboId = agent?.labels?.cyboId ?? binding?.cybo_id ?? null;

    // If this agent was resumed from an existing archived session, REVIVE that
    // same history row (refresh its metadata + timestamp, clear the live link)
    // instead of inserting a duplicate. Otherwise archive as a fresh session.
    const resumedFrom = this.storage.getArchivedSessionByResumedAgent(parsed.agentId);
    const session = resumedFrom
      ? (this.storage.reviveArchivedSession({
          id: resumedFrom.id,
          providerHandleId,
          title,
          cwd,
          model,
          cyboId,
        }) ?? resumedFrom)
      : this.storage.archiveSession({
          workspaceId: parsed.workspaceId,
          provider,
          providerHandleId,
          title,
          cwd,
          model,
          cyboId,
        });

    this.storage.archiveAgentSessionRow(parsed.agentId);
    this.storage.deleteAgentBinding(parsed.agentId);
    if (agent && this.agentManager) {
      try {
        await this.agentManager.archiveAgent(parsed.agentId);
      } catch {
        // Best effort — agent may already be stopped
      }
    }

    emit({
      type: "cyborg:archive_agent_response",
      payload: { requestId: parsed.requestId, sessionId: session.id },
    });
  }

  // Build a cybo id → {name, avatar} map for denormalizing list_agents and
  // archived-session responses server-side, so a cybo session reads "Apex" with
  // its photo instead of its raw provider ("opencode-go" / "pi session") and a
  // generic icon. PG (workspace-shared) FIRST — a cybo created via the cloud
  // lives ONLY there; then local SQLite + disk for solo/standalone cybos. This is
  // the reliable path (the client-side cyboState match kept regressing on id
  // duality and load timing).
  private async buildCyboInfoMap(
    workspaceId: string,
  ): Promise<Map<string, { name: string; avatar: string | null }>> {
    const map = new Map<string, { name: string; avatar: string | null }>();
    const pg = this.storage.pg;
    if (pg) {
      try {
        for (const c of await pg.getCybos(workspaceId)) {
          map.set(c.id, { name: c.name, avatar: c.avatar ?? null });
        }
      } catch {
        // PG read failed — fall back to local/disk below.
      }
    }
    for (const c of this.storage.getCybos(workspaceId)) {
      if (!map.has(c.id)) map.set(c.id, { name: c.name, avatar: c.avatar ?? null });
    }
    for (const c of await scanLocalCybos()) {
      if (!map.has(c.id)) map.set(c.id, { name: c.name, avatar: c.avatar ?? null });
    }
    return map;
  }

  private async handleListArchivedSessions(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgListArchivedSessionsRequestSchema.parse(msg);
    // Keyset-paginated read (newest-first). `nextCursor` is computed off the RAW
    // page (before the de-dup below) so the keyset advances correctly even when
    // the anchor row is hidden. No limit ⇒ full list + null cursor (back-compat).
    const { sessions: pageRows, nextCursor } = this.storage.getArchivedSessionsPage(
      parsed.workspaceId,
      { limit: parsed.limit, cursor: parsed.cursor },
    );
    // De-duplicate: a session that has been resumed into a still-live agent is
    // shown in the ACTIVE list (via its binding), so hide it from history while
    // the binding exists — otherwise it would appear in both places. If the
    // binding is gone (agent fully removed) the row is shown again so the session
    // is never unreachable.
    const rows = pageRows.filter(
      (r) => !r.resumed_agent_id || !this.storage.getAgentBinding(r.resumed_agent_id),
    );
    const cyboInfo = await this.buildCyboInfoMap(parsed.workspaceId);
    emit({
      type: "cyborg:list_archived_sessions_response",
      payload: {
        requestId: parsed.requestId,
        sessions: rows
          .map((r) => {
            const info = r.cybo_id ? cyboInfo.get(r.cybo_id) : undefined;
            return {
              id: r.id,
              provider: r.provider,
              providerHandleId: r.provider_handle_id,
              title: r.title,
              cwd: r.cwd,
              model: r.model,
              cyboId: r.cybo_id,
              cyboName: info?.name ?? null,
              cyboAvatar: info?.avatar ?? null,
              archivedAt: r.archived_at,
            };
          })
          .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
        nextCursor,
      },
    });
  }

  private async handleRestoreSession(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgRestoreSessionRequestSchema.parse(msg);
    const session = this.storage.getArchivedSession(parsed.sessionId);

    if (!session) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, error: "Archived session not found" },
      });
      return;
    }

    if (!this.agentManager || !this.agentStorage || !this.logger) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, error: "Agent manager not available" },
      });
      return;
    }

    // Optional resume overrides (#593): boot the restored agent on a chosen
    // model/mode/thinking instead of the archived config, so the FIRST hydration
    // already uses the override (no restore-then-setModel round-trip). Only the
    // fields the caller actually set are forwarded; an empty object ⇒ no override
    // ⇒ exactly the legacy behavior. cwd is always pinned (as before) so the
    // resumed session lands in the archived working directory. The merge shape is
    // a pure, unit-tested helper (resume-overrides.ts).
    const cwd = session.cwd ?? undefined;
    const resumeOverrides = buildResumeOverrides({ cwd, overrides: parsed.overrides });
    const hasConfigOverrides = hasResumeConfigOverrides(parsed.overrides);

    const snapshot = hasConfigOverrides
      ? await this.resumeArchivedSessionWithOverrides(session, resumeOverrides)
      : (
          await (
            await import("../agent/import-sessions.js")
          ).importProviderSession({
            request: {
              provider: session.provider,
              providerHandleId: session.provider_handle_id,
              cwd,
              requestId: parsed.requestId,
            },
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.logger,
          })
        ).snapshot;

    this.storage.createAgentBinding({
      agentId: snapshot.id,
      workspaceId: parsed.workspaceId,
      provider: session.provider,
      // Persist the model the session actually resumed ON (the override when one
      // was applied, falling back to the live runtimeInfo, then the archived
      // model) so the sidebar/roster reflect reality after a model override.
      model: snapshot.runtimeInfo?.model ?? parsed.overrides?.model ?? session.model,
      cyboId: session.cybo_id,
      initiatedBy: auth.user.id,
      // Real canonical email so the resumed session's offline row attributes to
      // its owner (not the local <id>@remote.local placeholder). See #810.
      initiatedByEmail: auth.user.email ?? null,
      cwd: snapshot.cwd ?? session.cwd ?? null,
    });

    // DATA-LOSS FIX: do NOT hard-delete the archived row on resume. Deleting it
    // meant that if the resumed live session then died (or was never re-archived),
    // the session vanished from history permanently. Instead we KEEP the row and
    // link it to the live agent. handleListArchivedSessions hides it from history
    // while the binding exists (it's reachable via the active list); handleArchiveAgent
    // revives the SAME row on re-archive (no duplicate). If the agent's binding is
    // ever gone the row reappears in history — the session is never lost.
    this.storage.markArchivedSessionResumed(parsed.sessionId, snapshot.id);

    emit({
      type: "cyborg:restore_session_response",
      payload: { requestId: parsed.requestId, agentId: snapshot.id },
    });
  }

  // Cloud FORWARD-path twin of session.ts's handleFetchRecentProviderSessions
  // (#resume picker, "Local import" tab). A guest on the relay can't reach this
  // daemon's Paseo session directly, so the relay forwards the Paseo-native scan
  // here (relay_rpc.inner); we run the SAME on-disk transcript scan and emit the
  // SAME fetch_recent_provider_sessions_response the local path emits — the UI
  // correlates by requestId, so the wire shape must match. providerSnapshotManager
  // is synthesized from the dispatcher's own providerRegistry (the injected snapshot
  // manager Pick omits getProviderLabel); the label is cosmetic, falling back to the
  // provider id. On failure we log + emit a typed rpc_error the UI already handles
  // (it rejects the pending request → the picker shows the "needs a running local
  // daemon" hint), never a silent swallow.
  private async handleForwardedRecentProviderSessions(msg: CyborgMsg, emit: EmitFn): Promise<void> {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    try {
      if (!this.agentManager || !this.agentStorage) {
        throw new Error("Agent manager not available");
      }
      const parsed = FetchRecentProviderSessionsRequestMessageSchema.parse(msg);
      const providerSnapshotManager: Pick<ProviderSnapshotManager, "getProviderLabel"> = {
        getProviderLabel: (provider) => this.providerRegistry?.[provider]?.label ?? provider,
      };
      const { listImportableProviderSessions } = await import("../agent/import-sessions.js");
      const result = await listImportableProviderSessions({
        request: parsed,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        providerSnapshotManager,
      });
      emit({
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: parsed.requestId,
          entries: result.entries,
          ...(result.filteredAlreadyImportedCount > 0
            ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
            : {}),
        },
      });
    } catch (err) {
      this.logger?.error(
        { err },
        "Failed to handle forwarded fetch_recent_provider_sessions_request",
      );
      emit({
        type: "rpc_error",
        payload: {
          requestId,
          requestType: "fetch_recent_provider_sessions_request",
          error: err instanceof Error ? err.message : "Failed to fetch recent provider sessions",
          code: "fetch_recent_provider_sessions_failed",
        },
      });
    }
  }

  // Bring a LOCAL provider transcript INTO this workspace. The importable-sessions
  // picker hands us a recent provider session (handle + cwd); we resume it into a
  // LIVE agent via Paseo's importProviderSession (the same primitive
  // restore_session uses), bind it to the workspace so it shows in the active
  // roster, AND persist a Cyborg archived_sessions row — mirrored to PG via
  // DualStorage — so the session is durable, lands in the CLOUD archived-session
  // history once it's no longer live, and is re-resumable from any device via the
  // existing restore_session path. The archive write is IDEMPOTENT on (workspace,
  // provider, providerHandleId): re-importing the same transcript reuses the
  // existing row + its still-live agent instead of duplicating either.
  private async handleImportSession(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgImportSessionRequestSchema.parse(msg);

    // Importing resumes a NEW live agent into the workspace, so gate it on the
    // same permission as create_agent (the relay enforces the daemon spawn scope
    // upstream; this explicit workspace check mirrors handleCreateAgent for
    // defense in depth).
    const { allowed } = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "create_agent",
    );
    if (!allowed) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "Cannot import session",
        },
      });
      return;
    }

    if (!this.agentManager || !this.agentStorage || !this.logger) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, error: "Agent manager not available" },
      });
      return;
    }

    // Single-flight by (workspace, provider, providerHandleId): without this,
    // two concurrent imports of the SAME transcript both clear the idempotent
    // "already live" short-circuit below and each spawn a DUPLICATE agent.
    // Concurrent callers for the same key share ONE import+archive and the same
    // result (each still emits under ITS OWN requestId); different keys never
    // block. The entry clears on settle so a failed import can be retried.
    const inFlightKey = `${parsed.workspaceId}:${parsed.provider}:${parsed.providerHandleId}`;
    let inFlight = this.importSessionInFlight.get(inFlightKey);
    if (!inFlight) {
      inFlight = this.runImportSession(parsed, auth).finally(() => {
        this.importSessionInFlight.delete(inFlightKey);
      });
      this.importSessionInFlight.set(inFlightKey, inFlight);
    }

    try {
      const result = await inFlight;
      emit({
        type: "cyborg:import_session_response",
        payload: {
          requestId: parsed.requestId,
          agentId: result.agentId,
          sessionId: result.sessionId,
        },
      });
    } catch (err) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "agent_error",
          message: err instanceof Error ? err.message : "Failed to import session",
        },
      });
    }
  }

  // Core of handleImportSession — runs UNDER the in-flight guard so a single
  // transcript is imported + archived exactly once even under concurrent
  // requests. Returns the resolved { agentId, sessionId } for each caller to emit
  // under its own requestId; throws on failure so the guard entry clears and the
  // error surfaces to every waiting caller. Keeps the idempotent get-or-create
  // archive logic verbatim.
  private async runImportSession(
    parsed: z.infer<typeof CyborgImportSessionRequestSchema>,
    auth: CyborgAuthContext,
  ): Promise<{ agentId: string; sessionId: string }> {
    const agentManager = this.agentManager;
    const agentStorage = this.agentStorage;
    const logger = this.logger;
    if (!agentManager || !agentStorage || !logger) {
      throw new Error("Agent manager not available");
    }

    // IDEMPOTENT short-circuit: if this transcript was already imported into a
    // still-live agent (its archived row points at a live binding), return that
    // agent + row instead of importing a duplicate.
    const existing = this.findArchivedSessionByProviderHandle(
      parsed.workspaceId,
      parsed.provider,
      parsed.providerHandleId,
    );
    if (existing?.resumed_agent_id && this.storage.getAgentBinding(existing.resumed_agent_id)) {
      return { agentId: existing.resumed_agent_id, sessionId: existing.id };
    }

    const cwd = parsed.cwd ?? existing?.cwd ?? undefined;
    const snapshot: ManagedAgent = (
      await (
        await import("../agent/import-sessions.js")
      ).importProviderSession({
        request: {
          provider: parsed.provider,
          providerHandleId: parsed.providerHandleId,
          cwd,
          requestId: parsed.requestId,
        },
        agentManager,
        agentStorage,
        logger,
      })
    ).snapshot;

    return this.persistImportedSession({ snapshot, parsed, auth, existing, cwd });
  }

  // Persist an imported live session: extract its archive-shaped metadata, bind it
  // to the workspace, record the history row, and get-or-create + link its durable
  // archived_sessions record. Extracted from runImportSession so that method stays
  // under the oxlint complexity budget (the metadata `??` chain + revive/insert
  // ternary are the complexity drivers).
  private persistImportedSession(opts: {
    snapshot: ManagedAgent;
    parsed: z.infer<typeof CyborgImportSessionRequestSchema>;
    auth: CyborgAuthContext;
    existing: ReturnType<CyborgDispatcher["findArchivedSessionByProviderHandle"]>;
    cwd: string | undefined;
  }): { agentId: string; sessionId: string } {
    const { snapshot, parsed, auth, existing, cwd } = opts;

    // Live-agent metadata, resolved the SAME way handleArchiveAgent extracts it so
    // the persisted row matches a normally-archived session's shape.
    const providerHandleId =
      snapshot.persistence?.nativeHandle ??
      snapshot.persistence?.sessionId ??
      parsed.providerHandleId;
    const rawTitle = snapshot.persistence?.metadata?.title;
    const title = typeof rawTitle === "string" ? rawTitle : null;
    const model = snapshot.runtimeInfo?.model ?? snapshot.config.model ?? null;
    const resolvedCwd = snapshot.cwd ?? cwd ?? null;
    const cyboId = snapshot.labels?.cyboId ?? null;

    // Bind the live agent to the workspace so it shows in the active roster
    // (handleListAgents reads bindings), mirroring restore_session.
    this.storage.createAgentBinding({
      agentId: snapshot.id,
      workspaceId: parsed.workspaceId,
      channelId: parsed.channelId,
      provider: parsed.provider,
      model,
      cyboId,
      daemonId: this.serverId,
      initiatedBy: auth.user.id,
      // Real canonical email so the imported session's offline row attributes to
      // its owner (not the local <id>@remote.local placeholder). See #810.
      initiatedByEmail: auth.user.email ?? null,
      cwd: resolvedCwd,
    });

    // Best-effort session-history row for the Home "This week" stats (PG-only),
    // parity with handleCreateAgent.
    this.storage.recordAgentSessionStart({
      agentId: snapshot.id,
      workspaceId: parsed.workspaceId,
      channelId: parsed.channelId ?? null,
      userId: auth.user.id,
      provider: parsed.provider,
      cyboId,
      sessionType: cyboId ? "cybo" : "session",
      cwd: resolvedCwd,
    });

    // Durable Cyborg archived_sessions record (mirrored to PG via DualStorage).
    // Get-or-create by (workspace, provider, providerHandleId): REVIVE an existing
    // row (refresh metadata + timestamp) or INSERT a fresh one, never duplicate.
    // Then link it to the live agent (resumed_agent_id) exactly like
    // restore_session, so it's reachable via the active roster while live and
    // returns to history — without duplication — when the agent is re-archived.
    const session = existing
      ? (this.storage.reviveArchivedSession({
          id: existing.id,
          providerHandleId,
          title,
          cwd: resolvedCwd,
          model,
          cyboId,
        }) ?? existing)
      : this.storage.archiveSession({
          workspaceId: parsed.workspaceId,
          provider: parsed.provider,
          providerHandleId,
          title,
          cwd: resolvedCwd,
          model,
          cyboId,
        });
    this.storage.markArchivedSessionResumed(session.id, snapshot.id);

    return { agentId: snapshot.id, sessionId: session.id };
  }

  // Look up the (single) archived row for a local provider transcript in a
  // workspace, keyed on (provider, providerHandleId). Used to make import
  // idempotent — re-importing the same transcript reuses this row instead of
  // inserting a duplicate. Reads via getArchivedSessions (SQLite-first through
  // DualStorage); a workspace's archived list is small, so the in-memory scan is
  // cheap and avoids a new prepared statement.
  private findArchivedSessionByProviderHandle(
    workspaceId: string,
    provider: string,
    providerHandleId: string,
  ): StoredArchivedSession | undefined {
    return this.storage
      .getArchivedSessions(workspaceId)
      .find((r) => r.provider === provider && r.provider_handle_id === providerHandleId);
  }

  // Resume an archived session directly with config overrides (#593). Mirrors the
  // essential public steps of importProviderSession (which hardcodes only a `cwd`
  // override and has no hook for model/mode/thinking), but threads the caller's
  // overrides into Paseo's resumeAgentFromPersistence — the method already merges
  // `handle.metadata ⊕ overrides` and re-applies the model/mode on resume, and it
  // throws if the provider isn't available. We do NOT modify Paseo's agent/ code;
  // we only call its public API + the exported unarchiveAgentState helper. The
  // no-override path stays on importProviderSession verbatim (zero regression).
  private async resumeArchivedSessionWithOverrides(
    session: StoredArchivedSession,
    overrides: Partial<AgentSessionConfig>,
  ): Promise<ManagedAgent> {
    if (!this.agentManager || !this.agentStorage) {
      throw new Error("Agent manager not available");
    }
    const agentManager = this.agentManager;
    const agentStorage = this.agentStorage;
    const provider = session.provider as AgentProvider;
    const cwd = session.cwd ?? undefined;
    const descriptor = await agentManager.findPersistedAgent(provider, session.provider_handle_id, {
      cwd,
    });
    if (!descriptor && provider === "opencode" && !cwd) {
      // Mirror importProviderSession's guard: OpenCode can't resolve a handle
      // without a cwd, and there's nothing to resume.
      throw new Error(
        "OpenCode sessions require a recorded cwd when the session is not in persisted agents",
      );
    }
    // Mirror importProviderSession: prefer the discovered handle (applying the cwd
    // override when present), else synthesize a minimal handle from the archived
    // identifiers so resume parity with the no-override path holds.
    let handle: AgentPersistenceHandle;
    if (descriptor) {
      handle = cwd
        ? {
            ...descriptor.persistence,
            metadata: { ...descriptor.persistence.metadata, provider, cwd },
          }
        : descriptor.persistence;
    } else {
      handle = {
        provider,
        sessionId: session.provider_handle_id,
        nativeHandle: session.provider_handle_id,
        metadata: { provider, cwd: cwd ?? process.cwd() },
      };
    }
    // Clear any local archived flag for this handle before re-registering (the
    // same bookkeeping importProviderSession does via its private helper).
    const records = await agentStorage.list();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (matched) {
      await unarchiveAgentState(agentStorage, agentManager, matched.id);
    }
    const snapshot = await agentManager.resumeAgentFromPersistence(handle, overrides);
    await unarchiveAgentState(agentStorage, agentManager, snapshot.id);
    await agentManager.hydrateTimelineFromProvider(snapshot.id);
    return snapshot;
  }

  // ─── Projects ──────────────────────────────────────────────────

  private async handleCreateProject(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgCreateProjectRequestSchema.parse(msg);
    const project = this.storage.createProject(parsed.workspaceId, parsed.name, parsed.color);
    // Auto-provision the partner Tasks-project (+ default states) so the Tasks
    // side is never lazily missing. Best-effort + idempotent: a failure here must
    // not fail the chat-project create — log and continue.
    try {
      this.storage.provisionTasksProject({
        workspaceId: parsed.workspaceId,
        chatProjectId: project.id,
        name: parsed.name,
        color: parsed.color,
      });
    } catch (err) {
      this.logger?.error(
        { err, workspaceId: parsed.workspaceId, chatProjectId: project.id },
        "[create_project] tasks-project provisioning failed (continuing)",
      );
    }
    emit({
      type: "cyborg:create_project_response",
      payload: {
        requestId: parsed.requestId,
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          createdAt: project.created_at,
        },
      },
    });
  }

  private async handleFetchProjects(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgFetchProjectsRequestSchema.parse(msg);
    const projects = this.storage.getProjects(parsed.workspaceId);
    const channelProjects = this.storage.getChannelProjects(parsed.workspaceId);
    emit({
      type: "cyborg:fetch_projects_response",
      payload: {
        requestId: parsed.requestId,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          createdAt: p.created_at,
        })),
        channelProjects: channelProjects.map((cp) => ({
          channelId: cp.channel_id,
          projectId: cp.project_id,
        })),
      },
    });
  }

  private async handleUpdateProject(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgUpdateProjectRequestSchema.parse(msg);
    this.storage.updateProject(parsed.projectId, parsed.name, parsed.color);
    emit({
      type: "cyborg:update_project_response",
      payload: { requestId: parsed.requestId },
    });
  }

  private async handleDeleteProject(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgDeleteProjectRequestSchema.parse(msg);
    this.storage.deleteProject(parsed.projectId);
    emit({
      type: "cyborg:delete_project_response",
      payload: { requestId: parsed.requestId },
    });
  }

  private async handleSetChannelProject(
    msg: CyborgMsg,
    _auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetChannelProjectRequestSchema.parse(msg);
    if (parsed.projectId) {
      this.storage.setChannelProject(parsed.channelId, parsed.projectId);
    } else {
      this.storage.clearChannelProject(parsed.channelId);
    }
    emit({
      type: "cyborg:set_channel_project_response",
      payload: { requestId: parsed.requestId },
    });
  }

  // Per-channel auto-tasks (channel watcher) opt-IN switch. The watcher only
  // auto-spawns a cybo when this is explicitly enabled (default OFF). Turning
  // autonomy on is a managed action: require the channel creator or a workspace
  // admin/owner (the local mirror of the relay's creator/ws-admin/channel-admin
  // gate; SQLite has no per-channel role table).
  private async handleSetChannelAutoTasks(
    msg: CyborgMsg,
    auth: CyborgAuthContext,
    emit: EmitFn,
  ): Promise<void> {
    const parsed = CyborgSetChannelAutoTasksRequestSchema.parse(msg);
    const channel = this.storage.getChannel(parsed.channelId);
    if (!channel || channel.workspace_id !== parsed.workspaceId) {
      emit({
        type: "cyborg:error",
        payload: { requestId: parsed.requestId, code: "not_found", message: "Channel not found" },
      });
      return;
    }
    const isCreator = channel.created_by === auth.user.id;
    const isWsAdmin = this.workspaceManager.checkPermission(
      parsed.workspaceId,
      auth.user.id,
      "manage_agents",
    ).allowed;
    if (!isCreator && !isWsAdmin) {
      emit({
        type: "cyborg:error",
        payload: {
          requestId: parsed.requestId,
          code: "forbidden",
          message: "You don't have permission to change this channel's auto-tasks",
        },
      });
      return;
    }
    this.storage.setChannelAutoTasksEnabled(parsed.channelId, parsed.enabled);
    emit({
      type: "cyborg:set_channel_auto_tasks_response",
      payload: {
        requestId: parsed.requestId,
        channelId: parsed.channelId,
        enabled: parsed.enabled,
      },
    });
  }

  private async handleListRecentCwds(msg: CyborgMsg, emit: EmitFn): Promise<void> {
    const parsed = CyborgListRecentCwdsRequestSchema.parse(msg);
    const home = process.env.HOME ?? process.cwd();

    let recent: string[] = [];
    if (this.agentStorage) {
      const agents = await this.agentStorage.list();
      const cwdMap = new Map<string, string>();
      for (const a of agents) {
        if (a.cwd && a.cwd !== home) {
          cwdMap.set(a.cwd, a.lastActivityAt ?? a.updatedAt);
        }
      }
      recent = Array.from(cwdMap.entries())
        .sort((a, b) => b[1].localeCompare(a[1]))
        .map(([cwd]) => cwd)
        .slice(0, 8);
    }

    emit({
      type: "cyborg:list_recent_cwds_response",
      payload: { requestId: parsed.requestId, home, recent },
    });
  }
}

function buildSystemPrompt(workspaceId: string, custom?: string): string {
  const base = [
    "You are an AI agent in a Cyborg7 collaborative workspace.",
    `Workspace ID: ${workspaceId}`,
    "You have access to cyborg7 MCP tools for messaging, tasks, and workspace operations.",
    "When you receive a message from a channel, respond using the cyborg7_send_message tool.",
    "Always identify yourself by name. Be concise and helpful.",
  ].join("\n");
  return custom ? `${base}\n\n${custom}` : base;
}

function formatMessage(m: StorageMessage) {
  let mentions: string[] | null = null;
  if (m.mentions) {
    mentions = typeof m.mentions === "string" ? JSON.parse(m.mentions) : m.mentions;
  }
  let attachments: unknown[] | null = null;
  if (m.attachments) {
    attachments = typeof m.attachments === "string" ? JSON.parse(m.attachments) : m.attachments;
  }
  return {
    id: m.id,
    channelId: m.channel_id,
    fromId: m.from_id,
    fromType: m.from_type,
    fromName: m.from_name,
    toId: m.to_id,
    text: m.text,
    mentions,
    parentId: m.parent_id,
    attachments,
    pinnedAt: m.pinned_at ?? null,
    pinnedBy: m.pinned_by ?? null,
    updatedAt: m.updated_at ?? null,
    replyCount: m.reply_count ?? 0,
    lastReplyAt: m.last_reply_at ?? null,
    seq: m.seq,
    createdAt: m.created_at,
  };
}
