// Daemon-side terminal sessions for the cloud relay protocol (#654).
//
// Wraps the inherited terminal engine (TerminalManager + TerminalSession +
// TerminalOutputCoalescer, packages/server/src/terminal/) with the cyborg:*
// protocol: start/input/resize/kill in, terminal_output/terminal_exit out.
// Sessions are DAEMON-SCOPED (held in-memory here, never PG) and OWNER-LOCKED —
// only the user who started a terminal can drive or read it, a second gate
// behind the relay's daemon-access check (#31).
//
// VIEWERS ARE PASEO SUBSCRIPTIONS (internal docs P0b — finish the convergence).
// Each watching client view owns a REAL `session.subscribe()` forwarder rather
// than an entry in a hand-rolled fan-out Set fed by one shared subscription. This
// is the structural fix for the #778/#784/#789 bug class:
//   • Paseo's subscribe() (terminal.ts:971-1011) is ALREADY a multi-viewer
//     listener Set that, on every (re)subscribe, re-delivers a FULL screen
//     `snapshot` (terminal.ts:998) and then streams live `output` to THAT
//     listener. So one subscription == one viewer, snapshot-self-healing on every
//     resubscribe, multi-viewer-correct by construction — there is no parallel
//     ack to drop (#789) and no shared fan-out slot two viewers can clobber/
//     double-deliver (#778/#784).
//   • The controller's only job per viewer is to forward those frames as the
//     cyborg:* protocol (snapshot → cyborg:terminal_snapshot, coalesced output →
//     cyborg:terminal_output) to that viewer's emit, and to tear the subscription
//     down on unsubscribe.
//
// A SEPARATE session-level subscription (independent of any viewer) feeds the
// cross-restart persistence ring (#750) and the idle clock, so output keeps being
// buffered to disk even while the session is detached (zero viewers). The exit
// frame is fanned to every viewer via session.onExit().
//
// SESSION LIFECYCLE (internal docs GAP-1):
//   creating → live(viewers ≥1) ⇄ live(detached: 0 viewers)
//             → exiting → gone → (next boot) dead(history) → forgotten
// "live(detached)" is a first-class state: the pty keeps running and filling the
// persistence ring, but nothing renders it. The idle reaper keys off the pty's
// own liveness (getExitInfo), NOT viewer count, so a detached-but-alive session
// is never killed.
import { TerminalOutputCoalescer } from "../../terminal/terminal-output-coalescer.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { ServerMessage, TerminalSession } from "../../terminal/terminal.js";
import type { TerminalState } from "@getpaseo/protocol/messages";
import { canonicalUserId } from "./storage.js";
import type {
  DeadTerminalSession,
  PersistedTerminalMeta,
  TerminalEndedReason,
  TerminalPersistenceStore,
} from "./terminal-persistence.js";

export type TerminalEmit = (msg: unknown) => void;

// The minimal pino-shaped sink the controller logs owner-lock diagnostics to
// (#876 cloud-mode follow-up). Optional — a controller with no logger is silent.
// Only non-secret ids/emails are ever logged (never tokens).
export interface TerminalDiagLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

// One workspace-directory entry — the minimal pointer a sidebar row needs. `live`
// distinguishes a running pty from a post-restart history record (#750).
export interface TerminalDirectoryEntry {
  terminalId: string;
  workspaceId: string;
  daemonId: string | null;
  cwd: string | null;
  title?: string;
  startedAt: number;
  live: boolean;
}

// Notified whenever the set of tracked sessions for a (workspace, owner) changes —
// a start or an exit. The dispatcher wires this to broadcast cyborg:terminals_changed
// so any of the owner's clients refreshes its sidebar directory. Optional: a
// local-daemon controller with no directory consumer leaves it unset.
export type TerminalDirectoryChangeListener = (input: {
  workspaceId: string;
  ownerUserId: string;
}) => void;

// Per-daemon live-session ceiling — matches the inherited controller's slot cap
// (terminal-session-controller.ts MAX_TERMINAL_STREAM_SLOTS). Without it a client
// could spawn unbounded PTYs (each a real OS process), exhausting the host.
const MAX_TERMINAL_SESSIONS = 256;

// Recent-output budget retained per session for cross-restart history (#750): on
// daemon shutdown / shell exit the tail is persisted so a later daemon can replay
// it read-only. Bounded so a noisy program can't grow the daemon's memory without
// limit; the tail is what matters for "where was I", so we drop from the front.
const SCROLLBACK_LIMIT_BYTES = 256 * 1024;

// Idle-reap TTL for ORPHANED sessions (internal docs BUG-2 / GAP-1). The reaper's
// ONLY job is to reclaim sessions whose underlying pty has ALREADY EXITED but
// whose bookkeeping never got cleaned up (a missed onExit, a torn-down engine) —
// a real OS process is NOT involved, just a stale cap slot + subscriptions. It
// must NEVER kill a session whose pty is still RUNNING: a backgrounded Claude
// Code sitting idle-waiting-for-input produces no output (nothing bumps
// lastActivityAt) and has no viewer (the tab is switched away), yet its pty +
// agent process are very much alive — reaping that on a timer is the
// "session no longer available" bug. Liveness is read off the engine via
// session.getExitInfo() (null ⇒ alive), so a quiet-but-live session is spared no
// matter how long it has been idle. The TTL only paces how long a DEAD-but-
// uncleaned pty lingers before the sweep reclaims its slot.
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

// How often the reaper sweeps live sessions. Cheap O(n) scan over a map bounded
// by MAX_TERMINAL_SESSIONS.
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;

// One watching client view (one tab / one socket). It OWNS a real Paseo
// subscription (`unsub`) plus a per-viewer output coalescer (5ms batching so a
// noisy program produces a handful of frames per tick, not one per write). Two
// ways to identify a viewer for replace-in-place / unsubscribe:
// 1. attachId — a stable, client-minted per-mount id (internal docs GAP-1). The
//      cloud relay hands a FRESH emit closure to every forwarded RPC, so emit-
//      reference matching can't work across the subscribe→unsubscribe RPC
//      boundary. The client passes the same attachId on subscribe and unsubscribe.
//   2. emit REFERENCE — the in-process/desktop path, where one long-lived closure
//      drives both calls and no attachId is minted.
interface Viewer {
  emit: TerminalEmit;
  attachId?: string;
  // The user this viewer renders for. In the cloud/relay path the relay re-fans
  // every owner-tagged frame to ALL of this user's live sockets BY userId, so the
  // daemon must hold AT MOST ONE viewer per (terminal, userId) on that path — two
  // viewers for one user would each be re-fanned to the same socket and DOUBLE
  // every character (#807). Used by addViewer to collapse a leaked stale viewer.
  userId: string;
  // The viewer's own Paseo subscription teardown — called on unsubscribe / replace
  // / session cleanup so its listener is removed from terminal.ts's listener Set.
  unsub: () => void;
  // The viewer's own output coalescer; disposed alongside `unsub`.
  coalescer: TerminalOutputCoalescer;
}

interface TrackedTerminal {
  session: TerminalSession;
  // Session-level subscription that feeds the persistence ring + idle clock,
  // independent of any viewer (so a detached session keeps buffering to disk).
  unsubPersist: () => void;
  unsubExit: () => void;
  ownerUserId: string;
  // The owner's STABLE human identity (email) — the email-keyed owner-lock (#874).
  // ownerUserId is an OPAQUE per-store UUID that DIVERGES across layers (PG users.id
  // vs a fresh randomUUID() per email per SQLite file), so the same human gets a
  // different ownerUserId depending on which path created vs re-subscribed the
  // terminal. owned()/adoptOwnerless()/attachDead() match on this email FIRST so a
  // re-attach survives that divergence; the id is a legacy fallback. Empty string
  // for an owner-less rehydrated survivor (syntheticMeta) or a pre-#874 session.
  ownerEmail: string;
  // The viewers currently watching this session. Each owns a real Paseo
  // subscription; live output + snapshots reach a viewer through ITS OWN
  // subscription, never a shared fan-out. An empty set is the "live(detached)"
  // state. Multi-viewer-correctness is structural — two viewers are two Paseo
  // listeners — so no manual fan-out can double-deliver (#784) or clobber (#789).
  viewers: Set<Viewer>;
  // Ring of recent output chunks (trimmed to SCROLLBACK_LIMIT_BYTES), persisted on
  // shutdown / exit for cross-restart history (#750). NOT a live-attach replay
  // buffer — viewers self-heal from Paseo's fresh snapshot.
  scrollback: Buffer[];
  scrollbackBytes: number;
  // Monotonic last-activity stamp (output produced, input sent). One of the idle
  // reaper's conditions (zero viewers AND idle past the TTL AND the pty has
  // already EXITED). On its own it never causes a reap — a live pty is spared.
  lastActivityAt: number;
  // Last-known session metadata, persisted to disk for cross-restart history
  // (#750). Mutated on resize so the sidecar reflects current dims.
  meta: PersistedTerminalMeta;
}

