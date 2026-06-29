// Per-channel / per-DM composer drafts.
//
// v1 (cyborg7-core MessageComposer.tsx) lifts unsent text + pending
// attachments into the parent, which persists them per chat (initialText /
// onTextChange / initialAttachments / onAttachmentsChange). The rewrite keeps
// that state here so switching channel/DM/thread preserves what you were
// typing and restores it when you return; a successful send clears the draft.
//
// Persistence model (three layers):
//   - In-memory `$state` is the reactive source of truth for live binding.
//   - localStorage mirrors the TEXT of each draft (key `cyborg7:draft:<ws>:<scope>`)
//     so it survives a full page reload INSTANTLY — no round-trip needed. On first
//     access the store lazily hydrates the persisted text back in.
//   - The server (#610) holds the TEXT per (user, scope) so a draft follows the
//     user ACROSS DEVICES. Writes are debounced (one PG write per pause, not per
//     keystroke); on workspace load we fetch the server's drafts and reconcile
//     them against the local cache (newest `updatedAt` wins). A `draft_changed`
//     broadcast from the user's OTHER device live-applies here too.
//   - Pending attachments hold live `File` objects, so they are deliberately NOT
//     serialized to either layer — they can't cross a reload or a device anyway.
//     Only text persists/syncs.
//
// BACK-COMPAT: the server layer is purely additive. If the sync transport is
// never wired (e.g. a consumer that doesn't call `bindSync`), or the user is
// offline, the store degrades to the exact pre-#610 localStorage behavior — no
// data loss, existing drafts keep working.

import { workspaceState } from "./core/state.svelte.js";
import type { PendingFile } from "./components/composer/ComposerAttachments.svelte";

export interface Draft {
  text: string;
  files: PendingFile[];
}

// A server draft as seeded on workspace load / pushed by a draft_changed
// broadcast. `updatedAt` is epoch ms — the reconcile tiebreaker (newest wins).
export interface ServerDraft {
  scope: string;
  text: string;
  updatedAt: number;
}

// The minimal slice of the WS client the drafts store needs. Injected via
// `bindSync` (from app state) rather than imported, so this leaf module never
// pulls the client/app-state graph in and risks an import cycle. When unbound,
// every server call is a no-op and the store behaves exactly as pre-#610.
export interface DraftSyncTransport {
  draftSet(workspaceId: string, scope: string, text: string, updatedAt: number): void;
  draftClear(workspaceId: string, scope: string): void;
}

// Debounce window for the server write. localStorage is updated synchronously on
// every keystroke (instant cache); the server only needs the settled value, so
// we coalesce a burst of typing into one PG upsert after the user pauses.
const SERVER_DEBOUNCE_MS = 800;

// Reconcile a freshly-fetched set of SERVER drafts against the device's LOCAL
// cache on workspace load. Pure (no I/O, no reactive state) so it's unit-testable
// without a DB or a browser. For each scope the NEWEST write wins:
//   - server newer than local  → take server's text (a draft typed on another device)
//   - local newer than server  → keep local (an offline edit not yet flushed); the
//                                 caller re-pushes it so the server catches up
//   - scope only on server      → adopt it (this device never had that draft)
//   - scope only locally        → keep it (re-push so the server learns about it)
// `localUpdatedAt(scope)` returns the device's last-known edit time for a scope
// (epoch ms), or undefined if this device has no local draft for it.
export interface ReconcileLocalEntry {
  scope: string;
  text: string;
  updatedAt: number;
}
export interface ReconcileResult {
  // Scope → text the store should now hold (the winning value per scope).
  apply: Map<string, string>;
  // Local-only / locally-newer scopes whose text the caller must re-push to the
  // server so it converges. Each carries the text + the local updatedAt to send.
  pushBack: ReconcileLocalEntry[];
}
export function reconcileDrafts(
  server: ServerDraft[],
  local: ReconcileLocalEntry[],
): ReconcileResult {
  const apply = new Map<string, string>();
  const pushBack: ReconcileLocalEntry[] = [];
  const localByScope = new Map<string, ReconcileLocalEntry>();
  for (const l of local) localByScope.set(l.scope, l);
  const seen = new Set<string>();

  for (const s of server) {
    seen.add(s.scope);
    const l = localByScope.get(s.scope);
    if (l && l.updatedAt > s.updatedAt) {
      // Local edit is newer (offline change the server hasn't seen): keep it and
      // re-push so the server converges to it.
      apply.set(s.scope, l.text);
      pushBack.push(l);
    } else {
      // Server is newer-or-equal: adopt the server's text. (Equal → identical
      // content; taking server is a harmless no-op that keeps the rule simple.)
      apply.set(s.scope, s.text);
    }
  }

  // Local-only scopes the server never had → keep + push so it learns them.
  for (const l of local) {
    if (seen.has(l.scope)) continue;
    apply.set(l.scope, l.text);
    pushBack.push(l);
  }

  return { apply, pushBack };
}

