import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { loadCybo, findCyboDir } from "./manifest.js";
import { CyboRunner } from "./runner.js";
import { runDoctor } from "./doctor.js";
import { showModel, listModels, setModel } from "./model-cmd.js";
import { runInit } from "./init-cmd.js";
import { runLogin, runLogout } from "./login-cmd.js";
import { resolvePi, resolvePiPackageJson } from "./pi-path.js";
import {
  linkAgent,
  unlinkAgent,
  listAgents,
  resolveAgentBySlug,
  resolveDefaultAgent,
} from "./home.js";
import {
  maybeNotifyUpdate,
  runBackgroundRefresh,
  getInstallUrl,
  getInstallPs1Url,
  getInstallSha256Url,
  getInstallPs1Sha256Url,
  BACKGROUND_REFRESH_FLAG,
} from "./update-check.js";

function readVersion(): string {
  try {
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// oxlint-disable-next-line eslint/complexity -- CLI dispatch with many subcommands and flags
async function main() {
  const args = process.argv.slice(2);

  // cybo owns the update surface (like feynman): the bundled PI's version is
  // managed by cybo's release bundle, so silence PI's own "new PI version"
  // notice. PI_SKIP_VERSION_CHECK is PI's dedicated knob (unlike PI_OFFLINE it
  // doesn't disable tools/model network). All PI children inherit this env.
  // cybo's own update notifier (cyborg7-releases) stays the single source.
  process.env.PI_SKIP_VERSION_CHECK = "1";

  // Detached background refresh (spawned by maybeNotifyUpdate). Must run before
  // anything else and exit — otherwise it would re-trigger the update check.
  if (args.includes(BACKGROUND_REFRESH_FLAG)) {
    await runBackgroundRefresh();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(readVersion());
    process.exit(0);
  }

  const pi = resolvePi(getArg(args, "--pi-command"));
  const agentSlug = getArg(args, "--agent");

  const sub = args[0];

  // Non-blocking "new version available" notice (cached; skip for upgrade).
  if (sub !== "upgrade" && sub !== "update") maybeNotifyUpdate(readVersion());

  // --- Subcommands ---

  // `update` is an alias for `upgrade`: the embedded PI's own update notice
  // tells users to "Run cybo update" (it uses our binary name), so the suggested
  // command must work. Updating the cybo package re-bundles a newer PI too.
  if (sub === "upgrade" || sub === "update") {
    await runUpgrade();
    return;
  }
  if (sub === "doctor") {
    await runDoctor(pi, resolveSlugArg(agentSlug) ?? resolveAtSlug(args[1]));
    return;
  }
  if (sub === "login") {
    process.exit(await runLogin({ provider: args[1]?.startsWith("-") ? undefined : args[1] }));
  }
  if (sub === "logout") {
    process.exit(await runLogout({ provider: args[1]?.startsWith("-") ? undefined : args[1] }));
  }
  if (sub === "model") {
    const action = args[1];
    if (action === "list") {
      listModels(pi);
    } else if (action === "set" && args[2]) {
      setModel(args[2], resolveSlugArg(agentSlug));
    } else {
      showModel(resolveSlugArg(agentSlug));
    }
    return;
  }
  if (sub === "config") {
    const r = spawnSync(pi.cmd, [...pi.pre, "config"], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
  if (sub === "init") {
    await runInit(pi);
    return;
  }
  if (sub === "link") {
    runLink();
    return;
  }
  if (sub === "unlink") {
    runUnlink(args[1]);
    return;
  }
  if (sub === "list") {
    runList();
    return;
  }
  if (sub === "uninstall") {
    runUninstall();
    return;
  }

  // --- Resolve @slug ---

  let atSlugDir: string | undefined;
  const atArg = args.find((a) => a.startsWith("@") && a.length > 1);
  if (atArg) {
    const slug = atArg.slice(1);
    const resolved = resolveAgentBySlug(slug);
    if (!resolved) {
      console.error(`Cybo "${slug}" not found. Run \`cybo list\` to see registered cybos.`);
      process.exit(1);
    }
    atSlugDir = resolved;
  }

  // --- Flags ---

  const model = getArg(args, "--model");
  const sessionContinue = args.includes("--continue") || args.includes("-c");
  const sessionResume = args.includes("--resume") || args.includes("-r");
  const session = getArg(args, "--session");
  const noSession = args.includes("--no-session");
  const thinking = getArg(args, "--thinking");

  const skipFlags = new Set(["--agent", "--model", "--pi-command", "--session", "--thinking"]);
  const subcommands = new Set([
    "doctor",
    "login",
    "logout",
    "model",
    "config",
    "init",
    "link",
    "login",
    "logout",
    "unlink",
    "list",
    "upgrade",
    "update",
    "uninstall",
  ]);
  const prompt =
    args
      .filter((a, i) => {
        if (a.startsWith("-")) return false;
        if (a.startsWith("@")) return false;
        const prev = args[i - 1];
        if (prev && skipFlags.has(prev)) return false;
        if (subcommands.has(a) && i === 0) return false;
        return true;
      })
      .join(" ") || null;

  // --- Resolve cybo directory ---

  const dir =
    resolveSlugArg(agentSlug) ?? atSlugDir ?? findCyboDir(process.cwd()) ?? resolveDefaultAgent();
  if (!dir) {
    console.error("No cybo found. Run `cybo init`, use `cybo @slug`, or `cybo --agent <name>`.");
    process.exit(1);
  }

  const cybo = loadCybo(dir);
  const m = cybo.manifest;

  const runner = new CyboRunner(cybo, {
    model,
    piCommand: getArg(args, "--pi-command"),
    continue: sessionContinue,
    resume: sessionResume,
    session,
    noSession,
    thinking,
  });

  // --- One-shot ---

  if (prompt) {
    for await (const chunk of runner.stream(prompt)) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
    await runner.close();
    return;
  }

  // --- Interactive (delegate to PI's TUI) ---

  patchPiName(m.name);

  const piArgs = [
    ...pi.pre,
    "--model",
    runner.getModel(),
    "--append-system-prompt",
    cybo.systemPrompt,
  ];
  piArgs.push(...runner.getSessionFlags());

  const child = spawn(pi.cmd, piArgs, { stdio: "inherit" });
  child.on("exit", (code) => {
    restorePiName();
    process.exit(code ?? 0);
  });
}

// --- Subcommand handlers ---

function runLink(): void {
  const dir = findCyboDir(process.cwd());
  if (!dir) {
    console.error("No cybo.json in current directory.");
    process.exit(1);
  }
  const cybo = loadCybo(dir);
  try {
    linkAgent(cybo.manifest.slug, dir);
    console.log(`Linked ${cybo.manifest.slug} → ${dir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function runUnlink(slug?: string): void {
  if (!slug) {
    const dir = findCyboDir(process.cwd());
    if (dir) {
      slug = loadCybo(dir).manifest.slug;
    } else {
      console.error("Usage: cybo unlink <slug>");
      process.exit(1);
    }
  }
  try {
    unlinkAgent(slug);
    console.log(`Unlinked ${slug}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

function runList(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No cybos registered. Run `cybo link` from a cybo directory.");
    return;
  }
  const slugW = Math.max(6, ...agents.map((a) => a.slug.length));
  const nameW = Math.max(4, ...agents.map((a) => a.name.length));
  const modelW = Math.max(5, ...agents.map((a) => a.model.length));

  console.log(`${"SLUG".padEnd(slugW)}  ${"NAME".padEnd(nameW)}  ${"MODEL".padEnd(modelW)}  PATH`);
  for (const a of agents) {
    console.log(
      `${a.slug.padEnd(slugW)}  ${a.name.padEnd(nameW)}  ${a.model.padEnd(modelW)}  \x1b[2m${a.target}\x1b[0m`,
    );
  }
}

function resolveAtSlug(arg?: string): string | undefined {
  if (!arg?.startsWith("@")) return undefined;
  return resolveAgentBySlug(arg.slice(1)) ?? undefined;
}

function resolveSlugArg(slug?: string): string | undefined {
  if (!slug) return undefined;
  const resolved = resolveAgentBySlug(slug);
  if (!resolved) {
    console.error(`Agent "${slug}" not found. Run \`cybo list\` to see registered agents.`);
    process.exit(1);
  }
  return resolved;
}

// --- Utilities ---

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function printHelp() {
  console.log(`
cybo — run any Cybo agent standalone (powered by PI)

Usage:
  cybo [@agent] [options] [prompt]  One-shot mode
  cybo [@agent] [options]           Interactive REPL

Commands:
  cybo init                         Create cybo.json + soul.md interactively
  cybo doctor                       Check PI binary, auth, model availability
  cybo login [provider]             Connect the Cybo runtime to a model provider
                                    (Claude Pro/Max, ChatGPT/Codex OAuth, or API keys)
  cybo logout [provider]            Disconnect a provider from the Cybo runtime
  cybo model                        Show current model from cybo.json
  cybo model list                   List all available models (via PI)
  cybo model set <provider/model>   Set model in cybo.json
  cybo config                       Open PI config TUI (extensions, tools)
  cybo link                         Register current cybo in ~/.cybo/agents/
  cybo unlink [slug]                Remove a cybo from ~/.cybo/agents/
  cybo list                         List all registered cybos
  cybo upgrade (or update)          Update cybo to the latest version
  cybo uninstall                    Remove the cybo launcher (curl install)
  cybo --version, -v                Print the cybo version

Agent selection:
  @slug                 Use a registered agent (e.g. cybo @pi "hello")
  --agent <name>        Use a registered agent by slug (e.g. --agent pi)
  (none)                Auto-detect: cwd → default agent from registry

Options:
  --model <p/m>         Override model, e.g. opencode-go/glm-5.1
  --pi-command <cmd>    Path to PI binary (default: PI_COMMAND env or "pi")
  --continue, -c        Continue previous session
  --resume, -r          Select a session to resume
  --session <id>        Use specific session
  --no-session          Ephemeral mode (don't save session)
  --thinking <level>    Thinking level: off, minimal, low, medium, high, xhigh
  -h, --help            Show this help

Interactive commands:
  /clear                Restart session (clears history)
  /exit, /quit          Exit

Examples:
  cybo init && cybo link              # create and register a cybo
  cybo list                           # see all registered cybos
  cybo @pi "what can you do?"         # invoke PI by name
  cybo @reviewer "check this code"    # invoke reviewer by name
  cybo --thinking high "solve this"   # deep reasoning
`);
}

// Remove the cybo launcher shim + app dir written by the curl/PowerShell installer.
// Detect how cybo was installed: curl puts the running app under the app dir
// (~/.local/share/cybo); npm puts it under a global node_modules.
function curlAppDir(): string {
  const isWin = process.platform === "win32";
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const defaultApp = isWin
    ? join(localAppData, "cybo")
    : join(homedir(), ".local", "share", "cybo");
  return process.env.CYBO_INSTALL_APP_DIR ?? defaultApp;
}

// Download the installer script + its published .sha256 and verify before
// running, so `cybo upgrade` never blind-pipes a tampered/corrupted script into
// a shell (the old `curl … | sh`). Returns the VERIFIED script text, or null on
// any failure (download error, missing/malformed checksum, mismatch) — callers
// must NOT run the script when null.
async function fetchVerifiedInstaller(scriptUrl: string, shaUrl: string): Promise<string | null> {
  try {
    const [scriptRes, shaRes] = await Promise.all([fetch(scriptUrl), fetch(shaUrl)]);
    if (!scriptRes.ok) {
      console.error(`Couldn't download the installer (HTTP ${scriptRes.status}).`);
      return null;
    }
    if (!shaRes.ok) {
      console.error("Installer checksum not published — refusing to run an unverified installer.");
      return null;
    }
    const script = await scriptRes.text();
    // Checksum file is "<hex>  install.sh" (shasum format) or just "<hex>".
    const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      console.error("Installer checksum is malformed — refusing to run.");
      return null;
    }
    const actual = createHash("sha256").update(script, "utf8").digest("hex");
    if (actual !== expected) {
      console.error(
        `Installer checksum mismatch — refusing to run.\n  expected ${expected}\n  got      ${actual}`,
      );
      return null;
    }
    return script;
  } catch (err) {
    console.error("Couldn't verify the installer:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function runUpgrade(): Promise<void> {
  const isWin = process.platform === "win32";
  const here = fileURLToPath(import.meta.url);
  const appDir = curlAppDir();
  // Case-insensitive on Windows — drive-letter casing (C:\ vs c:\) varies by how
  // LOCALAPPDATA is set / how Node resolves the path.
  const curlInstalled = isWin
    ? here.toLowerCase().startsWith(appDir.toLowerCase())
    : here.startsWith(appDir);

  if (curlInstalled) {
    console.log("Updating cybo (verified install)…");
    const scriptUrl = isWin ? getInstallPs1Url() : getInstallUrl();
    const shaUrl = isWin ? getInstallPs1Sha256Url() : getInstallSha256Url();
    const script = await fetchVerifiedInstaller(scriptUrl, shaUrl);
    if (script !== null) {
      // Write the verified bytes to a temp file and run THAT — never pipe an
      // unverified network stream straight into the interpreter.
      const tmp = join(
        tmpdir(),
        `cybo-install-${process.pid}-${Date.now()}.${isWin ? "ps1" : "sh"}`,
      );
      writeFileSync(tmp, script, { mode: 0o700 });
      const cmd = isWin
        ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp]
        : ["sh", tmp];
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
      rmSync(tmp, { force: true });
      // status is null when the command couldn't even spawn — treat as failure.
      process.exit(r.status ?? 1);
    }
    // Verification failed → do NOT run the unverified installer. Fall through to
    // the npm path (registry-verified); if npm is missing too the user gets the
    // manual-reinstall guidance below.
    console.error("Falling back to npm (registry-verified)…");
  }

  // npm global install (or unknown) — let npm pull the latest.
  console.log("Updating cybo via npm…");
  const npm = isWin ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "-g", "@cyborg7/cybo@latest"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(
      "\nCouldn't update automatically. Re-run your installer:\n" +
        `  curl -fsSL ${getInstallUrl()} | sh\n  # or\n  npm i -g @cyborg7/cybo@latest`,
    );
  }
  process.exit(r.status ?? 1);
}

function runUninstall(): void {
  const isWin = process.platform === "win32";
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const defaultBin = isWin ? join(localAppData, "cybo", "bin") : join(homedir(), ".local", "bin");
  const defaultApp = isWin
    ? join(localAppData, "cybo")
    : join(homedir(), ".local", "share", "cybo");
  const binDir = process.env.CYBO_INSTALL_BIN_DIR ?? defaultBin;
  const appDir = process.env.CYBO_INSTALL_APP_DIR ?? defaultApp;
  const shim = join(binDir, isWin ? "cybo.cmd" : "cybo");
  let removed = false;
  for (const target of [shim, appDir]) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`Removed ${target}`);
      removed = true;
    }
  }
  console.log(
    removed
      ? "cybo uninstalled. Your agents in ~/.cybo/ were left untouched."
      : "Nothing to uninstall (no curl-installed cybo found). If installed via npm, run: npm rm -g @cyborg7/cybo",
  );
}

let piPkgPath: string | null = null;
let piPkgOriginal: string | null = null;

const patchedFiles: Array<{ path: string; original: string }> = [];

function patchPiName(name: string): void {
  piPkgPath = resolvePiPackageJson();
  if (!piPkgPath) return;
  piPkgOriginal = readFileSync(piPkgPath, "utf-8");
  const pkg = JSON.parse(piPkgOriginal);
  // Only piConfig.name — a PI-custom field, not an integrity-checked one (PI's
  // config.js reads APP_NAME from here). We deliberately do NOT rewrite
  // package.json `version`: a half-restored version field (e.g. after a SIGKILL
  // before restorePiName) would break package-manager integrity and skew PI's
  // telemetry/user-agent. The banner version is handled by the cosmetic
  // interactive-mode patch below instead.
  pkg.piConfig = { ...pkg.piConfig, name: name.toLowerCase() };
  writeFileSync(piPkgPath, JSON.stringify(pkg, null, "\t") + "\n");

  // Cosmetic JS patch (same approach + risk class as the welcome-line patch):
  // override the banner version to cybo's. `this.version` only drives the
  // interactive banner/display; PI's real VERSION (config.js → telemetry,
  // user-agent, package.json) is untouched.
  const cyboVersion = readVersion();
  const piRoot = resolve(piPkgPath, "..");
  const interactiveMode = resolve(piRoot, "dist", "modes", "interactive", "interactive-mode.js");
  try {
    const original = readFileSync(interactiveMode, "utf-8");
    let src = original.replace(
      /Pi can explain its own features and look up its docs\. Ask it how to use or extend Pi\./g,
      `Type / for commands. Powered by PI.`,
    );
    if (cyboVersion !== "unknown") {
      src = src.replace(
        /this\.version = VERSION;/g,
        `this.version = ${JSON.stringify(cyboVersion)};`,
      );
    }
    if (src !== original) {
      patchedFiles.push({ path: interactiveMode, original });
      writeFileSync(interactiveMode, src);
    }
  } catch {
    /* ignore */
  }
}

function restorePiName(): void {
  if (piPkgPath && piPkgOriginal) {
    writeFileSync(piPkgPath, piPkgOriginal);
    piPkgPath = null;
    piPkgOriginal = null;
  }
  for (const f of patchedFiles) {
    try {
      writeFileSync(f.path, f.original);
    } catch {
      /* ignore */
    }
  }
  patchedFiles.length = 0;
}

process.on("SIGINT", () => {
  restorePiName();
  process.exit(0);
});
process.on("SIGTERM", () => {
  restorePiName();
  process.exit(0);
});

main().catch((err) => {
  restorePiName();
  console.error(err);
  process.exit(1);
});