export interface StartTerminalParams {
  cwd?: string | null;
  cols: number;
  rows: number;
  // The user who opened the terminal — every output/exit frame is stamped with
  // it so the relay scopes the stream to this user only, and input/resize/kill
  // from anyone else are refused.
  ownerUserId: string;
  // The opener's STABLE human identity (email) — stamped alongside ownerUserId so
  // the email-keyed owner-lock (#874) can re-admit the same human even when a later
  // subscribe arrives under a DIFFERENT ownerUserId (the per-store UUID divergence).
  // Optional — a local-daemon caller without an auth email omits it.
  ownerEmail?: string;
  // Carried into the persisted sidecar so a post-restart history view knows which
  // workspace/daemon the session belonged to (#750). Optional — local-daemon
  // callers may not pass them.
  workspaceId?: string | null;
  daemonId?: string | null;
  // Stable per-mount subscriber id for the FIRST viewer (internal docs GAP-1) so a
  // later unsubscribe can drop exactly this view. Optional — old clients omit it.
  attachId?: string;
}

export interface StartTerminalResult {
  ok: boolean;
  terminalId?: string;
  error?: string;
  // True for a live re-subscribe (the pty is alive); false for a post-restart
  // history replay (the pty is gone, this is read-only). Absent on start/error.
  live?: boolean;
  // Why a non-live session ended — set only when live === false (#750).
  endedReason?: TerminalEndedReason;
}

// The PtyHost manager (internal docs PART A) additionally exposes the LIVE ptys it
// owns and a non-destructive detach. The controller only needs these two methods
// beyond TerminalManager, so it depends on this narrow shape — not the whole
// class — keeping the host path a pure capability extension (no import cycle).
export interface PtyHostCapableManager {
  // The live ptys the host still owns after (re)connect — the reattach surface.
  listTerminals(): { id: string; name: string; cwd: string; title?: string }[];
  // Tear down the daemon-side link WITHOUT killing ptys (leave them in the host).
  detachAll(): void;
}

function isPtyHostCapableManager(
  manager: TerminalManager,
): manager is TerminalManager & PtyHostCapableManager {
  const candidate = manager as Partial<PtyHostCapableManager>;
  return typeof candidate.listTerminals === "function" && typeof candidate.detachAll === "function";
}

export interface CyborgTerminalControllerOptions {
  // Override the idle-reap TTL for live sessions (tests use a small value).
  idleTtlMs?: number;
  // Override the reaper sweep interval. 0 disables the background reaper (tests
  // drive reapIdle() manually).
  reapIntervalMs?: number;
  // Clock + timer seam for deterministic tests.
  now?: () => number;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  // PtyHost mode (internal docs PART A, flag CYBORG7_PTY_HOST). When true AND the
  // manager is host-capable, dispose() DETACHES (leaves ptys alive in the host)
  // instead of killing them, and rehydrateLiveSessions() re-wraps surviving ptys.
  // Default false → byte-identical to today's behavior.
  ptyHostMode?: boolean;
  // Notified on every start/exit so a consumer (the dispatcher) can push a
  // cyborg:terminals_changed directory snapshot to the owner's clients. Unset →
  // no directory feed (today's behavior).
  onDirectoryChanged?: TerminalDirectoryChangeListener;
  // Diagnostic sink for the owner-lock path (#876 cloud follow-up). When set, the
  // controller logs create/subscribe/rehydrate owner-identity facts so a cloud
  // re-attach that STILL fails can be traced from the daemon log. Unset → silent.
  logger?: TerminalDiagLogger;
}

export class CyborgTerminalController {
  private readonly sessions = new Map<string, TrackedTerminal>();
  // History-only sessions whose pty died with a previous daemon process (#750),
  // OR exited this process (BUG-5 — inserted on onExit so same-process re-attach
  // replays history like a restart would). Rebuilt from disk on construct.
  private readonly deadSessions: Map<string, DeadTerminalSession>;
  // True while dispose() is killing ptys, so onExit treats the kill as a daemon
  // shutdown (history) rather than a user shell exit (#750).
  private disposing = false;
  // In-flight start()s that have passed the cap check but not yet landed in the
  // sessions map (a pty is being created across the await). Counted against the
  // cap so N concurrent starts can't each see size < MAX and collectively blow
  // past MAX_TERMINAL_SESSIONS — every start would otherwise spawn a real OS
  // process before any of them is tracked.
  private pendingStarts = 0;

  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly clearIntervalFn: typeof clearInterval;
  // PtyHost mode: dispose() detaches instead of killing, leaving ptys alive in
  // the host (internal docs). Only true when the manager is host-capable AND
  // the flag is set, so the default (worker) path is byte-identical.
  private readonly ptyHostMode: boolean;
  // Background sweeper for abandoned sessions (BUG-2). Null when disabled.
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  // Directory-change consumer (start/exit) — see CyborgTerminalControllerOptions.
  private readonly onDirectoryChanged: TerminalDirectoryChangeListener | null;
  // Owner-lock diagnostic sink (#876 cloud follow-up). Null → silent.
  private readonly logger: TerminalDiagLogger | null;

  constructor(
    private readonly terminalManager: TerminalManager,
    // Fallback working directory when the client doesn't pin one.
    private readonly defaultCwd: string,
    // Optional cross-restart scrollback persistence (#750, internal docs). Null
    // → terminals are purely in-memory (today's behavior). When present, scans the
    // per-daemon terminals/ dir on construct to surface post-restart history.
    private readonly persistence: TerminalPersistenceStore | null = null,
    options: CyborgTerminalControllerOptions = {},
  ) {
    this.deadSessions = persistence ? persistence.loadDeadSessions() : new Map();
    this.ptyHostMode = (options.ptyHostMode ?? false) && isPtyHostCapableManager(terminalManager);
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.onDirectoryChanged = options.onDirectoryChanged ?? null;
    this.logger = options.logger ?? null;
    this.now = options.now ?? Date.now;
    const setIntervalFn = options.timers?.setInterval ?? setInterval;
    this.clearIntervalFn = options.timers?.clearInterval ?? clearInterval;
    const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    if (reapIntervalMs > 0) {
      this.reapTimer = setIntervalFn(() => this.reapIdle(), reapIntervalMs);
      // A background sweep must never keep the process alive on shutdown.
      (this.reapTimer as { unref?: () => void })?.unref?.();
    }
  }