// localStorage key for a draft's persisted text. Scoped by workspace so each
// workspace restores its own drafts (mirrors lastChannelKey in app.svelte.ts).
// `scopeId` is the opaque draft key (channel:<id>, dm:<peerId>, thread:<id>).
function storageKey(scopeId: string): string {
  const wsId = workspaceState.current?.id ?? "_";
  return `cyborg7:draft:${wsId}:${scopeId}`;
}

// Parallel key holding the epoch-ms time the local draft text was last written.
// Used as the reconcile tiebreaker so an offline edit can out-rank a stale server
// draft on the next workspace load.
function tsKey(scopeId: string): string {
  const wsId = workspaceState.current?.id ?? "_";
  return `cyborg7:draft-ts:${wsId}:${scopeId}`;
}

function readPersisted(scopeId: string): string | null {
  try {
    return localStorage.getItem(storageKey(scopeId));
  } catch {
    return null; // private mode / storage disabled
  }
}

function readPersistedTs(scopeId: string): number {
  try {
    const raw = localStorage.getItem(tsKey(scopeId));
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writePersisted(scopeId: string, text: string, updatedAt: number): void {
  try {
    localStorage.setItem(storageKey(scopeId), text);
    localStorage.setItem(tsKey(scopeId), String(updatedAt));
  } catch {
    // intentional: best-effort draft persistence; no-op when storage is disabled.
  }
}

function removePersisted(scopeId: string): void {
  try {
    localStorage.removeItem(storageKey(scopeId));
    localStorage.removeItem(tsKey(scopeId));
  } catch {
    // intentional: best-effort draft cleanup; no-op when storage is disabled.
  }
}

class DraftsState {
  // Keyed by an opaque draft key (channel:<id>, dm:<peerId>, thread:<rootId>).
  private drafts = $state<Record<string, Draft>>({});

  // Injected WS sync transport (server-side draft sync, #610). Unset until
  // app-state calls bindSync; while unset every server write is a no-op and the
  // store behaves exactly as the pre-#610 localStorage-only version.
  private sync: DraftSyncTransport | null = null;

  // Pending debounced server writes, keyed by scope. We coalesce a burst of
  // keystrokes into one PG upsert after the user pauses (SERVER_DEBOUNCE_MS).
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Wire the server sync transport once (from app state). Idempotent.
  bindSync(transport: DraftSyncTransport): void {
    this.sync = transport;
  }

  get(key: string): Draft | undefined {
    // In-memory wins. On a miss, fall back to the persisted text from localStorage
    // so a reload restores it — returned as a FRESH Draft WITHOUT mutating reactive
    // state. get() must stay pure (no `this.drafts = …`) because it's also called
    // from inside a $derived (the sidebar's "Unsent draft" badge); mutating $state
    // there throws state_unsafe_mutation and crash-loops the app. The in-memory map
    // is filled by save() on the first edit; reads are cheap (conversation open).
    const inMem = this.drafts[key];
    if (inMem) return inMem;
    const persisted = readPersisted(key);
    return persisted != null && persisted !== "" ? { text: persisted, files: [] } : undefined;
  }

  // Persist the current composer contents for `key`. Empty drafts (no text,
  // no files) are removed so stale keys don't linger.
  save(key: string, draft: Draft): void {
    if (draft.text.trim() === "" && draft.files.length === 0) {
      this.clear(key);
      return;
    }
    const now = Date.now();
    // $state objects are deeply proxied in Svelte 5: assigning a single key
    // mutates in place and triggers only that key's subscribers (more surgical
    // than reassigning the whole object).
    this.drafts[key] = { text: draft.text, files: draft.files };
    // Mirror only the text to localStorage (live File objects can't serialize).
    // Instant cache: written synchronously on every keystroke.
    writePersisted(key, draft.text, now);
    // Server sync: debounced so a burst of typing is one PG upsert, not one per
    // keystroke. The TEXT is the only thing synced (attachments can't cross).
    this.scheduleServerSet(key, draft.text);
  }

  clear(key: string): void {
    // Did this draft exist anywhere (memory / persisted cache / a pending flush)?
    // clear() runs on every conversation switch and blur, so only touch the server
    // when there was actually something to clear — otherwise we'd emit a useless
    // draft_clear frame (and broadcast) on every blur over an empty composer.
    const pending = this.flushTimers.get(key);
    const existed = key in this.drafts || readPersisted(key) != null || pending !== undefined;

    removePersisted(key);
    // Cancel any pending debounced set so a late flush can't resurrect the draft
    // we're clearing (e.g. clear-on-send racing a still-pending keystroke flush).
    if (pending) {
      clearTimeout(pending);
      this.flushTimers.delete(key);
    }
    // Tell the server to drop it too (idempotent server-side), but only if it
    // could plausibly have a row — saves a frame per empty-composer blur.
    const wsId = workspaceState.current?.id;
    if (existed && this.sync && wsId) this.sync.draftClear(wsId, key);

    if (!(key in this.drafts)) return;
    // Deleting a key from the deeply-proxied $state object triggers reactivity
    // in place — no whole-object reassignment needed.
    delete this.drafts[key];
  }

  // ─── Server-side draft sync (#610) ───────────────────────────────

  private scheduleServerSet(key: string, text: string): void {
    const wsId = workspaceState.current?.id;
    if (!this.sync || !wsId) return; // unbound / no active workspace → localStorage only
    const sync = this.sync;
    const existing = this.flushTimers.get(key);
    if (existing) clearTimeout(existing);
    this.flushTimers.set(
      key,
      setTimeout(() => {
        this.flushTimers.delete(key);
        // Re-read the active workspace at flush time; a switch mid-debounce must
        // not write the new draft under the old workspace's id.
        const liveWs = workspaceState.current?.id;
        if (liveWs === wsId) sync.draftSet(wsId, key, text, Date.now());
      }, SERVER_DEBOUNCE_MS),
    );
  }

  // Apply a draft pushed from the user's OTHER device (cyborg:draft_changed).
  // text === null means the other device sent/cleared it → drop here too. We
  // update BOTH the in-memory map and localStorage (with the remote updatedAt) so
  // a subsequent reload doesn't out-rank the remote change with a stale local ts.
  // No server write is triggered (this IS the server's truth arriving).
  applyRemoteChange(scope: string, text: string | null, updatedAt: number): void {
    if (text === null || text === "") {
      removePersisted(scope);
      // In-place delete on the deeply-proxied $state object triggers reactivity.
      if (scope in this.drafts) delete this.drafts[scope];
      return;
    }
    writePersisted(scope, text, updatedAt);
    const existing = this.drafts[scope];
    // In-place key assignment on the deeply-proxied $state object.
    this.drafts[scope] = { text, files: existing?.files ?? [] };
  }

  // Seed from the server on workspace load and reconcile against the local cache
  // (newest updatedAt wins). Local-only / locally-newer drafts are re-pushed so
  // the server converges. Pure reconcile lives in reconcileDrafts(); this method
  // gathers the local snapshot, applies the winners, and fires the push-backs.
  seedFromServer(serverDrafts: ServerDraft[]): void {
    const wsId = workspaceState.current?.id;
    // Gather this device's local drafts for the active workspace: in-memory rows
    // plus any localStorage-only ones present in the server set (so we can compare
    // timestamps even for scopes not yet pulled into memory this session).
    const local: ReconcileLocalEntry[] = [];
    const localScopes = new Set<string>();
    for (const [scope, d] of Object.entries(this.drafts)) {
      if (d.text.trim() === "") continue;
      local.push({ scope, text: d.text, updatedAt: readPersistedTs(scope) || 0 });
      localScopes.add(scope);
    }
    for (const s of serverDrafts) {
      if (localScopes.has(s.scope)) continue;
      const text = readPersisted(s.scope);
      if (text != null && text !== "") {
        local.push({ scope: s.scope, text, updatedAt: readPersistedTs(s.scope) || 0 });
        localScopes.add(s.scope);
      }
    }

    const { apply, pushBack } = reconcileDrafts(serverDrafts, local);

    // Apply the winning text per scope to in-memory + localStorage. Use the
    // server's updatedAt for server-won scopes so a reload keeps the right order.
    const serverTs = new Map(serverDrafts.map((s) => [s.scope, s.updatedAt]));
    for (const [scope, text] of apply) {
      const existing = this.drafts[scope];
      // In-place key assignment on the deeply-proxied $state object.
      this.drafts[scope] = { text, files: existing?.files ?? [] };
      // readPersistedTs returns 0 (not undefined) on missing/invalid, so use ||
      // to fall back to now() instead of persisting a 0 timestamp.
      const ts = serverTs.get(scope) ?? (readPersistedTs(scope) || Date.now());
      writePersisted(scope, text, ts);
    }

    // Re-push local-only / locally-newer drafts so the server learns/updates them.
    if (this.sync && wsId) {
      for (const l of pushBack)
        this.sync.draftSet(wsId, l.scope, l.text, l.updatedAt || Date.now());
    }
  }

  // Drop all in-memory drafts (logout / account switch). localStorage is left
  // intact (it's workspace-scoped and per-origin) so a re-login restores cache;
  // server truth re-seeds on the next workspace load.
  clearAllLocal(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    this.drafts = {};
  }
}

export const draftsState = new DraftsState();
