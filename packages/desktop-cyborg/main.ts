// Silence only the known-noisy Node/Electron warnings (the experimental-loader
// and punycode-deprecation spam), NOT all of them — real deprecation and
// security warnings must still surface in the logs.
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (/ExperimentalWarning|punycode/i.test(text)) return;
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize();

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  net,
  Notification,
  protocol,
  shell,
} from "electron";
import electronUpdater, { type AppUpdater } from "electron-updater";
import {
  registerDaemonManager,
  startDesktopDaemon,
  stopDesktopManagedDaemonIfNeeded,
} from "./daemon-manager.js";
import { resolvePaseoHome } from "./desktop-utils.js";
import {
  CLIENT_LOG_PATH,
  CLOUD_RELAY_WS_URL,
  httpBaseFromWsUrl,
  type MainErrorPayload,
  toMainErrorPayload,
} from "./desktop-error-report.js";
import { isTrustedAppOrigin } from "./trusted-origin.js";
import { killAllSetupTerminals, registerSetupTerminal } from "./setup-terminal.js";
import { stopPtyHostForInstall, ensurePtyHostPidGone } from "./pty-host-shutdown.js";
import { reapOrphanPtyHostsOnStart } from "./pty-host-orphan-reaper.js";
import { relocateNativeModulesForWindows } from "./native-relocate.js";

// ─── Observability (Logfire) ─────────────────────────────────────
// The Logfire WRITE TOKEN never ships in any client bundle — the distributed
// desktop DMG is extractable, so the token lives ONLY server-side on the relay.
// The desktop process therefore does NOT run the OTel SDK; it POSTs its errors to
// the relay's /api/cyborg/client-log endpoint (which holds the token and emits
// the Logfire exception), exactly like the web + mobile beacons. electron-log
// keeps handling local file/console logging unchanged.

// Resolve the relay HTTP(S) base for the main-process error beacon. The desktop
// records the bound cloud relay WS url at $PASEO_HOME/cyborg-relay-url after login
// (daemon-manager.ts claim_desktop_daemon); we read the same file and derive its
// HTTP origin, falling back to the canonical cloud relay when unset/unreadable.
function resolveRelayBase(): string {
  let wsUrl = CLOUD_RELAY_WS_URL;
  try {
    const home = resolvePaseoHome(process.env);
    const saved = readFileSync(path.join(home, "cyborg-relay-url"), "utf-8").trim();
    if (saved) wsUrl = saved;
  } catch {
    // intentional: no recorded relay url yet (pre-login) → use the cloud default.
  }
  return httpBaseFromWsUrl(wsUrl);
}

// POST a main-process error to the relay's client-log endpoint via Electron net
// (main process → no CORS, no token; the relay holds the Logfire write token and
// emits the exception server-side). Best-effort: a failed telemetry POST must
// never crash the app, so every failure path is swallowed.
function reportMainError(payload: MainErrorPayload): void {
  try {
    const url = `${resolveRelayBase()}${CLIENT_LOG_PATH}`;
    const body = JSON.stringify({ ...payload, platform: "desktop", version: app.getVersion() });
    net
      .fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
      // intentional: telemetry POST is best-effort; electron-log already wrote it locally.
      .catch(() => {});
  } catch {
    // intentional: building/sending the beacon must never throw into the caller.
  }
}

