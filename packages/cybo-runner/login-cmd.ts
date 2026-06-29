// `cybo login` / `cybo logout` — connect the Cybo runtime to a model provider.
//
// Drives the BUNDLED runtime's own auth machinery (its AuthStorage + OAuth
// provider registry: Claude Pro/Max OAuth, ChatGPT/Codex OAuth, GitHub
// Copilot, plus plain API keys). Credentials land in the runtime's auth store
// with its native auto-refresh — cybo reimplements ZERO auth logic, only the
// thin interactive picker, which is what lets every visible string say "Cybo
// runtime" (branding rule: doc 25).
//
// Why not spawn the runtime's TUI? Its login picker is reachable only by
// typing a slash command inside the full-screen editor (no CLI flag), which
// can't be driven non-interactively without a PTY — and the TUI brands itself.
// Importing the runtime's auth modules by file path (its `exports` map only
// restricts bare specifiers) gives the same real flow, picker-first.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { resolvePiPackageJson } from "./pi-path.js";
import {
  detectAllExisting,
  BACKEND_LABELS,
  type DiscoveredCredential,
} from "./credential-discovery.js";

const OK = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ── The slice of the runtime's AuthStorage that login/logout drives ──────────

export interface RuntimeOAuthProvider {
  id: string;
  name: string;
}

