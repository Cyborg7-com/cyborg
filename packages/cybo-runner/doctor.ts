import { spawnSync } from "node:child_process";
import { loadCybo, findCyboDir } from "./manifest.js";
import { describePi, type PiExec } from "./pi-path.js";
import { loadRuntimeAuth } from "./login-cmd.js";
import { detectExisting, DISCOVERABLE_BACKENDS, BACKEND_LABELS } from "./credential-discovery.js";

const OK = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m●\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function pad(label: string, width = 16): string {
  return label.padEnd(width);
}

// Per-backend auth diagnostic: cross the Cybo runtime store (what's connected)
// with the host machine's existing logins (what's importable). This replaces
// the old single "auth.json exists?" line — it's the diagnostic that tells a
// user WHY a cybo can't run: connected, importable (a host login is sitting
// right there), found-but-expired, or genuinely absent.
async function reportAuth(): Promise<void> {
  let connected = new Set<string>();
  try {
    const auth = await loadRuntimeAuth();
    connected = new Set(Object.keys(auth.getAll()).map((id) => id.toLowerCase()));
  } catch {
    // Runtime not loadable (not installed yet) — show host detection only.
  }
  console.log("Auth (Cybo runtime ← this machine):");
  for (const backend of DISCOVERABLE_BACKENDS) {
    // Pad on the PLAIN text width — the DIM/RESET codes are zero-width but count
    // toward .length, so padEnd over a styled string misaligns the columns.
    const plain = `${BACKEND_LABELS[backend]} (${backend})`;
    const styled = `${BACKEND_LABELS[backend]} ${DIM}(${backend})${RESET}`;
    const label = styled + " ".repeat(Math.max(0, 30 - plain.length));
    const isConnected = [...connected].some((id) => id.includes(backend));
    const host = detectExisting(backend);
    let state: string;
    if (isConnected) {
      state = `${OK} connected in the runtime store`;
    } else if (host?.valid) {
      state = `${WARN} importable ${DIM}— ${BACKEND_LABELS[backend]} login on this machine (${host.source})${RESET}`;
    } else if (host) {
      state = `${WARN} found but expired ${DIM}(${host.source}) — sign in to refresh${RESET}`;
    } else {
      state = `${FAIL} absent`;
    }
    console.log(`  ${label}${state}`);
  }
}

// oxlint-disable-next-line eslint/complexity -- sequential diagnostic checks
export async function runDoctor(pi: PiExec, cyboPath?: string): Promise<void> {
  let piVersion: string | null = null;
  const vr = spawnSync(pi.cmd, [...pi.pre, "--version"], { timeout: 5000 });
  // spawnSync sets `error` (it does NOT throw) when the binary is missing/
  // unspawnable (ENOENT) — treat that as not-runnable, like a non-zero exit (#186).
  if (!vr.error && vr.status === 0) {
    const out = (vr.stdout?.toString() || vr.stderr?.toString() || "").trim();
    if (out) piVersion = out;
  }
  console.log(
    `${piVersion ? OK : FAIL} ${pad("PI (bundled)")}${piVersion ? `v${piVersion} ${DIM}${describePi(pi)}${RESET}` : `not runnable — ${describePi(pi)}`}`,
  );

  await reportAuth();

  const dir = cyboPath ?? findCyboDir(process.cwd());
  if (!dir) {
    console.log(`${FAIL} ${pad("cybo.json")}not found in current directory tree`);
    return;
  }

  let cyboLabel: string;
  let targetModel: string | null = null;
  try {
    const cybo = loadCybo(dir);
    const m = cybo.manifest;
    targetModel = m.model ? `${m.provider}/${m.model}` : m.provider;
    cyboLabel = `${m.slug} ${DIM}(${targetModel})${RESET}`;
    console.log(`${OK} ${pad("cybo.json")}${cyboLabel}`);
  } catch (err) {
    console.log(
      `${FAIL} ${pad("cybo.json")}parse error: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  if (!piVersion || !targetModel) return;

  const mr = spawnSync(pi.cmd, [...pi.pre, "--list-models"], { timeout: 10000 });
  const modelsOut = (mr.stdout?.toString() || mr.stderr?.toString() || "").trim();
  if (mr.error || mr.status !== 0 || !modelsOut) {
    console.log(`${FAIL} ${pad("Model avail.")}could not query PI models`);
    return;
  }
  const lines = modelsOut.split("\n").filter((l) => l.trim());
  const total = Math.max(0, lines.length - 1);
  const [provider, model] = targetModel.includes("/")
    ? targetModel.split("/", 2)
    : [targetModel, null];
  const found = lines.some((line) => {
    const cols = line.trim().split(/\s+/);
    if (!model) return cols[0] === provider;
    return cols[0] === provider && cols[1] === model;
  });
  console.log(
    `${found ? OK : FAIL} ${pad("Model avail.")}${found ? `${targetModel} found in ${total} models` : `${targetModel} not found (${total} models available — run cybo model list)`}`,
  );
}