  // Spawn a terminal and begin streaming. `emit` is the caller's outbound channel
  // (the session emit locally, or the relay-forward emit in cloud) and is
  // registered as the FIRST viewer (its own Paseo subscription) so output/snapshot/
  // exit frames flow after this call returns.
  async start(params: StartTerminalParams, emit: TerminalEmit): Promise<StartTerminalResult> {
    // Count in-flight starts against the cap: createTerminal() is awaited, so the
    // size check alone leaves a TOCTOU window where concurrent starts each see
    // size < MAX and every one spawns a pty. Reserve the slot synchronously here,
    // release it once the session lands in the map (or the spawn fails).
    if (this.sessions.size + this.pendingStarts >= MAX_TERMINAL_SESSIONS) {
      return { ok: false, error: "terminal session limit reached on this daemon" };
    }
    const cwd = params.cwd && params.cwd.trim().length > 0 ? params.cwd : this.defaultCwd;
    this.pendingStarts += 1;
    let session: TerminalSession;
    try {
      session = await this.terminalManager.createTerminal({ cwd });
    } catch (err) {
      this.pendingStarts -= 1;
      return { ok: false, error: err instanceof Error ? err.message : "failed to start terminal" };
    }
    const terminalId = session.id;
    // Apply the client's initial geometry before any output is read.
    if (params.cols > 0 && params.rows > 0) {
      session.send({ type: "resize", rows: params.rows, cols: params.cols });
    }

    // Session-level persistence subscription (internal docs P0b): captures output
    // into the cross-restart ring + bumps the idle clock REGARDLESS of viewers, so
    // a detached session keeps buffering to disk (#750). It ignores `snapshot`
    // (each viewer pulls its own) and never emits to a client — that is the
    // viewers' job. Separate from any viewer so unsubscribing the last viewer does
    // NOT stop persistence.
    const unsubPersist = session.subscribe((msg: ServerMessage) => {
      if (msg.type !== "output") return;
      const t = this.sessions.get(terminalId);
      if (!t) return;
      this.appendScrollback(t, Buffer.from(msg.data, "utf8"));
      // Output IS activity — bump the idle clock so a busy job is never reaped.
      t.lastActivityAt = this.now();
      // Mark dirty so the persistence store debounces a ring write (#750). No-op
      // when persistence is absent/disabled.
      this.persistence?.markDirty(terminalId);
    });

    const unsubExit = session.onExit((info) => {
      const t = this.sessions.get(terminalId);
      // Persist the final tail + a sidecar marking a clean shell exit (#750): a
      // non-null endedAt is how a boot scan tells "shell exited" from "daemon
      // died". During dispose() the pty is killed by the daemon shutting down, NOT
      // by the user's shell exiting — leave endedAt null there so the boot scan
      // classifies it as daemon_restart (handled by dispose's drain path).
      if (t && !this.disposing) {
        const finalMeta: PersistedTerminalMeta = {
          ...t.meta,
          endedAt: this.now(),
          exitCode: info.exitCode ?? null,
        };
        t.meta = finalMeta;
        this.persistence?.finalize(finalMeta);
        // BUG-5: surface this freshly-exited session as same-process history so a
        // re-subscribe after the exit replays it (live:false), instead of "not
        // found" until the next daemon boot reloads the sidecar.
        this.recordDeadSession(t, finalMeta, "shell_exit");
      }
      // Fan the exit frame out to every viewer so all tabs learn it ended. Falls
      // back to the start emit when the record is already gone (defensive).
      this.fanOutExit(t, terminalId, info.exitCode, params.ownerUserId, emit);
      this.cleanup(terminalId);
    });

    // Normalize the stamped email (#876 cloud follow-up): the same human's email can
    // arrive with different casing/whitespace across the create vs the re-subscribe
    // path (JWT vs PG canonical), so canonicalize it ONCE here and match on the
    // canonical form in the owner predicates — never let casing break the lock.
    const ownerEmail = normalizeEmail(params.ownerEmail);
    const meta: PersistedTerminalMeta = {
      schemaVersion: 1,
      terminalId,
      ownerUserId: params.ownerUserId,
      ownerEmail,
      workspaceId: params.workspaceId ?? null,
      daemonId: params.daemonId ?? null,
      cwd,
      cols: params.cols,
      rows: params.rows,
      createdAt: this.now(),
      endedAt: null,
      exitCode: null,
    };
    const tracked: TrackedTerminal = {
      session,
      unsubPersist,
      unsubExit,
      ownerUserId: params.ownerUserId,
      ownerEmail,
      viewers: new Set(),
      scrollback: [],
      scrollbackBytes: 0,
      lastActivityAt: this.now(),
      meta,
    };
    this.sessions.set(terminalId, tracked);
    // The session is now tracked in the map, so the reservation is redundant —
    // release it (the entry itself counts against the cap from here on).
    this.pendingStarts -= 1;
    // A fresh start supersedes any persisted dead session with the same id and
    // registers for debounced persistence (closure reads the live ring tail).
    this.deadSessions.delete(terminalId);
    this.persistence?.register(meta, () =>
      tracked.scrollback.length ? Buffer.concat(tracked.scrollback) : Buffer.alloc(0),
    );
    // Register the opener as the first viewer (its own Paseo subscription) so its
    // initial snapshot + live output flow. A fresh start has NO prior scrollback to
    // replay (the ring is empty) — replayHistory:false keeps it a pure snapshot path.
    this.addViewer(tracked, params.ownerUserId, emit, params.attachId, /* replayHistory */ false);
    // A new session changed this owner's workspace directory — push a fresh
    // snapshot so out-of-band clients (CLI start, another tab) see the row appear.
    this.notifyDirectoryChanged(meta.workspaceId, params.ownerUserId);
    // Owner-lock diagnostic (#876 cloud follow-up): record the identity the session
    // was created under so a later failing subscribe can be matched against it. A
    // blank ownerEmail here is the smoking gun for the cloud "" bug.
    this.logger?.info(
      {
        event: "terminal_create",
        terminalId,
        ownerUserId: params.ownerUserId,
        ownerEmail,
      },
      "terminal created (owner-lock stamp)",
    );
    return { ok: true, terminalId };
  }

  // Boot-time reattach to ptys that SURVIVED a daemon restart in the PtyHost
  // (internal docs). The host kept every pty alive across the restart; ask it
  // for its live list and, for each one matching a persisted #750 sidecar
  // (owner/cwd/dims live there), RE-WRAP it as a live TrackedTerminal —
  // re-subscribe for persistence, re-onExit, restore meta, attachers: new Set()
  // (the live(detached) state from internal docs). The next client subscribe()
  // then returns { ok:true, live:true } instead of falling into attachDead().
  //
  // No-op unless ptyHostMode is on (the worker path has no surviving ptys to
  // rehydrate — its worker died with the daemon). Returns the count rehydrated.
  rehydrateLiveSessions(): number {
    if (!this.ptyHostMode) return 0;
    if (!isPtyHostCapableManager(this.terminalManager)) return 0;
    let rehydrated = 0;
    // Track the (workspace, owner) of each registered survivor so we can push a fresh
    // directory snapshot AFTER all are registered (Bug A part 3). Unlike start(),
    // rehydrate did NOT notify, so a connected owner's UI never got a corrected
    // directory and was stuck on the empty list it pulled at boot.
    const affected: TrackedTerminal[] = [];
    for (const live of this.terminalManager.listTerminals()) {
      if (this.rehydrateOne(live.id)) {
        const t = this.sessions.get(live.id);
        if (t) affected.push(t);
        rehydrated += 1;
      }
    }
    // Push the corrected directory so a connected owner's UI re-discovers its live
    // terminals without a manual pull. Owner-less survivors (ownerUserId "") can't be
    // pushed to a specific owner — they surface on the next list_terminals pull, where
    // listForWorkspace() reveals them to a workspace member who then adopts them.
    for (const t of affected) {
      this.notifyDirectoryChanged(t.meta.workspaceId, t.ownerUserId);
    }
    return rehydrated;
  }

  // LAZY REHYDRATE ON SUBSCRIBE — the restart-persistence RACE fix (#880 runtime
  // evidence: owner's Mac daemon.log on 0.0.189, sessionOwner null → session ABSENT
  // from the map → attachDead → "session ended" after every Cmd+Q).
  //
  // The boot rehydrate (rehydrateLiveSessions, called SYNCHRONOUSLY by the dispatcher
  // during terminal setup) iterates the PtyHost manager's listTerminals(). That list
  // is the host's surviving ptys, synced into the client when the daemon CONNECTS to
  // the detached host socket. On the cloud/macOS path that connect+sync can land
  // AFTER the synchronous boot rehydrate runs, so listTerminals() is EMPTY at that
  // instant → 0 rehydrated → a perfectly live surviving pty is NEVER registered in
  // the session map. The owner's next subscribe then finds no session → owned()
  // rejects → attachDead → the live terminal is falsely "ended". (On Linux/local the
  // host connects fast enough that the boot rehydrate sometimes wins — the flaky
  // pty_host_rehydrate count:1 seen earlier.)
  //
  // This is the universal, self-healing recovery: when subscribe() finds NO session
  // for a terminalId, RE-QUERY the host for THAT id and rehydrate it on demand before
  // falling to attachDead — so even if the boot rehydrate raced the host list, the
  // FIRST subscribe recovers the live pty. It registers with the SAME sidecar-restored
  // owner trackLiveSession uses (the deadSessions map is rebuilt from disk on
  // construct, BEFORE any subscribe, so the REAL owner is available here — never
  // syntheticMeta ""). No-op unless ptyHostMode + a host-capable manager. Returns true
  // if it registered a session for `terminalId`.
  private lazyRehydrate(terminalId: string): boolean {
    if (!this.ptyHostMode) return false;
    if (!isPtyHostCapableManager(this.terminalManager)) return false;
    if (this.sessions.has(terminalId)) return true;
    // listTerminals() is the host's authoritative LIVE set — only rehydrate an id the
    // host still owns, so a stale/gone id is never resurrected (it falls to
    // attachDead → history as before).
    const known = this.terminalManager.listTerminals().some((t) => t.id === terminalId);
    if (!known) return false;
    const registered = this.rehydrateOne(terminalId);
    if (registered) {
      this.logger?.info(
        { event: "terminal_lazy_rehydrate", terminalId },
        "terminal lazily rehydrated on subscribe (boot rehydrate raced the host list)",
      );
    }
    return registered;
  }