// Crash-level safety net: forward uncaught main-process errors + rejected
// promises to the relay (and let electron-log still print them locally).
process.on("uncaughtException", (err) => {
  reportMainError(toMainErrorPayload("desktop.main", err, "uncaughtException"));
  log.error("[main] uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  reportMainError(toMainErrorPayload("desktop.main", reason, "unhandledRejection"));
  log.error("[main] unhandledRejection", reason);
});

// Forward every electron-log `error`-level record to the relay WITHOUT disturbing
// the file/console transports: a hook returning the message unchanged lets all
// transports still write it. The hook runs once per transport, so we gate on the
// file transport (always present) to forward exactly once per record.
log.hooks.push((message, _transport, transportName) => {
  if (transportName === "file" && message.level === "error") {
    try {
      const [first, ...rest] = message.data;
      const payload = toMainErrorPayload("desktop.main", first, "electron-log");
      payload.scope = message.scope;
      // Remaining args (objects/strings electron-log appended) as context.
      if (rest.length) payload.detail = rest;
      reportMainError(payload);
    } catch {
      // intentional: the forwarder must never break logging.
    }
  }
  return message;
});

const APP_SCHEME = "cyborg";
const DEV_SERVER_URL = process.env.CYBORG7_DEV_URL ?? "http://localhost:5173";

// Hard ceiling on how long we wait for Electron's graceful quit to actually exit
// the process after we ask to quit (normal quit AND the macOS quitAndInstall). Past
// this we force-exit so a stalled graceful quit can never leave the app
// "half-closed" — the state where, after an auto-update, the user has to Cmd+Q and
// reopen by hand.
const QUIT_WATCHDOG_MS = 4000;

// Windows INSTALL-path force-exit ceiling (FIX B). MUCH longer than the normal
// QUIT_WATCHDOG_MS: on the install path we must NOT force-exit until the detached
// pty-host is confirmed gone, and tearing that host down (graceful frame → poll →
// PID-targeted taskkill → wait-gone) can take ~5-7s by itself. The old 4s watchdog
// could fire while the host was still dying, so quitAndInstall ran (or, worse, a
// bare app.exit) while the host still locked the unpacked node-pty binaries — the
// NSIS uninstall then failed with code 2. We gate quitAndInstall on a bounded
// pid-gone confirmation FIRST, so by the time this watchdog is armed the host is
// already dead; this is just the hard upper bound that guarantees the process can
// never hang forever waiting on a graceful quit.
const INSTALL_QUIT_WATCHDOG_MS = 15000;

// Hard upper bound on the post-stop "is the host pid finally gone?" confirmation
// loop on the Windows install path (FIX B). stopPtyHostForInstall already waited
// its own internal budget; this is the extra, bounded grace we spend re-killing +
// polling a STILL-alive host before we give up and hand off to the install anyway
// (the NSIS image-name kill is the final backstop). Kept under
// INSTALL_QUIT_WATCHDOG_MS so the watchdog is never the thing that ends this wait.
const PTY_HOST_GONE_CONFIRM_BUDGET_MS = 6000;

// macOS install-path LAST-RESORT relaunch net (see armRelaunchSafetyNet). Kept
// well ABOVE the native ShipIt handoff window so it never fires in the happy path
// — on a clean quit this process is already gone and the native relaunch has taken
// over long before this elapses. It exists only for a pathological stuck quit.
const RELAUNCH_SAFETY_NET_MS = 15000;

// Windows-only settle after killing setup-terminal PTYs: node-pty's .kill() tears
// its winpty/ConPTY helpers down asynchronously, so we wait briefly for the unpacked
// helper handles to release before quitAndInstall (see quitForInstall). Kept short
// so it never meaningfully delays the install handoff.
const SETUP_PTY_SETTLE_MS = 600;

// Small awaitable delay. timer.unref() so it can never by itself keep the event
// loop (and thus the process) alive past a quit.
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

let mainWindow: BrowserWindow | null = null;

// ─── Auto-update state ───────────────────────────────────────────
interface UpdateStatus {
  state: "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";
  version: string | null;
  progress: number;
  error: string | null;
  lastCheckedAt: number | null;
}
let updaterRef: AppUpdater | null = null;
let updateStatus: UpdateStatus = {
  state: "idle",
  version: null,
  progress: 0,
  error: null,
  lastCheckedAt: null,
};

function broadcastUpdateStatus(patch: Partial<UpdateStatus>): void {
  updateStatus = { ...updateStatus, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("cyborg7:event:update-status", updateStatus);
  }
}

// Is an auto-update actually waiting to be installed? This is the SINGLE source of
// truth for "the installer is about to swap files in the install dir", and the
// gate that decides whether a quit must first kill the detached PtyHost (which
// would otherwise lock the unpacked node-pty .node and fail the NSIS uninstall).
//   - updateStatus.state === "ready": set on the autoUpdater `update-downloaded`
//     event (the bundle is downloaded and staged) and the exact precondition the
//     "restart & install" IPC checks before calling quitForInstall.
//   - autoInstallOnAppQuit + a downloaded version: electron-updater will install
//     the staged update on quit by itself. This is darwin-only here (see
//     setupAutoUpdater), where stopPtyHostForInstall is a no-op, but we include it
//     so the gate stays correct if that platform split ever changes.
// A NORMAL quit (state idle/checking/up-to-date/downloading/error) returns false,
// so the detached host is left alive and terminals persist across quit→reopen.
function isUpdateInstallPending(): boolean {
  if (updateStatus.state === "ready") return true;
  if (updaterRef?.autoInstallOnAppQuit === true && updateStatus.version !== null) return true;
  return false;
}

if (process.platform === "linux" && process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// ─── Windows taskbar overlay badge ───────────────────────────────
// Windows has no numeric taskbar badge API (app.setBadgeCount only renders on
// the macOS dock and the Linux Unity launcher). The closest visible parity is a
// small overlay icon in the corner of the taskbar button via
// BrowserWindow.setOverlayIcon. We render a tiny red circle with the count
// ("9+" past 9) as a PNG entirely in-process — no shipped asset, so it can't be
// missing — and return null to clear it. Robust: any failure is swallowed so a
// badge update never crashes the app.
function buildWindowsOverlayIcon(count: number): Electron.NativeImage | null {
  if (count <= 0) return null;
  try {
    const size = 32; // device-independent base; Windows scales it down
    const label = count > 9 ? "9+" : String(count);
    // Minimal hand-rolled SVG → dataURL → nativeImage. Avoids a canvas dep and
    // any bundled asset. A filled red disc with white, centered text.
    const fontSize = label.length > 1 ? 15 : 19;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="#ef4444"/>
<text x="50%" y="50%" dy=".05em" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>
</svg>`;
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const img = nativeImage.createFromDataURL(dataUrl);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

function applyWindowsTaskbarBadge(count: number): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    if (count <= 0) {
      win.setOverlayIcon(null, "");
      return;
    }
    const overlay = buildWindowsOverlayIcon(count);
    win.setOverlayIcon(overlay, `${count} unread`);
  } catch (err) {
    log.warn("[badge] setOverlayIcon failed", err);
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function getUiDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ui");
  }
  return path.resolve(__dirname, "../ui/build");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [path.resolve(__dirname, "../assets/icon.png")];
}

function getIconPath(): string | undefined {
  return getWindowIconCandidates().find((c) => existsSync(c));
}

async function createWindow(): Promise<void> {
  const icon = getIconPath();

  const win = new BrowserWindow({
    title: "Cyborg",
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: "#09090b",
    ...(icon ? { icon } : {}),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Only hand off SAFE external schemes to the OS. Without this, a crafted link
  // in chat content could open file://, smb://, or arbitrary custom-protocol
  // handlers registered on the machine.
  const SAFE_EXTERNAL_SCHEMES = new Set(["https:", "mailto:"]);
  win.webContents.setWindowOpenHandler(({ url }) => {
    let scheme: string | null = null;
    try {
      scheme = new URL(url).protocol;
    } catch {
      scheme = null;
    }
    if (scheme && SAFE_EXTERNAL_SCHEMES.has(scheme)) {
      void shell.openExternal(url);
    } else {
      log.warn("[window] blocked openExternal for disallowed url", { url, scheme });
    }
    return { action: "deny" };
  });

  // Deny-by-default in-place navigation: the privileged app window must never
  // leave its own origin (cyborg://app in prod, the dev server in dev). A
  // renderer-side navigation to an arbitrary origin would otherwise land the
  // full window — with its preload + IPC — on that origin.
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppOrigin(url)) {
      event.preventDefault();
      log.warn("[window] blocked in-place navigation", { url });
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error("[window] did-fail-load", { code, desc, url });
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  mainWindow = win;

  const loadUrl = app.isPackaged ? `${APP_SCHEME}://app/` : DEV_SERVER_URL;
  await win.loadURL(loadUrl);
}

// ─── Auto-update ─────────────────────────────────────────────────
// Mirrors the old repo: silent auto-download, install-on-quit, a desktop
// notification when an update is ready, and IPC so the UI can show status /
// trigger an immediate "restart & install". Disabled in dev (unpackaged).
function setupAutoUpdater(): void {
  if (!app.isPackaged) return;
  try {
    const autoUpdater = electronUpdater.autoUpdater;
    updaterRef = autoUpdater;
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // Platform-split, and this split is the whole fix for the macOS relaunch:
    //
    // macOS (true): pre-stage the downloaded bundle into Squirrel during the
    // normal autoDownload cycle. With this true, MacUpdater.doDownloadUpdate()
    // actually hands the zip to the OS autoUpdater, so by click time
    // `squirrelDownloadedUpdate` is true and MacUpdater.quitAndInstall() takes the
    // SYNCHRONOUS handleUpdateDownloaded() branch — it calls the native
    // quitAndInstall() (which schedules ShipIt's swap + relaunch) IMMEDIATELY.
    // With it false (the old code), quitAndInstall() instead registered an async
    // `update-downloaded` listener and kicked off checkForUpdates(): the native
    // relaunch was only issued AFTER an async fetch+stage, and #836's force-exit
    // watchdog killed the process inside that window → bundle swapped but app
    // never auto-relaunched. NOTE: MacUpdater.quitAndInstall() ignores its
    // isSilent/isForceRunAfter ARGS entirely (MacUpdater.js); the relaunch is 100%
    // native Squirrel/ShipIt + autoRunAppAfterInstall (default true), and only
    // happens after THIS process exits cleanly.
    //
    // win32 (false): MUST stay false — with it true, the NSIS MacUpdater path
    // throws "The command is disabled and cannot be executed" on quitAndInstall()
    // and the install/relaunch fails (electron-builder #6418, disabled in
    // 764f0ce3e). Windows installs are driven explicitly via quitForInstall().
    autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
    // Releases are tagged `-alpha` and flagged prerelease on GitHub; without this
    // the GitHub provider filters them out and never finds an update.
    autoUpdater.allowPrerelease = true;

    autoUpdater.on("checking-for-update", () => {
      broadcastUpdateStatus({ state: "checking", error: null, lastCheckedAt: Date.now() });
    });
    autoUpdater.on("update-available", (info) => {
      log.info("[updater] update available", info.version);
      broadcastUpdateStatus({
        state: "downloading",
        version: info.version,
        progress: 0,
        error: null,
      });
    });
    autoUpdater.on("update-not-available", () => {
      broadcastUpdateStatus({ state: "up-to-date", lastCheckedAt: Date.now(), error: null });
    });
    autoUpdater.on("download-progress", (p) => {
      broadcastUpdateStatus({ state: "downloading", progress: Math.round(p.percent ?? 0) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      log.info("[updater] update downloaded", info.version);
      broadcastUpdateStatus({ state: "ready", version: info.version, progress: 100, error: null });
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: "Cyborg update ready",
          body: `Version ${info.version} is ready — click to restart and install.`,
        });
        notif.on("click", () => {
          void quitForInstall();
        });
        notif.show();
      }
    });
    autoUpdater.on("error", (err) => {
      log.error("[updater] error", err);
      broadcastUpdateStatus({ state: "error", error: err.message });
    });

    // Initial check shortly after launch, then every 6h while running.
    setTimeout(() => {
      void autoUpdater
        .checkForUpdates()
        .catch((e) => log.warn("[updater] initial check failed", e));
    }, 5000);
    setInterval(
      () => {
        void autoUpdater
          .checkForUpdates()
          .catch((e) => log.warn("[updater] periodic check failed", e));
      },
      6 * 60 * 60 * 1000,
    );
  } catch (err) {
    log.warn("[updater] electron-updater unavailable", err);
  }
}

async function bootstrap(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    // A second instance can be the ShipIt relaunch racing the single-instance
    // lock right after an auto-update swap: the new app launches, fails to grab
    // the lock, and routes here. If no window exists yet (the old window already
    // tore down during quit), focusing nothing leaves the user staring at a
    // dockless app — recreate one (mirrors the `activate` handler).
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      void createWindow();
    }
  });

  await app.whenReady();

  // FIX A (Windows auto-update lock): before ANY native module loads — the daemon
  // we spawn below, its detached pty-host, and the in-process Set-up-Cybo terminal
  // all load node-pty / better-sqlite3 — copy those .node images OUT of the install
  // dir and export CYBORG7_NATIVE_DIR so every loader resolves them from a stable
  // external dir. Nothing under $INSTDIR is then memory-mapped, so the NSIS
  // auto-update uninstall can always empty the dir regardless of who holds a
  // handle. No-op off Windows / in dev; never throws. See native-relocate.ts.
  relocateNativeModulesForWindows();

  const uiDir = getUiDistDir();
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname, search, hash } = new URL(request.url);
    const decoded = decodeURIComponent(pathname);

    if (decoded.endsWith("/index.html")) {
      const normalized = decoded.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalized}${search}${hash}`, 307);
    }

    const filePath = path.join(uiDir, decoded);
    const relative = path.relative(uiDir, filePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response("Not found", { status: 404 });
    }

    if (!relative || !path.extname(relative)) {
      return net.fetch(pathToFileURL(path.join(uiDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  registerDaemonManager();

  // FIX D (Windows only): before/while the daemon comes up, reap any STRAY detached
  // pty-host left by a prior run — one not bound to the current socket and serving
  // no live ptys — so a crash-orphaned host can't keep the unpacked node-pty
  // binaries in the install dir locked into a future auto-update (the code-2
  // failure). Fire-and-forget + internally bounded so it never delays startup; it
  // spares the ACTIVE host (the one the daemon will reconnect to) and any host with
  // live ptys. No-op off Windows. Never throws.
  void reapOrphanPtyHostsOnStart().catch((err) => {
    log.warn("[pty-host] orphan reap on start rejected (continuing)", err);
  });

  void (async () => {
    try {
      const status = await startDesktopDaemon();
      log.info("[cyborg7 daemon] auto-started", {
        status: status.status,
        pid: status.pid,
        listen: status.listen,
      });
    } catch (err) {
      log.error("[cyborg7 daemon] auto-start failed", err);
    }
  })();

  registerSetupTerminal();

  ipcMain.handle("cyborg7:window:toggleMaximize", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle("cyborg7:app:get-version", () => app.getVersion());
  // Native OS notification fired from the main process (richer + more reliable
  // than the renderer's web Notification API — mirrors the original app). On
  // click, focus the window and deep-link the renderer to the conversation.
  ipcMain.on("cyborg7:app:notify", (_e, opts: { title?: string; body?: string; url?: string }) => {
    const supported = Notification.isSupported();
    // DIAGNOSTIC: trace the OS-banner path end to end so a "ring but no banner"
    // report can be pinned to the OS layer (permission / Focus / unsigned drop).
    // Logs land in electron-log → ~/Library/Logs/Cyborg/main.log.
    log.info("[notify] IPC received", { title: opts?.title, hasBody: !!opts?.body, supported });
    if (!supported) {
      log.warn("[notify] Notification.isSupported() === false — the OS cannot show a banner");
      return;
    }
    const notif = new Notification({
      title: opts?.title || "Cyborg",
      body: opts?.body || "",
      silent: false,
    });
    notif.on("show", () => log.info("[notify] OS reported the banner was shown"));
    notif.on("failed", (_ev, error) => log.error("[notify] OS reported the banner failed", error));
    notif.on("click", () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      const url = opts?.url;
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) {
        win.webContents.send("cyborg7:event:navigate", url);
      }
    });
    notif.show();
    log.info("[notify] notif.show() called");
  });
  ipcMain.handle("cyborg7:app:set-badge", (_e, count: unknown) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    log.info("[badge] set-badge IPC", { count: n, platform: process.platform });
    // Cross-platform dock/taskbar badge.
    if (process.platform === "darwin") {
      // macOS dock icon: show n (empty string clears it).
      app.dock?.setBadge(n > 0 ? String(n) : "");
    } else if (process.platform === "win32") {
      // Windows has no numeric taskbar badge; draw a small overlay icon on the
      // taskbar button instead (cleared when n === 0).
      applyWindowsTaskbarBadge(n);
    } else {
      // Linux Unity launcher (harmless no-op elsewhere).
      app.setBadgeCount(n);
    }
  });
  // Slack-parity dock badge: an arbitrary string ("3" for a count, "•" for
  // unread channel activity, "" to clear). macOS setBadge takes any string, so
  // the renderer decides count-vs-dot and we just render it. win32/linux have no
  // text badge — fall back to the numeric overlay/count: a parseable number
  // draws the count, the "•" dot maps to a 1-count any-activity indicator.
  ipcMain.handle("cyborg7:app:set-badge-text", (_e, text: unknown) => {
    const label = typeof text === "string" ? text : "";
    log.info("[badge] set-badge-text IPC", { label, platform: process.platform });
    if (process.platform === "darwin") {
      app.dock?.setBadge(label);
      return;
    }
    // win32/linux have no text badge. Map the label to a number for the overlay
    // icon / Unity launcher: a numeric label ("3") → that count; a non-empty
    // non-number (the "•" dot) → a single dot (1); empty → clear (0).
    const parsed = Number.parseInt(label, 10);
    let count: number;
    if (Number.isFinite(parsed)) {
      count = parsed;
    } else {
      count = label ? 1 : 0;
    }
    if (process.platform === "win32") {
      applyWindowsTaskbarBadge(count);
    } else {
      app.setBadgeCount(count);
    }
  });
  // OS-aware deep link to the platform notification settings. Electron can't
  // read or flip the OS notification authorization, so the settings page sends
  // the user here to enable banners themselves. shell is the trusted main-process
  // API (unrelated to the chat-link allowlist in setWindowOpenHandler).
  ipcMain.handle("cyborg7:app:open-notification-settings", async () => {
    log.info("[notify] open-notification-settings IPC", { platform: process.platform });
    try {
      if (process.platform === "darwin") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        );
      } else if (process.platform === "win32") {
        await shell.openExternal("ms-settings:notifications");
      } else {
        // Linux has no universal notification-settings deep link across DEs.
        log.warn("[notify] no notification-settings deep link for this platform");
      }
    } catch (err) {
      log.error("[notify] open-notification-settings failed", err);
    }
  });
  ipcMain.handle("cyborg7:update:get-status", () => updateStatus);
  ipcMain.handle("cyborg7:update:check", async () => {
    if (!updaterRef) return { ok: false, error: "updater not initialized (dev mode?)" };
    try {
      broadcastUpdateStatus({ state: "checking", error: null });
      const result = await updaterRef.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastUpdateStatus({ state: "error", error: message });
      return { ok: false, error: message };
    }
  });
  ipcMain.handle("cyborg7:update:install", () => {
    if (!updaterRef) return { ok: false, error: "updater not initialized" };
    if (updateStatus.state !== "ready") return { ok: false, error: "no update ready to install" };
    void quitForInstall();
    return { ok: true };
  });

  await createWindow();

  setupAutoUpdater();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}

inheritLoginShellEnv();

bootstrap().catch((err) => {
  log.error("Bootstrap failed:", err);
  process.exit(1);
});

let quitting = false;

// Explicit "Restart & install" (button or notification). The hard precondition is
// that EVERYTHING we own (PTYs, embedded daemon) is fully dead BEFORE we call
// quitAndInstall, so the only process left to exit is Electron itself — that clean
// exit is exactly what unblocks the native relaunch.
//
// CONTRACT (verified against MacUpdater.js in electron-updater@6.8.3):
//   - macOS: quitAndInstall()'s isSilent/isForceRunAfter ARGS are DEAD — MacUpdater
//     ignores them. The swap + relaunch are 100% native Squirrel.Mac / ShipIt +
//     autoRunAppAfterInstall (default true), and they only happen AFTER this old
//     process exits cleanly. Because autoInstallOnAppQuit=true on darwin (see
//     setupAutoUpdater), the bundle is already staged, so quitAndInstall() takes the
//     SYNCHRONOUS branch and issues the native relaunch immediately — there is no
//     async staging window for a watchdog to race, so we DO NOT arm a bare
//     app.exit(0) here (that is precisely what killed the relaunch in #836). A
//     gated relaunch safety net below fires ONLY if the process is somehow still
//     alive long after the native relaunch should have taken over.
//   - win32: the args ARE honored (NSIS). isSilent=true runs the installer with /S
//     (no wizard; paired with nsis.oneClick:true), isForceRunAfter=true relaunches.
async function quitForInstall(): Promise<void> {
  if (quitting) return;
  quitting = true;
  // Kill any live setup-terminal PTYs BEFORE the installer runs. node-pty is
  // asarUnpack'd, so its native binaries + ConPTY/winpty helpers live UNPACKED
  // inside the install dir; a surviving PTY process (winpty-agent / OpenConsole
  // / the spawned shell — none of which are named Cyborg.exe, so the NSIS
  // `taskkill /IM Cyborg.exe` backstop misses them) holds a lock on the install
  // directory and makes the auto-update uninstaller fail with
  // "Failed to uninstall old application files .: 2" — the update then aborts
  // and never relaunches. The before-quit handler already does this, but
  // quitAndInstall re-enters before-quit with quitting=true so it short-circuits
  // past it; do it explicitly here. node-pty's own .kill() tears the helpers down.
  killAllSetupTerminals();
  // WINDOWS ONLY: killAllSetupTerminals() returns synchronously, but node-pty's
  // .kill() tears its winpty-agent / ConPTY / OpenConsole helpers down
  // ASYNCHRONOUSLY on Windows. Those helpers also live in the asarUnpack'd
  // node-pty dir, so if the installer's uninstall starts before they exit they
  // keep a handle on the install dir and the uninstall fails (code 2). Give that
  // async teardown a brief settle to complete before we proceed to quitAndInstall.
  // No-op off Windows (in-place-free swap; nothing to wait for).
  if (process.platform === "win32") {
    await sleepMs(SETUP_PTY_SETTLE_MS);
  }
  // HARD precondition: the detached daemon must be fully stopped BEFORE we hand
  // off to the installer. We spawn it detached + unref'd, so it does NOT die with
  // the app; if it outlived us it would hold the cloud-relay slot AND keep the
  // single-instance home busy for the relaunched app. Await to completion.
  try {
    await stopDesktopManagedDaemonIfNeeded();
  } catch (error) {
    log.error("[cyborg7 daemon] failed to stop managed daemon before install", error);
  }
  // WINDOWS ONLY: the PtyHost is spawned detached + unref'd (server-side
  // spawnHostDetached), so it is NOT in the daemon's process tree and the daemon
  // deliberately leaves it ALIVE on shutdown (terminal persistence). It loads
  // node-pty's asarUnpack'd .node and holds a file handle inside the install dir;
  // if it survives into the NSIS uninstall the uninstaller fails with code 2 and
  // the update never relaunches. Graceful shutdown frame + PID-targeted taskkill
  // fallback. No-op on macOS/Linux (swap is in-place-free there) — see
  // pty-host-shutdown.ts. Never throws; the NSIS macro is the backstop.
  const hostStop = await stopPtyHostForInstall();
  // FIX B: do NOT proceed to quitAndInstall while the detached host might still be
  // alive. stopPtyHostForInstall bounds its OWN teardown, so it can return with the
  // host still dying (confirmedGone:false). If we have a concrete pid, spend a
  // bounded extra budget re-killing + polling until it is actually gone — a live
  // host into the NSIS uninstall is exactly the code-2 failure. Hard-bounded so this
  // can never hang; if the host outlives the budget the NSIS image-name kill is the
  // final backstop. No-op when there was no host or it already exited.
  if (hostStop.hostPid !== null && !hostStop.confirmedGone) {
    await ensurePtyHostPidGone(hostStop.hostPid, PTY_HOST_GONE_CONFIRM_BUDGET_MS);
  }
  if (!updaterRef) {
    app.exit(0);
    return;
  }
  if (process.platform === "darwin") {
    log.info("[updater] quitAndInstall (macOS — native Squirrel relaunch after clean quit)");
    // Args are dead on macOS (MacUpdater ignores them); native ShipIt owns the
    // swap + relaunch after this process exits cleanly. Nothing else of ours is
    // alive (daemon + PTYs torn down above), so the only thing left to do is let
    // Electron quit and ShipIt take over. Do NOT arm a bare app.exit(0) watchdog:
    // killing the process mid-handoff is what suppressed the relaunch in #836.
    updaterRef.quitAndInstall();
    // Gated safety net ONLY: if, well past the point the native relaunch should
    // have superseded us, this process is somehow still alive (a window vetoing
    // close, a stuck quit), force a relaunch ourselves so the user is never left
    // on a dead app — app.relaunch() schedules a fresh launch, THEN exit. This is
    // a last resort, not the primary relaunch path.
    armRelaunchSafetyNet("macOS quitAndInstall");
  } else {
    log.info("[updater] quitAndInstall (win32 — silent NSIS, force relaunch)");
    // win32: args ARE honored. isSilent=true → NSIS /S (no wizard); isForceRunAfter
    // =true → relaunch after install.
    updaterRef.quitAndInstall(true, true);
    // The NSIS installer drives the swap+relaunch out-of-process and needs THIS
    // process gone; a stalled graceful quit blocks it. Force-exit after the grace
    // window (daemon + PTYs already torn down, nothing left to flush). Use the
    // LONGER install-path ceiling (FIX B): the host is already confirmed gone above,
    // so this is purely the hard upper bound on a wedged graceful quit — it must be
    // generous enough that it can never fire mid-handoff while files are swapping.
    armQuitWatchdog("quitAndInstall", INSTALL_QUIT_WATCHDOG_MS);
  }
}

// Force-exit if the process is still alive `timeoutMs` after we asked it to quit.
// timer.unref() so the watchdog itself never keeps the loop alive — if the graceful
// quit succeeds first, the process is already gone and this never fires. Defaults to
// QUIT_WATCHDOG_MS (normal quit); the Windows install path passes the longer
// INSTALL_QUIT_WATCHDOG_MS so a force-exit can never fire while the host is still
// being confirmed gone / the NSIS swap is in flight (FIX B).
function armQuitWatchdog(reason: string, timeoutMs: number = QUIT_WATCHDOG_MS): void {
  const timer = setTimeout(() => {
    log.warn(`[quit] graceful quit stalled (${reason}) — forcing exit`);
    app.exit(0);
  }, timeoutMs);
  timer.unref();
}

// macOS-only LAST-RESORT relaunch net for the install path. On macOS the native
// Squirrel/ShipIt relaunch happens AFTER a clean exit, so in the normal case this
// process is already gone long before the timer fires and it never runs. It only
// fires if something pathological keeps the process alive past
// RELAUNCH_SAFETY_NET_MS (a window vetoing close, a wedged quit) — in which case
// the native relaunch has NOT taken over, so we schedule our own relaunch and exit
// rather than leave the user on a dead/old app. Crucially this is `app.relaunch()`
// THEN `app.exit(0)`, NEVER a bare `app.exit(0)` (a bare exit here is exactly the
// #836 bug that suppressed the relaunch). timer.unref() so it can't hold the loop.
function armRelaunchSafetyNet(reason: string): void {
  const timer = setTimeout(() => {
    log.warn(
      `[quit] native relaunch did not take over (${reason}) — self-relaunching as a safety net`,
    );
    app.relaunch();
    app.exit(0);
  }, RELAUNCH_SAFETY_NET_MS);
  timer.unref();
}

app.on("before-quit", (event) => {
  // quitForInstall's quitAndInstall re-enters before-quit with quitting=true —
  // let it pass straight through so the install + relaunch completes.
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  killAllSetupTerminals();
  // The daemon is spawned detached + unref'd, so it does NOT die with the app —
  // it is only ever killed by this explicit stop. We let the stop run to
  // completion FIRST, then exit. The watchdog is a backstop for a genuinely wedged
  // quit (a window vetoing close), NOT for a slow-but-progressing daemon stop:
  // arm it only AFTER stopDaemon resolves. The old code armed it BEFORE the
  // awaited stop with QUIT_WATCHDOG_MS (4s) < the daemon-stop worst case (~5.2s:
  // SIGTERM + 50×100ms poll + forceKill + 200ms), so a merely-slow stop tripped
  // app.exit(0) mid-teardown and leaked a zombie daemon holding the relay slot.
  // stopDaemon now kills the whole process GROUP, so a normal stop is fast; a
  // stale paseo.pid self-heals on the next start.
  void stopDesktopManagedDaemonIfNeeded()
    .catch((error) => {
      log.error("[cyborg7 daemon] failed to stop managed daemon on quit", error);
    })
    // Mirror quitForInstall: on Windows the detached PtyHost locks the unpacked
    // node-pty .node in the install dir, failing the auto-update uninstall (code
    // 2). But ONLY kill it when an install is actually pending — a NORMAL quit
    // must leave the detached host ALIVE so terminals persist across quit→reopen
    // (PtyHost persistence; CLAUDE.md). The host is only in the install dir's way
    // when an update is about to swap files, which is exactly when updateStatus is
    // "ready" (set on `update-downloaded`, the same signal the install IPC gates
    // on) — or when electron-updater is configured to install the downloaded
    // update on quit (autoInstallOnAppQuit; darwin-only here, where this is a
    // no-op anyway). On Windows with no pending update this is therefore skipped,
    // restoring persistence. stopPtyHostForInstall is itself a no-op off Windows
    // and never throws.
    .then(() => {
      if (isUpdateInstallPending()) return stopPtyHostForInstall();
      log.info("[pty-host] normal quit (no update pending) — leaving detached host alive");
      return undefined;
    })
    .finally(() => {
      armQuitWatchdog("before-quit");
      app.exit(0);
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