export interface RuntimeLoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onDeviceCode: (info: { userCode: string; verificationUri: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect: (prompt: {
    message: string;
    options: { id: string; label: string }[];
  }) => Promise<string | undefined>;
}

export interface RuntimeAuth {
  getOAuthProviders(): RuntimeOAuthProvider[];
  login(providerId: string, callbacks: RuntimeLoginCallbacks): Promise<void>;
  set(providerId: string, credential: { type: "api_key"; key: string }): void;
  remove(providerId: string): void;
  getAll(): Record<string, { type: string }>;
}

// Load the bundled runtime's real AuthStorage (default store + locking +
// refresh). Imported by FILE PATH: the runtime's `exports` map only restricts
// bare-specifier resolution, and its own relative/bare imports still resolve
// against its node_modules.
export async function loadRuntimeAuth(): Promise<RuntimeAuth> {
  const pkgJson = resolvePiPackageJson();
  if (!pkgJson) {
    throw new Error("Cybo runtime not found — reinstall with: npm i -g @cyborg7/cybo@latest");
  }
  const authJs = join(dirname(pkgJson), "dist", "core", "auth-storage.js");
  const mod = (await import(pathToFileURL(authJs).href)) as {
    AuthStorage: { create(): RuntimeAuth };
  };
  return mod.AuthStorage.create();
}

// ── Minimal interactive prompts (zero deps, like the rest of cybo) ──────────

export interface LoginIo {
  print: (line: string) => void;
  question: (query: string) => Promise<string>;
  openUrl: (url: string) => void;
}

function openUrlCommand(): string {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "start";
  return "xdg-open";
}

// Print a heads-up about host logins already on this machine (internal docs) so
// the user knows which provider to pick. Heads-up only — the runtime keeps its
// own session; the one-click reuse import lands with the remote login flow.
function announceDetectedLogins(io: LoginIo, detected: DiscoveredCredential[]): void {
  if (detected.length === 0) return;
  io.print("Detected logins already on this machine:");
  for (const c of detected) {
    io.print(`  ${DIM}•${RESET} ${BACKEND_LABELS[c.backend]} ${DIM}(${c.source})${RESET}`);
  }
  io.print(`${DIM}Pick the matching provider below to connect the Cybo runtime to it.${RESET}`);
}

function defaultIo(): LoginIo & { close: () => void } {
  // Hand-rolled line queue instead of rl.question(): with PIPED stdin all lines
  // arrive at once, and readline DROPS lines emitted while no question is
  // pending (the microtask gap between two questions loses the next answer).
  // Buffering 'line' events serves piped input reliably and a closed stdin
  // resolves pending questions with "" instead of hanging the process.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const buffered: string[] = [];
  const waiters: Array<(answer: string) => void> = [];
  let ended = false;
  rl.on("line", (line) => {
    const next = waiters.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()?.("");
  });
  return {
    print: (line) => console.log(line),
    question: (query) => {
      process.stdout.write(query);
      const ready = buffered.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
    openUrl: (url) => {
      const cmd = openUrlCommand();
      try {
        spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
          .on("error", () => undefined)
          .unref();
      } catch {
        // Browser open is best-effort; the URL is printed either way.
      }
    },
    close: () => rl.close(),
  };
}

// Numbered picker. Returns the chosen option id, or undefined on empty/EOF.
async function pick(
  io: LoginIo,
  message: string,
  options: { id: string; label: string }[],
): Promise<string | undefined> {
  io.print(`\n${message}`);
  options.forEach((o, i) => io.print(`  ${i + 1}. ${o.label}`));
  const answer = (await io.question(`Choose [1-${options.length}]: `)).trim();
  if (!answer) return undefined;
  const n = Number.parseInt(answer, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
  // Also accept the option id typed directly (e.g. "anthropic").
  return options.find((o) => o.id === answer)?.id;
}

const API_KEY_OPTION = "api-key";
// Suggested ids for the API-key path (any provider id the runtime knows works).
const API_KEY_EXAMPLES = "anthropic, openai, google, opencode-go";

function loginCallbacks(io: LoginIo): RuntimeLoginCallbacks {
  return {
    onAuth: (info) => {
      io.print(`\nOpen this URL to authorize:\n  ${info.url}`);
      if (info.instructions) io.print(info.instructions);
      io.openUrl(info.url);
    },
    onDeviceCode: (info) => {
      io.print(`\nGo to ${info.verificationUri} and enter the code: ${info.userCode}`);
      io.openUrl(info.verificationUri);
    },
    onPrompt: async (prompt) => {
      const hint = prompt.placeholder ? ` ${DIM}(${prompt.placeholder})${RESET}` : "";
      return (await io.question(`${prompt.message}${hint}: `)).trim();
    },
    onProgress: (message) => io.print(`${DIM}${message}${RESET}`),
    onManualCodeInput: async () => (await io.question("Paste the authorization code: ")).trim(),
    onSelect: (prompt) => pick(io, prompt.message, prompt.options),
  };
}

// ── cybo login ───────────────────────────────────────────────────────────────

// oxlint-disable-next-line eslint/complexity -- sequential interactive login flow (picker → detection → oauth/api-key branches)
export async function runLogin(opts?: {
  provider?: string;
  auth?: RuntimeAuth;
  io?: LoginIo & { close?: () => void };
  // Injectable for tests; defaults to the real host-credential probe.
  detect?: () => DiscoveredCredential[];
}): Promise<number> {
  const io = opts?.io ?? defaultIo();
  try {
    const auth = opts?.auth ?? (await loadRuntimeAuth());
    const oauth = auth.getOAuthProviders();

    let choice = opts?.provider;
    if (!choice) {
      // Surface existing host logins BEFORE the picker (internal docs): if the
      // user already signed into Claude/Codex/Gemini on this machine, say so, so
      // they know which provider to connect. The Cybo runtime keeps its OWN
      // session, so this is a heads-up, not an auto-import — picking the matching
      // provider below signs the runtime in (the one-click reuse import lands
      // with the remote login flow). Detection is consent-safe: it never USES a
      // credential.
      const detect = opts?.detect ?? (() => detectAllExisting());
      announceDetectedLogins(
        io,
        detect().filter((c) => c.valid),
      );
      choice = await pick(io, "Connect the Cybo runtime to a model provider:", [
        ...oauth.map((p) => ({ id: p.id, label: p.name })),
        { id: API_KEY_OPTION, label: `API key ${DIM}(${API_KEY_EXAMPLES}, …)${RESET}` },
      ]);
    }
    if (!choice) {
      io.print("Nothing selected — no changes made.");
      return 1;
    }

    if (choice === API_KEY_OPTION) {
      const providerId = (
        await io.question(`Provider id ${DIM}(${API_KEY_EXAMPLES}, …)${RESET}: `)
      ).trim();
      if (!providerId) {
        io.print(`${FAIL} A provider id is required.`);
        return 1;
      }
      const key = (await io.question(`API key for ${providerId}: `)).trim();
      if (!key) {
        io.print(`${FAIL} No key entered — no changes made.`);
        return 1;
      }
      auth.set(providerId, { type: "api_key", key });
      io.print(`${OK} ${providerId} connected (API key). Run \`cybo doctor\` to verify.`);
      return 0;
    }

    const provider = oauth.find((p) => p.id === choice);
    if (!provider) {
      io.print(`${FAIL} Unknown provider "${choice}". Run \`cybo login\` to see the options.`);
      return 1;
    }
    io.print(`\nSigning in to ${provider.name}…`);
    await auth.login(provider.id, loginCallbacks(io));
    io.print(`${OK} ${provider.name} connected. Run \`cybo doctor\` to verify.`);
    return 0;
  } catch (err) {
    io.print(`${FAIL} Login failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    opts?.io?.close?.();
    if (!opts?.io) (io as { close?: () => void }).close?.();
  }
}

// ── cybo logout ──────────────────────────────────────────────────────────────

export async function runLogout(opts?: {
  provider?: string;
  auth?: RuntimeAuth;
  io?: LoginIo & { close?: () => void };
}): Promise<number> {
  const io = opts?.io ?? defaultIo();
  try {
    const auth = opts?.auth ?? (await loadRuntimeAuth());
    const stored = Object.entries(auth.getAll());
    if (stored.length === 0) {
      io.print("No stored credentials — nothing to sign out of.");
      return 0;
    }

    let choice = opts?.provider;
    if (!choice) {
      choice = await pick(
        io,
        "Sign out of:",
        stored.map(([id, cred]) => ({ id, label: `${id} ${DIM}(${cred.type})${RESET}` })),
      );
    }
    if (!choice) {
      io.print("Nothing selected — no changes made.");
      return 1;
    }
    if (!stored.some(([id]) => id === choice)) {
      io.print(`${FAIL} No stored credentials for "${choice}".`);
      return 1;
    }
    auth.remove(choice);
    io.print(`${OK} Signed out of ${choice}.`);
    return 0;
  } catch (err) {
    io.print(`${FAIL} Logout failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    opts?.io?.close?.();
    if (!opts?.io) (io as { close?: () => void }).close?.();
  }
}