  // Rehydrate a SINGLE surviving pty by id: re-wrap the host-owned live session as a
  // live TrackedTerminal, restoring its #750 sidecar owner/cwd/dims + seeding the ring
  // from persisted history. Shared by the boot rehydrate loop and the lazy
  // on-subscribe recovery. Returns true if it registered a NEW session.
  private rehydrateOne(terminalId: string): boolean {
    if (!isPtyHostCapableManager(this.terminalManager)) return false;
    if (this.sessions.has(terminalId)) return false;
    const session = this.terminalManager.getTerminal(terminalId);
    if (!session) return false;
    // A pty that already exited between the host's list and this call is not
    // live — skip it (the boot scan surfaces it as history instead).
    if (session.getExitInfo() !== null) return false;
    // Restore meta from the persisted sidecar (the dead-session map is rebuilt
    // from disk on construct). Without a sidecar we still rehydrate, minting a
    // best-effort meta so the pty is reattachable, but we can't owner-lock it to
    // a known user — fall back to the dead record's owner when present.
    const dead = this.deadSessions.get(terminalId);
    const meta = dead
      ? { ...dead.meta, endedAt: null, exitCode: null }
      : this.syntheticMeta(session);
    // Seed the rehydrated ring with the persisted history (internal docs #5): the
    // pre-restart scrollback lives ONLY in the #750 sidecar log (the in-memory
    // ring died with the old daemon process). Without this seed the rehydrated
    // session starts with an EMPTY ring, so the first re-attach would replay
    // nothing and the user loses everything that scrolled by before the restart.
    // Carrying it forward makes the ring authoritative across the restart, and the
    // re-attach history replay (subscribe → addViewer) then restores it.
    this.trackLiveSession(session, meta, dead?.scrollback);
    // The pty is alive again — it must NOT linger in the read-only history map.
    this.deadSessions.delete(terminalId);
    return true;
  }

  // Build a best-effort meta for a surviving pty that has no persisted sidecar
  // (persistence was disabled, or the sidecar was pruned). The session is still
  // reattachable; ownerUserId is unknown, so it is left empty and the owner-lock
  // effectively denies a cross-user attach until a real owner subscribes.
  private syntheticMeta(session: TerminalSession): PersistedTerminalMeta {
    const size = session.getSize();
    return {
      schemaVersion: 1,
      terminalId: session.id,
      ownerUserId: "",
      ownerEmail: "",
      workspaceId: null,
      daemonId: null,
      cwd: session.cwd,
      cols: size.cols,
      rows: size.rows,
      createdAt: this.now(),
      endedAt: null,
      exitCode: null,
    };
  }

  // Wrap an already-live session (from rehydrate) as a TrackedTerminal: the SAME
  // persistence subscription + onExit + cap/persistence registration start() sets
  // up, minus the pty creation and the first viewer (rehydrate has no client yet —
  // it is the live(detached) state). Shared with start() would couple two
  // call-shapes, so it is a focused helper rather than a refactor of start().
  private trackLiveSession(
    session: TerminalSession,
    meta: PersistedTerminalMeta,
    seedScrollback?: Buffer,
  ): void {
    const terminalId = session.id;
    // Seed the ring from persisted history (internal docs #5). Re-clamp to the budget
    // defensively (the persisted tail is already bounded to 256 KiB).
    const seed: Buffer[] = [];
    let seedBytes = 0;
    if (seedScrollback && seedScrollback.length > 0) {
      let tail = seedScrollback;
      if (tail.length > SCROLLBACK_LIMIT_BYTES) {
        tail = tail.subarray(tail.length - SCROLLBACK_LIMIT_BYTES);
      }
      seed.push(tail);
      seedBytes = tail.length;
    }
    const unsubPersist = session.subscribe((msg: ServerMessage) => {
      if (msg.type !== "output") return;
      const t = this.sessions.get(terminalId);
      if (!t) return;
      this.appendScrollback(t, Buffer.from(msg.data, "utf8"));
      t.lastActivityAt = this.now();
      this.persistence?.markDirty(terminalId);
    });
    const unsubExit = session.onExit((info) => {
      const t = this.sessions.get(terminalId);
      if (t && !this.disposing) {
        const finalMeta: PersistedTerminalMeta = {
          ...t.meta,
          endedAt: this.now(),
          exitCode: info.exitCode ?? null,
        };
        t.meta = finalMeta;
        this.persistence?.finalize(finalMeta);
        this.recordDeadSession(t, finalMeta, "shell_exit");
      }
      this.fanOutExit(t, terminalId, info.exitCode, meta.ownerUserId, () => {});
      this.cleanup(terminalId);
    });
    // Restore the email-keyed owner identity from the (possibly old) sidecar meta,
    // normalized so a re-attach's normalized incoming email matches it. A pre-#874
    // sidecar has no ownerEmail → "" → id-only owner matching holds.
    const restoredEmail = normalizeEmail(meta.ownerEmail);
    const tracked: TrackedTerminal = {
      session,
      unsubPersist,
      unsubExit,
      ownerUserId: meta.ownerUserId,
      ownerEmail: restoredEmail,
      viewers: new Set(),
      scrollback: seed,
      scrollbackBytes: seedBytes,
      lastActivityAt: this.now(),
      meta,
    };
    this.sessions.set(terminalId, tracked);
    this.persistence?.register(meta, () =>
      tracked.scrollback.length ? Buffer.concat(tracked.scrollback) : Buffer.alloc(0),
    );
    // Owner-lock diagnostic (#876 cloud follow-up): record the owner restored from
    // the surviving pty's sidecar so a post-restart re-attach can be matched to it.
    // An empty ownerEmail here means the survivor will only owner-lock by exact id.
    this.logger?.info(
      {
        event: "terminal_rehydrate",
        terminalId,
        ownerUserId: meta.ownerUserId,
        ownerEmail: restoredEmail,
      },
      "terminal rehydrated (owner-lock restore)",
    );
  }

