import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";

// ─── Session safety: rotating backup + corrupt-JSON quarantine ───────────────
//
// Agent session state is persisted by Paseo's AgentStorage as one JSON file per
// agent. A crash, disk error, or external edit can leave a file truncated or
// otherwise unparseable — AgentStorage then silently skips it on load and the
// session is lost. This module hardens that WITHOUT modifying Paseo's
// agent-storage.ts:
//
//   • Before every write, the current valid record JSON is copied to a 1-level
//     `<file>.bak` backup (we only ever back up VALID content, so a `.bak` is
//     always a good recovery source).
//   • At startup, every record is validated; a corrupt one is moved to a
//     `.corrupt/` quarantine dir (preserved for forensics) and, if its `.bak`
//     parses, recovered in place. A visible WARN is logged either way.
//
// Installed from bootstrap.ts (our extended file) by wrapping AgentStorage's
// public `upsert` and running the startup sweep before the first load.

const BACKUP_SUFFIX = ".bak";
const QUARANTINE_DIR = ".corrupt";

// Mirror of agent-storage.ts's private projectDirNameFromCwd so we can locate a
// record's file without touching Paseo code. If the upstream scheme ever drifts,
// backupBeforeWrite simply finds no current file and skips the backup (safe
// degradation) — it never writes to a wrong path.
function projectDirNameFromCwd(cwd: string): string {
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? `${sanitizedRoot}-` : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

function recordFilePath(baseDir: string, record: StoredAgentRecord): string {
  return path.join(baseDir, projectDirNameFromCwd(record.cwd), `${record.id}.json`);
}

// A record file is "valid" if it parses to a non-empty JSON object. Truncated or
// garbled content fails JSON.parse; this stays decoupled from the agent schema
// (parseStoredAgentRecord remains AgentStorage's job).
function isValidRecordJson(content: string): boolean {
  if (content.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// Rotate a 1-level backup of the record's CURRENT valid JSON before it gets
// overwritten. Best-effort: any failure is logged at debug and never blocks the
// write. A missing or invalid current file is left untouched so we never clobber
// a last-known-good `.bak` with garbage.
async function backupBeforeWrite(
  baseDir: string,
  record: StoredAgentRecord,
  logger: Logger,
): Promise<void> {
  const file = recordFilePath(baseDir, record);
  try {
    const content = await fs.readFile(file, "utf8");
    if (!isValidRecordJson(content)) return;
    await fs.writeFile(`${file}${BACKUP_SUFFIX}`, content, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.debug({ err, agentId: record.id, file }, "session-safety: backup skipped");
    }
  }
}

async function walkRecordFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    // Never descend into our own quarantine dir.
    if (entry.name === QUARANTINE_DIR) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkRecordFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      // `.bak` siblings end in `.json.bak`, not `.json`, so they're excluded.
      out.push(full);
    }
  }
  return out;
}

// Startup sweep: validate every record, recover corrupt ones from their `.bak`,
// and quarantine the corrupt copy. Runs before AgentStorage.load() so the cache
// only ever loads clean (or recovered) records.
async function recoverAndQuarantine(baseDir: string, logger: Logger, now: number): Promise<void> {
  const files = await walkRecordFiles(baseDir);
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (isValidRecordJson(content)) continue;

    // Corrupt/truncated. Try to recover from the sibling backup.
    let recovered = false;
    try {
      const bakContent = await fs.readFile(`${file}${BACKUP_SUFFIX}`, "utf8");
      if (isValidRecordJson(bakContent)) {
        await fs.writeFile(file, bakContent, "utf8");
        recovered = true;
      }
    } catch {
      // no usable backup
    }

    // Preserve the corrupt copy and take it out of the live tree.
    try {
      const quarantineDir = path.join(baseDir, QUARANTINE_DIR);
      await fs.mkdir(quarantineDir, { recursive: true });
      const dest = path.join(quarantineDir, `${path.basename(file)}.${now}.corrupt`);
      if (recovered) {
        // `file` now holds the recovered content; stash the corrupt original we
        // already read into quarantine.
        await fs.writeFile(dest, content, "utf8");
      } else {
        // Nothing to recover — move the corrupt file out so load() doesn't keep
        // tripping over it.
        await fs.rename(file, dest);
      }
    } catch (err) {
      logger.warn({ err, file }, "session-safety: failed to quarantine corrupt agent record");
    }

    if (recovered) {
      logger.warn({ file }, "session-safety: recovered corrupt agent record from .bak backup");
    } else {
      logger.warn({ file }, "session-safety: quarantined corrupt agent record (no valid backup)");
    }
  }
}

export interface InstallSessionSafetyOptions {
  agentStorage: AgentStorage;
  // Same path passed to `new AgentStorage(baseDir, ...)` (config.agentStoragePath).
  baseDir: string;
  logger: Logger;
  // Injected for deterministic quarantine filenames in tests; defaults to Date.now().
  now?: number;
}

// Wrap AgentStorage's write path + run the startup recovery sweep. Call from
// bootstrap AFTER constructing AgentStorage and BEFORE agentStorage.initialize().
export async function installSessionSafety(opts: InstallSessionSafetyOptions): Promise<void> {
  const { agentStorage, baseDir, logger } = opts;
  const now = opts.now ?? Date.now();

  // 1) Recover/quarantine corrupt records before the first load reads them.
  await recoverAndQuarantine(baseDir, logger, now);

  // 2) Rotate a backup of the current valid record before each write. Wrap the
  //    private `writeRecord` rather than the public `upsert`: every write path
  //    (upsert AND setGeneratedTitle, which bypasses upsert) funnels through
  //    writeRecord inside AgentStorage's serialized pendingWrites chain, so this
  //    (a) covers all writers and (b) reads disk exactly when each write is about
  //    to happen — capturing the true current state in order, with no rapid-write
  //    race. Fall back to wrapping upsert if upstream ever renames writeRecord
  //    (degraded coverage, but still safe).
  const storageInternals = agentStorage as unknown as {
    writeRecord?: (record: StoredAgentRecord) => Promise<void>;
  };
  if (typeof storageInternals.writeRecord === "function") {
    const originalWriteRecord = storageInternals.writeRecord.bind(agentStorage);
    storageInternals.writeRecord = async (record: StoredAgentRecord): Promise<void> => {
      await backupBeforeWrite(baseDir, record, logger);
      return originalWriteRecord(record);
    };
  } else {
    const originalUpsert = agentStorage.upsert.bind(agentStorage);
    agentStorage.upsert = async (record: StoredAgentRecord): Promise<void> => {
      await backupBeforeWrite(baseDir, record, logger);
      return originalUpsert(record);
    };
  }

  logger.info({ baseDir }, "session-safety: agent record backup + quarantine installed");
}