  // Watch an EXISTING session (internal docs) — the unit of "render this pty". Adds
  // the caller as a viewer that owns its OWN Paseo subscription: terminal.ts
  // re-delivers a FRESH screen `snapshot` to that subscription (terminal.ts:998 —
  // the self-heal, NOT a separate ack), then streams live `output` to it. So a
  // returning/extra viewer repaints from the snapshot alone (the #789 class — a
  // dropped ack → timeout → fresh start — is structurally impossible), and two
  // viewers are two independent Paseo listeners (the #784 double-render class is
  // structurally impossible).
  //
  // Idempotent: a re-subscribe with the same identity (attachId, else emit ref)
  // REPLACES the existing viewer in place — tears down its old subscription and
  // opens a fresh one — so a remount that resubscribes before the prior
  // unsubscribe lands collapses to one viewer instead of stacking (#778). A
  // genuinely new view (real second tab) adds a second viewer (legit multi-tab).
  // Owner-locked; a dead session falls through to read-only history replay.
  subscribe(
    terminalId: string,
    userId: string,
    emit: TerminalEmit,
    attachId?: string,
    userEmail?: string,
  ): StartTerminalResult {
    // LAZY REHYDRATE (restart-persistence race fix, #880 runtime evidence): if the
    // boot rehydrate raced the pty-host connection and this surviving pty was never
    // registered (listTerminals() was empty at boot), the session is ABSENT from the
    // map → owned() would reject → attachDead → live terminal falsely "ended". Re-query
    // the host for THIS id and rehydrate it on demand BEFORE the owner gates run, so
    // the first subscribe after a restart recovers the live pty with its real
    // sidecar-restored owner. No-op when the session is already tracked (boot rehydrate
    // won) or off the PtyHost path.
    this.lazyRehydrate(terminalId);
    // ADOPT-ON-FIRST-SUBSCRIBE (#856 defense-in-depth, extended for #874): a session
    // rehydrated from a surviving pty with NO #750 sidecar carries an EMPTY ownerUserId
    // (syntheticMeta — e.g. created before persistence was enabled). owned() would
    // reject EVERY user → attachDead() → "session not found", orphaning a live pty
    // forever. So the FIRST subscriber CLAIMS an owner-less survivor. #874 ALSO re-
    // claims when the survivor's ownerEmail matches this subscriber's email but the
    // ownerUserId differs (same human, different per-store id namespace) — re-stamping
    // ownerUserId to the current id so the lock passes. A REAL owner with a DIFFERENT
    // email is never reassigned (it falls through to the email-keyed owned() check).
    this.adoptOwnerless(terminalId, userId, userEmail);
    const t = this.owned(terminalId, userId, userEmail);
    // Owner-lock diagnostic (#876 cloud follow-up): on EVERY subscribe, record the
    // incoming identity, the session's stored owner, and which gate decided — so a
    // cloud re-attach that STILL dead-ends to attachDead is traceable from the log
    // (was it an email mismatch? an empty email? a divergent id with no email?).
    const existing = this.sessions.get(terminalId);
    this.logger?.info(
      {
        event: "terminal_subscribe",
        terminalId,
        incomingUserId: userId,
        incomingEmail: normalizeEmail(userEmail),
        sessionOwnerUserId: existing?.ownerUserId ?? null,
        sessionOwnerEmail: existing?.ownerEmail ?? null,
        ownsByEmail: existing ? ownsByEmail(existing.ownerEmail, userEmail) : false,
        ownedPassed: t !== null,
        willAttachDead: t === null,
      },
      "terminal subscribe (owner-lock decision)",
    );
    if (!t) return this.attachDead(terminalId, userId, emit, userEmail);
    // RE-ATTACH to a LIVE session (internal docs #5): replay the full scrollback
    // RING as authoritative history BEFORE the screen snapshot, mirroring
    // attachDead()'s byte replay. Paseo's snapshot only carries the current screen
    // (+ the daemon xterm's bounded 1000-line scrollback), so on a tab remount / WS
    // reconnect / daemon-restart rehydrate the user lost everything that scrolled
    // up past the visible viewport. The ring (the same 256 KiB tail #750 persists)
    // is the deeper "where was I" buffer; replaying it as raw output reproduces the
    // exact terminal state (scrollback + screen + cursor + alt-screen mode, since
    // the bytes carry the escape sequences). The following snapshot is then stamped
    // historyReplayed so the client treats the byte replay as authoritative and
    // skips its term.reset()+repaint (which would clobber the just-rebuilt
    // scrollback) — the mosh/VSCode model.
    this.addViewer(t, userId, emit, attachId, /* replayHistory */ true);
    t.lastActivityAt = this.now();
    return { ok: true, terminalId, live: true };
  }

  // Stop watching a live session WITHOUT killing it (internal docs). Drops exactly
  // this viewer (by attachId in the cloud/relay path, else by emit reference
  // in-process) and tears down its Paseo subscription so the session can go
  // live(detached) and become idle-reapable once its pty exits. The pty KEEPS
  // RUNNING — unsubscribe is NOT kill (mirrors Paseo A5: client disconnect ≠
  // kill). Returns true if a matching viewer was removed.
  unsubscribe(
    terminalId: string,
    userId: string,
    match: { emit?: TerminalEmit; attachId?: string },
    userEmail?: string,
  ): boolean {
    const t = this.owned(terminalId, userId, userEmail);
    if (!t) return false;
    const viewer = this.findViewer(t, match.emit, match.attachId);
    if (!viewer) return false;
    t.viewers.delete(viewer);
    this.disposeViewer(viewer);
    return true;
  }

  // Register a viewer that owns its own Paseo subscription. The subscription's
  // listener forwards Paseo's per-subscribe `snapshot` (the self-heal repaint) and
  // coalesced live `output` to THIS viewer's emit only — multi-viewer-correct by
  // construction, no shared fan-out. Idempotent by identity: an existing viewer
  // (same attachId, else same emit ref) is REPLACED in place so a remount never
  // stacks a duplicate (#778).
  //
  // CLOUD-PATH PER-USER COLLAPSE (#807): in the relay path (attachId present) the
  // relay re-fans every owner-tagged frame to ALL of this user's live sockets BY
  // userId, so the daemon must keep AT MOST ONE viewer per (terminal, userId). A
  // viewer leaks when a guest's socket dies dirtily (app crash) without an
  // unsubscribe: nothing drops that viewer. The user then reopens with a FRESH
  // attachId, findViewer can't match the stale one, and a naive add STACKS a 2nd
  // viewer — every pty echo is then fanned to two viewers, both re-fanned by the
  // relay to the user's current socket → every character DOUBLES. So on the cloud
  // path we additionally drop ANY existing viewer for the SAME userId (even with a
  // different/stale attachId) before adding the new one, collapsing the leak. The
  // local (non-relay) path has no attachId and no userId re-fan — there, distinct
  // emit closures are legitimately distinct views, so it is NOT collapsed.
  private addViewer(
    t: TrackedTerminal,
    userId: string,
    emit: TerminalEmit,
    attachId: string | undefined,
    replayHistory: boolean,
  ): void {
    const existing = this.findViewer(t, emit, attachId);
    if (existing) {
      // Replace in place: drop the stale subscription/coalescer, open a fresh one
      // so the returning view gets a new self-heal snapshot.
      t.viewers.delete(existing);
      this.disposeViewer(existing);
    } else if (attachId !== undefined) {
      // Cloud path, fresh attachId, no exact match: collapse any leaked viewer for
      // this same user (its socket died without unsubscribing) so a reopen replaces
      // the stale viewer instead of stacking a duplicate that would double output.
      for (const v of t.viewers) {
        if (v.userId === userId) {
          t.viewers.delete(v);
          this.disposeViewer(v);
        }
      }
    }
    const terminalId = t.meta.terminalId;
    // RE-ATTACH HISTORY REPLAY (internal docs #5): on a (re)subscribe to a live
    // session that already has buffered scrollback, push the full ring as ONE
    // authoritative history frame BEFORE Paseo's snapshot. This is what restores the
    // scrolled-up history the screen snapshot alone drops. Bounded to the ring's own
    // SCROLLBACK_LIMIT_BYTES budget (the ring is trimmed on append, re-clamped here
    // defensively). The first snapshot this viewer's subscription delivers is then
    // stamped historyReplayed so the client doesn't reset+repaint over it.
    let pendingHistoryStamp = false;
    if (replayHistory && t.scrollback.length > 0) {
      let history = Buffer.concat(t.scrollback);
      if (history.length > SCROLLBACK_LIMIT_BYTES) {
        history = history.subarray(history.length - SCROLLBACK_LIMIT_BYTES);
      }
      // Reset the client's xterm via BYTES, in-band, BEFORE the history (internal docs
      // #5). A WS-reconnect re-attach mounts onto a buffer that still holds the
      // pre-disconnect content; replaying the ring on top of it would DOUBLE the
      // scrollback. ESC[H (home) + ESC[2J (clear screen) + ESC[3J (clear xterm
      // scrollback) wipe both display and scrollback so the replay rebuilds a clean
      // buffer. On a fresh mount the buffer is already empty, so the clear is a
      // harmless no-op — same single code path for both. The byte clear (not a
      // client term.reset()) keeps ordering trivially correct: it is part of the
      // same ordered output frame that precedes the history.
      const data = `\x1b[H\x1b[2J\x1b[3J${history.toString("utf8")}`;
      // Tag the replay with the width its bytes were captured at (the tracked pty
      // geometry, which a rehydrated reopen restores to the PRIOR session's dims —
      // e.g. a narrow mobile width). A client now on a different width reproduces the
      // bytes at this width then resizes to reflow, fixing the mobile→desktop garble
      // (#48). On a same-width re-attach (WS blip) replayCols === the client width, so
      // the client no-ops the reflow. Live output frames carry no replay dims.
      emit({
        type: "cyborg:terminal_output",
        payload: {
          terminalId,
          data,
          toUserId: userId,
          replayCols: t.meta.cols,
          replayRows: t.meta.rows,
        },
      });
      pendingHistoryStamp = true;
    }
    const coalescer = new TerminalOutputCoalescer({
      timers: { setTimeout, clearTimeout },
      onFlush: ({ payload }) => {
        emit({
          type: "cyborg:terminal_output",
          payload: { terminalId, data: payload.toString("utf8"), toUserId: userId },
        });
      },
    });
    // Emit ONE authoritative snapshot for THIS (re)subscribe, stamping the first
    // post-history-replay one as historyReplayed. Shared by the proactive pull
    // below and any later pushed snapshot from the manager so the stamp is applied
    // exactly once.
    const emitSnapshot = (state: TerminalState, revision: number | undefined): void => {
      // Flush any output the coalescer is holding FIRST so a repaint from this
      // snapshot is never followed by a stale pre-snapshot output frame that
      // would double-render the tail.
      coalescer.flush();
      // Stamp ONLY the first snapshot after a history replay (this re-attach):
      // the client treats it as confirmatory and skips its reset+repaint so the
      // byte-replayed scrollback is not clobbered. Later snapshots (a future
      // re-subscribe with no fresh replay) repaint normally.
      const historyReplayed = pendingHistoryStamp;
      pendingHistoryStamp = false;
      emit({
        type: "cyborg:terminal_snapshot",
        payload: {
          terminalId,
          state,
          revision,
          toUserId: userId,
          ...(historyReplayed ? { historyReplayed: true } : {}),
        },
      });
    };
    const unsub = t.session.subscribe((msg: ServerMessage) => {
      // A LATER pushed snapshot (a genuine mid-session repaint, e.g. after a
      // resize) is forwarded normally. The worker/PtyHost managers never push one
      // on attach, so the proactive pull below is what heals a (re)subscribe.
      if (msg.type === "snapshot") {
        emitSnapshot(msg.state, msg.revision);
        return;
      }
      if (msg.type === "output") coalescer.handle(msg.data);
    });
    // SNAPSHOT-ON-(RE)SUBSCRIBE — PULL, don't WAIT (the rehydrate dead-end fix).
    // The snapshot-on-(re)subscribe model (internal docs) requires that EVERY
    // subscribe deliver a fresh cyborg:terminal_snapshot — the UI client resolves
    // its subscribe() to live:true ONLY on that frame (terminal-transport.ts), and
    // dead-ends to the "session ended" Restart/Dismiss banner if it never arrives
    // (15s timeout → transient → reattach retry cap). But the worker/PtyHost
    // managers only relay a snapshot when the underlying terminal PUSHES one on its
    // own cadence; on attach to a REHYDRATED or otherwise-idle pty no push ever
    // comes (the pty-host replays its ring as `output` and explicitly drops
    // snapshots — pty-host-process.ts handleAttach/replayRing). So a returning view
    // waited forever for a frame that never came and dead-ended a perfectly live
    // session. Mirror Paseo's own terminal-session-controller, which PULLS the
    // snapshot via getStateSnapshot() on subscribe: emit one immediately so the
    // client always self-heals to live. A later pushed snapshot still repaints
    // normally (and won't re-stamp historyReplayed — that latch is now consumed).
    const initial = t.session.getStateSnapshot();
    emitSnapshot(initial.state, initial.revision);
    t.viewers.add({ emit, attachId, userId, unsub, coalescer });
  }

  // Find the viewer that represents the SAME logical client view (#778/#779):
  // prefer the stable attachId (cloud/relay path, where the per-RPC emit closure
  // isn't reference-stable), fall back to emit-reference identity (in-process/
  // desktop path). Returns the entry to replace/drop, or null when this is a
  // genuinely new view (a real second tab → legit multi-viewer).
  private findViewer(
    t: TrackedTerminal,
    emit: TerminalEmit | undefined,
    attachId: string | undefined,
  ): Viewer | null {
    for (const v of t.viewers) {
      if (attachId !== undefined && v.attachId === attachId) return v;
      if (emit !== undefined && v.emit === emit) return v;
    }
    return null;
  }

  // Tear down one viewer's Paseo subscription + coalescer (best-effort).
  private disposeViewer(v: Viewer): void {
    try {
      v.unsub();
      v.coalescer.dispose();
    } catch {
      // Best-effort teardown — never throw out of viewer disposal.
    }
  }

  // Sweep sessions and reclaim any that are ORPHANED: detached, idle past the TTL,
  // AND whose underlying pty has ALREADY EXITED (internal docs BUG-2, corrected).
  // The critical gate is the LIVENESS check — session.getExitInfo() !== null means
  // the pty process is gone, so this is a stale slot, not a running program.
  //
  // A session whose pty is STILL ALIVE is NEVER reaped, no matter how long it has
  // been detached + idle: a backgrounded Claude Code idle-waiting-for-input emits
  // no output (nothing bumps lastActivityAt) and has no viewer, yet its process is
  // alive and must keep running so the user can return to it. Killing it on a
  // timer was the "this terminal session is no longer available" regression.
  // (When a pty exits normally, onExit→cleanup already removes it synchronously,
  // so this sweep only catches the rare case where that cleanup was missed.)
  //
  // Reaping a dead-but-uncleaned session kills the (already-gone) pty for good
  // measure and runs the normal onExit→cleanup path, finalizing it as history.
  // Returns the count reaped (test/introspection). Called on a background interval
  // and exposed for tests.
  reapIdle(): number {
    const cutoff = this.now() - this.idleTtlMs;
    // Snapshot first — kill()→onExit→cleanup mutates sessions during iteration.
    const toReap: string[] = [];
    for (const [id, t] of this.sessions) {
      if (t.viewers.size > 0) continue;
      if (t.lastActivityAt > cutoff) continue;
      // LIVENESS GATE: a pty that has not exited is a live process, never an
      // orphan — leave it running even if detached + idle forever. Only a session
      // whose pty has actually exited (getExitInfo() !== null) is reclaimable.
      if (t.session.getExitInfo() === null) continue;
      toReap.push(id);
    }
    for (const id of toReap) {
      try {
        this.sessions.get(id)?.session.kill();
      } catch {
        // best-effort reap — a pty that throws on kill must not abort the sweep.
        // Force the bookkeeping cleanup so the slot is still reclaimed.
        this.cleanup(id);
      }
    }
    return toReap.length;
  }

  // Cross-restart / same-process history (#750, internal docs): the live map
  // has no session, but a dead-session record (from a previous daemon process OR a
  // shell that exited this process, BUG-5) may. On a hit, owner-check against the
  // persisted ownerUserId, replay the saved scrollback as a FINAL (non-growing)
  // buffer, and return live:false so the client renders a read-only "session
  // ended — here is its history" view instead of reconnecting. No pty is created —
  // a dead process cannot resume. Falls back to the #718 "not found" path when
  // there's no history.
  private attachDead(
    terminalId: string,
    userId: string,
    emit: TerminalEmit,
    userEmail?: string,
  ): StartTerminalResult {
    const dead = this.deadSessions.get(terminalId);
    // Email-first owner gate (#874): match the persisted owner by EMAIL when the
    // sidecar carries one (so a history view survives the per-store id divergence),
    // falling back to the legacy exact-id match for pre-#874 sidecars.
    if (!dead || !ownsMeta(dead.meta, userId, userEmail)) {
      return { ok: false, error: "terminal session not found" };
    }
    if (dead.scrollback.length > 0) {
      emit({
        type: "cyborg:terminal_output",
        payload: {
          terminalId,
          data: dead.scrollback.toString("utf8"),
          toUserId: userId,
        },
      });
    }
    return { ok: true, terminalId, live: false, endedReason: dead.endedReason };
  }

  // Fan the terminal_exit frame out to every viewer. Falls back to the original
  // start emit when the session record is already gone (defensive — an exit that
  // races teardown still reaches the opener).
  private fanOutExit(
    t: TrackedTerminal | undefined,
    terminalId: string,
    code: number | null,
    ownerUserId: string,
    fallbackEmit: TerminalEmit,
  ): void {
    const frame = {
      type: "cyborg:terminal_exit",
      payload: { terminalId, code, toUserId: ownerUserId },
    };
    if (t && t.viewers.size > 0) {
      for (const v of t.viewers) v.emit(frame);
    } else {
      fallbackEmit(frame);
    }
  }

  // BUG-5: record a finalized live session as in-memory history so a same-process
  // re-subscribe replays it (live:false) exactly like a post-restart boot scan
  // would. Snapshots the current scrollback as the (now frozen) history buffer.
  private recordDeadSession(
    t: TrackedTerminal,
    meta: PersistedTerminalMeta,
    endedReason: TerminalEndedReason,
  ): void {
    const scrollback = t.scrollback.length ? Buffer.concat(t.scrollback) : Buffer.alloc(0);
    this.deadSessions.set(meta.terminalId, { meta, scrollback, endedReason });
  }

  // Append an output chunk to the session's persistence ring, trimming from the
  // front to stay within SCROLLBACK_LIMIT_BYTES. A single chunk larger than the
  // budget is itself tail-trimmed so the cap always holds.
  private appendScrollback(t: TrackedTerminal, data: Buffer): void {
    let chunk = data;
    if (chunk.length > SCROLLBACK_LIMIT_BYTES) {
      chunk = chunk.subarray(chunk.length - SCROLLBACK_LIMIT_BYTES);
    }
    t.scrollback.push(chunk);
    t.scrollbackBytes += chunk.length;
    while (t.scrollbackBytes > SCROLLBACK_LIMIT_BYTES && t.scrollback.length > 1) {
      const dropped = t.scrollback.shift();
      if (dropped) t.scrollbackBytes -= dropped.length;
    }
  }

  input(terminalId: string, data: string, userId: string, userEmail?: string): boolean {
    const t = this.owned(terminalId, userId, userEmail);
    if (!t) return false;
    t.session.send({ type: "input", data });
    // Input is activity — keeps a session a user is typing into off the reaper.
    t.lastActivityAt = this.now();
    return true;
  }

  resize(
    terminalId: string,
    cols: number,
    rows: number,
    userId: string,
    userEmail?: string,
  ): boolean {
    const t = this.owned(terminalId, userId, userEmail);
    if (!t) return false;
    if (cols > 0 && rows > 0) {
      t.session.send({ type: "resize", rows, cols });
      t.lastActivityAt = this.now();
      // Persist the new geometry to the sidecar (#750) — state-change event, not
      // per output frame. So a post-restart history view restores the right dims.
      if (this.persistence && (t.meta.cols !== cols || t.meta.rows !== rows)) {
        t.meta = { ...t.meta, cols, rows };
        this.persistence.persistMeta(t.meta);
      }
    }
    return true;
  }

  // Forget a persisted dead session (#750, internal docs): a user explicitly
  // dismissing a history row deletes its sidecar + log so it stops surfacing.
  // Owner-locked against the persisted ownerUserId. No-op for live sessions (those
  // are torn down via kill()).
  forget(terminalId: string, userId: string, userEmail?: string): boolean {
    const dead = this.deadSessions.get(terminalId);
    if (!dead || !ownsMeta(dead.meta, userId, userEmail)) return false;
    this.deadSessions.delete(terminalId);
    this.persistence?.forget(terminalId);
    return true;
  }

  // kill() drives the PTY down; the onExit handler emits terminal_exit and runs
  // cleanup, so this is the single teardown path (idempotent).
  kill(terminalId: string, userId: string, userEmail?: string): boolean {
    const t = this.owned(terminalId, userId, userEmail);
    if (!t) return false;
    t.session.kill();
    return true;
  }

  // Tear down every tracked terminal — called on daemon shutdown.
  dispose(): void {
    // Stop the background reaper first so it can't fire mid-teardown.
    if (this.reapTimer) {
      this.clearIntervalFn(this.reapTimer);
      this.reapTimer = null;
    }
    // GRACEFUL shutdown (internal docs BUG-4): persist each session's tail BEFORE
    // killing its pty. Sidecars keep endedAt null (disposing flag) so the next
    // boot classifies them as daemon_restart history.
    this.disposing = true;
    try {
      // Snapshot ids first — kill()/cleanup mutate the map during iteration.
      const ids = Array.from(this.sessions.keys());
      for (const id of ids) {
        // Persist the now-complete tail BEFORE the pty goes down (or detaches).
        this.persistence?.flush(id);
      }
      // PtyHost mode (internal docs): the HOST owns the ptys, so shutdown must
      // DETACH — drain + persist the tail (done above, the safety net) but leave
      // every pty ALIVE in the host so the next daemon re-attaches to it. We tear
      // down only the daemon-side wrappers (viewers/subscriptions), NOT the ptys.
      if (this.ptyHostMode) {
        for (const id of ids) {
          this.cleanup(id);
        }
        if (isPtyHostCapableManager(this.terminalManager)) {
          this.terminalManager.detachAll();
        }
      } else {
        for (const id of ids) {
          // Isolate each teardown: one pty whose kill() throws must NOT abort the
          // loop and leak every remaining session's pty + subscriptions. cleanup()
          // already swallows its own errors, but kill() is the engine's and can
          // throw.
          try {
            this.sessions.get(id)?.session.kill();
          } catch {
            // best-effort shutdown — keep tearing down the rest.
          }
          this.cleanup(id);
        }
      }
    } finally {
      // Always clear the flag, even if flush/kill threw, so a controller that
      // somehow outlives a failed dispose doesn't misclassify later exits.
      this.disposing = false;
    }
  }

  // Test/introspection: how many live sessions this controller tracks.
  get sessionCount(): number {
    return this.sessions.size;
  }

  // Test/introspection: how many history (dead) sessions this controller knows —
  // loaded from disk on construct (#750) plus any that exited this process (BUG-5).
  get deadSessionCount(): number {
    return this.deadSessions.size;
  }

  // Test/introspection: how many live client views are watching a session.
  attacherCount(terminalId: string): number {
    return this.sessions.get(terminalId)?.viewers.size ?? 0;
  }

  // The workspace terminal DIRECTORY for one owner: every LIVE session that
  // belongs to (workspaceId, ownerUserId), oldest first. Owner-scoped — a terminal
  // is private to whoever opened it — so a caller only ever sees their own. Dead
  // (post-restart history) sessions are intentionally excluded: the sidebar
  // directory tracks the live set; history rows are surfaced on demand via attach.
  //
  // OWNER MATCH IS EMAIL-FIRST (Bug A — the rehydrate directory DEADLOCK). A pty that
  // SURVIVED a daemon restart in the PtyHost is re-wrapped by rehydrateLiveSessions()/
  // lazyRehydrate() with meta from the #750 sidecar OR syntheticMeta. In the cloud path
  // the caller's ownerUserId is the relay/PG id, which DIVERGES from the SQLite-namespace
  // id a sidecar may carry — so the original PURE id-equality filter HID a rehydrated
  // survivor from its own owner: cyborg:list_terminals returned [] → the UI never
  // discovered the live terminal → black/empty terminal. And because the UI never saw
  // the row, it could never subscribe, so adoptOwnerless() could never re-stamp the
  // owner either — the chicken-and-egg. Match the owner the SAME way owned() does: by
  // normalized ownerEmail (with the legacy exact-id fallback), threading the caller's
  // email through (the dispatcher has auth.user.email). The workspace filter still
  // applies — a survivor whose sidecar HAS the real workspaceId passes it.
  //
  // OWNER-LESS SURVIVORS (ownerUserId === "" AND ownerEmail === "" — a syntheticMeta
  // survivor with no sidecar) carry NO identity to attribute, so an id/email match can
  // never surface them and the first subscribe that would adoptOwnerless() them could
  // never happen. Surface them too — but, to avoid leaking one user's survivor to
  // another, ONLY when the survivor also carries the requested workspaceId (the SAFER
  // of the two options). An owner-less survivor has no prior owner to leak to, and the
  // workspace gate keeps it out of unrelated workspaces; the real owner reclaims it on
  // first subscribe via adoptOwnerless(). A survivor that DOES carry an owner email is
  // never surfaced to a different user (the email gate rejects them).
  listForWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    ownerEmail?: string;
  }): TerminalDirectoryEntry[] {
    const entries: TerminalDirectoryEntry[] = [];
    for (const t of this.sessions.values()) {
      // The workspace gate applies to everyone: a sidecar'd survivor with the real
      // workspaceId passes; a syntheticMeta survivor (workspaceId null) only matches
      // a null request, so it never leaks into a real workspace.
      if ((t.meta.workspaceId ?? null) !== input.workspaceId) continue;
      const ownerless = t.ownerUserId === "" && t.ownerEmail === "";
      if (ownerless) {
        // No identity to attribute — surface to a workspace member (already gated by
        // workspace above) so the first subscribe can adoptOwnerless() it.
        entries.push(this.toDirectoryEntry(t));
        continue;
      }
      // Identified session (live start OR sidecar'd survivor): match the owner the
      // SAME way owned() does — email-first with id fallback — so a rehydrated
      // survivor whose sidecar email is right but whose id diverged is still surfaced
      // to its real owner, and never to anyone else.
      if (!ownsTracked(t, input.ownerUserId, input.ownerEmail)) continue;
      entries.push(this.toDirectoryEntry(t));
    }
    return entries.sort((a, b) => a.startedAt - b.startedAt);
  }

  private toDirectoryEntry(t: TrackedTerminal): TerminalDirectoryEntry {
    return {
      terminalId: t.meta.terminalId,
      workspaceId: t.meta.workspaceId ?? "",
      daemonId: t.meta.daemonId ?? null,
      cwd: t.meta.cwd ?? null,
      title: deriveTerminalTitle(t.meta.cwd),
      startedAt: t.meta.createdAt,
      live: true,
    };
  }

  // Fire the directory-change hook for a session's (workspace, owner). No-op when
  // there is no consumer or the session has no workspace binding (a local-daemon
  // start that never set one — it can't be surfaced in a workspace sidebar anyway).
  private notifyDirectoryChanged(workspaceId: string | null, ownerUserId: string): void {
    if (!this.onDirectoryChanged || !workspaceId) return;
    this.onDirectoryChanged({ workspaceId, ownerUserId });
  }

  // Claim an OWNER-LESS rehydrated survivor (#856) OR re-claim a survivor whose
  // owner-EMAIL matches but whose ownerUserId came from a DIFFERENT per-store id
  // namespace (#874 — the root of the Cmd+Q "dies after re-attach" bug). Two cases:
  //   1. (#856) ownerUserId === "" — a pty that survived a restart with no #750
  //      sidecar got a syntheticMeta with no owner; the FIRST subscriber adopts it.
  //   2. (#874) ownerEmail === this subscriber's email but ownerUserId !== this id —
  //      the SAME human re-subscribing under a divergent id (e.g. created via the
  //      SQLite-id path, re-subscribed via the relay PG-id path). Re-stamp the live
  //      ownerUserId to the CURRENT id (keeping the email) so the exact-id legacy
  //      fallback in owned() also passes, and persist it.
  // In BOTH cases the email is carried forward. A survivor whose REAL email DIFFERS
  // from the subscriber is never reassigned — it falls through to owned()'s gate.
  // Idempotent: re-running after the claim is a no-op (owner already matches).
  private adoptOwnerless(terminalId: string, userId: string, userEmail?: string): void {
    const t = this.sessions.get(terminalId);
    if (!t || userId === "") return;
    const email = normalizeEmail(userEmail);
    const adoptOwnerless = t.ownerUserId === "";
    // Same human (email match), different id namespace → re-stamp the id. Guarded so
    // an empty subscriber email can't hijack an owner-less ("") session by email.
    // Both sides are normalized so casing/whitespace never breaks the re-claim, and
    // a canonical-id match (uuidv5 of the email, #878) is accepted as a fallback so
    // even a stored-email edge case still resolves the same human.
    const reclaimByEmail =
      email !== "" &&
      t.ownerUserId !== userId &&
      (t.ownerEmail === email ||
        (t.ownerEmail !== "" && canonicalUserId(t.ownerEmail) === canonicalUserId(email)));
    if (!adoptOwnerless && !reclaimByEmail) return;
    t.ownerUserId = userId;
    t.ownerEmail = email !== "" ? email : t.ownerEmail;
    t.meta = { ...t.meta, ownerUserId: userId, ownerEmail: t.ownerEmail };
    // Persist the (re)claimed owner so the next boot's sidecar restores it. No-op
    // when persistence is disabled.
    this.persistence?.persistMeta(t.meta);
  }

  // Owner-lock (#874): admit the SAME HUMAN by EMAIL first — the stable identity
  // that is constant across storage layers — and fall back to the legacy exact
  // ownerUserId match for sessions with no ownerEmail (pre-#874 or local-daemon).
  // A different user (even one with daemon access) can't touch it.
  private owned(terminalId: string, userId: string, userEmail?: string): TrackedTerminal | null {
    const t = this.sessions.get(terminalId);
    if (!t) return null;
    if (!ownsTracked(t, userId, userEmail)) return null;
    return t;
  }

  // Idempotent: onExit may fire after an explicit kill or dispose.
  private cleanup(terminalId: string): void {
    const t = this.sessions.get(terminalId);
    if (!t) return;
    // Capture the directory key BEFORE deletion so the post-removal snapshot
    // (which omits this now-gone session) reaches the right owner.
    const workspaceId = t.meta.workspaceId ?? null;
    const ownerUserId = t.ownerUserId;
    this.sessions.delete(terminalId);
    for (const v of t.viewers) this.disposeViewer(v);
    t.viewers.clear();
    try {
      t.unsubPersist();
      t.unsubExit();
    } catch {
      // Best-effort teardown — never throw out of cleanup.
    }
    // A removed session changed the owner's workspace directory — push the fresh
    // (shrunk) snapshot so a CLI/other-client kill clears the sidebar row. Skipped
    // during dispose() (daemon shutdown): the sockets are tearing down anyway and
    // a final per-session broadcast storm is pointless.
    if (!this.disposing) {
      this.notifyDirectoryChanged(workspaceId, ownerUserId);
    }
  }
}

// Email-keyed owner predicate (#874). The shared rule for "does this human own
// this terminal", applied to both the live TrackedTerminal and a persisted dead
// meta. The opaque ownerUserId DIVERGES across storage layers for one human (PG
// users.id vs a fresh randomUUID() per email per SQLite file), so a re-attach that
// arrives under a different id would be rejected by an exact-id match even though
// it is the real owner. EMAIL is the stable human identity, constant across every
// layer, so it is matched FIRST. The exact-id match is the legacy fallback that
// keeps sessions with no owner email (pre-#874, or a local-daemon caller without an
// auth email) working unchanged. An empty stored email or subscriber email never
// matches by email — it falls through to the id check — so it can't admit a
// stranger.
// Canonicalize an email for the owner-lock: trim + lowercase so casing/whitespace
// never breaks the match. The same human's email can arrive with different casing
// across the cloud create (JWT) vs re-subscribe (PG) paths (#876), so BOTH sides
// are normalized before comparison and before stamping. An absent/empty email
// normalizes to "" (which never matches by email — it falls through to the id gate).
function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

// Email-match (normalized) with a canonical-id fallback (defense in depth, #878):
// even if the two stored emails differ in a way trim+lowercase doesn't reconcile,
// uuidv5(email) — the canonical user id both storage layers derive — gives a second
// chance to resolve the SAME human. An empty stored or subscriber email never
// matches (it falls through to the exact-id gate), so a stranger is never admitted.
function ownsByEmail(ownerEmail: string, userEmail: string | undefined): boolean {
  const owner = normalizeEmail(ownerEmail);
  const user = normalizeEmail(userEmail);
  if (owner === "" || user === "") return false;
  if (owner === user) return true;
  // Canonical-id fallback: both emails map to the same uuidv5 identity (#878).
  return canonicalUserId(owner) === canonicalUserId(user);
}

function ownsTracked(t: TrackedTerminal, userId: string, userEmail: string | undefined): boolean {
  return ownsByEmail(t.ownerEmail, userEmail) || t.ownerUserId === userId;
}

function ownsMeta(
  meta: PersistedTerminalMeta,
  userId: string,
  userEmail: string | undefined,
): boolean {
  return ownsByEmail(meta.ownerEmail ?? "", userEmail) || meta.ownerUserId === userId;
}

// Derive a directory-row label from a session cwd: the trailing path segment
// ("repo" for /home/me/repo), falling back to "Terminal" for an empty/root/unknown
// cwd. Mirrors the UI's terminalTitle() so a directory-sourced row reads the same
// as a client-started one. Handles both POSIX and Windows separators.
function deriveTerminalTitle(cwd: string | null | undefined): string {
  if (!cwd) return "Terminal";
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]+/);
  const last = parts[parts.length - 1]?.trim();
  return last && last !== "~" ? last : "Terminal";
}
