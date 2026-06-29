const fs = require("fs");
const path = require("path");

const EXECUTABLE_NAME = "Cyborg";
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

const RIPGREP_PLATFORM_DIR = {
  darwin: { arm64: "arm64-darwin", x64: "x64-darwin" },
  linux: { arm64: "arm64-linux", x64: "x64-linux" },
  win32: { arm64: "arm64-win32", x64: "x64-win32" },
};

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneChildrenExcept(parent, keep) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (!keep.has(entry)) {
      rmSafe(path.join(parent, entry));
    }
  }
}

function pruneOnnxRuntime(nodeModules, platform, arch) {
  const onnxBin = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6");
  if (!fs.existsSync(onnxBin)) return;

  const otherPlatforms = ["darwin", "linux", "win32"].filter((p) => p !== platform);
  for (const p of otherPlatforms) {
    rmSafe(path.join(onnxBin, p));
  }

  pruneChildrenExcept(path.join(onnxBin, platform), new Set([arch]));

  if (platform === "linux") {
    const archDir = path.join(onnxBin, "linux", arch);
    if (fs.existsSync(archDir)) {
      for (const name of fs.readdirSync(archDir)) {
        if (name.includes("cuda") || name.includes("tensorrt")) {
          fs.rmSync(path.join(archDir, name), { force: true });
        }
      }
    }
  }
}

function pruneClaudeAgentSdk(nodeModules, platform, arch) {
  const vendorRoot = path.join(nodeModules, "@anthropic-ai", "claude-agent-sdk", "vendor");
  const keepName = RIPGREP_PLATFORM_DIR[platform]?.[arch];
  if (keepName) {
    pruneChildrenExcept(path.join(vendorRoot, "ripgrep"), new Set(["COPYING", keepName]));
    pruneChildrenExcept(path.join(vendorRoot, "tree-sitter-bash"), new Set([keepName]));
  }

  const anthropicDir = path.join(nodeModules, "@anthropic-ai");
  if (fs.existsSync(anthropicDir)) {
    for (const entry of fs.readdirSync(anthropicDir)) {
      if (entry.startsWith("claude-agent-sdk-")) {
        rmSafe(path.join(anthropicDir, entry));
      }
    }
  }
}

function pruneNodePty(nodeModules, platform, arch) {
  const prebuilds = path.join(nodeModules, "node-pty", "prebuilds");
  pruneChildrenExcept(prebuilds, new Set([`${platform}-${arch}`]));

  if (platform !== "win32") {
    rmSafe(path.join(nodeModules, "node-pty", "third_party"));
  }
}

function pruneSharpLibvips(nodeModules, platform, arch) {
  const prefix = `sharp-libvips-${platform}-${arch}`;
  const imgDir = path.join(nodeModules, "@img");
  if (!fs.existsSync(imgDir)) return;

  for (const entry of fs.readdirSync(imgDir)) {
    if (
      entry.startsWith("sharp-") &&
      entry !== prefix &&
      !entry.startsWith(`sharp-${platform}-${arch}`)
    ) {
      rmSafe(path.join(imgDir, entry));
    }
  }
}

function pruneNativeModules(appOutDir, platform, arch) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  // The daemon bundle (extraResources) ships native modules for all platforms;
  // keep only the current platform/arch. See scripts/build-daemon-bundle.mjs.
  const nodeModules = path.join(
    resourcesDir,
    "daemon",
    "node_modules",
    "@getpaseo",
    "server",
    "node_modules",
  );
  if (!fs.existsSync(nodeModules)) return;

  const before = dirSizeSync(nodeModules);

  pruneOnnxRuntime(nodeModules, platform, arch);
  pruneClaudeAgentSdk(nodeModules, platform, arch);
  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);

  const after = dirSizeSync(nodeModules);
  const savedMB = ((before - after) / 1024 / 1024).toFixed(1);
  console.log(`Pruned native modules: ${savedMB} MB removed (${fmtMB(before)} → ${fmtMB(after)})`);
}

function dirSizeSync(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
      } catch {
        // intentional: skip entries that vanish or can't be stat'd mid-walk; this
        // is only an approximate size report for logging.
      }
    }
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function injectIntoAsar(appOutDir, platform) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) return;

  let asar;
  try {
    asar = require("@electron/asar");
  } catch {
    const ebPath = require.resolve("electron-builder/package.json");
    asar = require(require.resolve("@electron/asar", { paths: [path.dirname(ebPath)] }));
  }
  const tmpDir = path.join(resourcesDir, "_asar_tmp");
  asar.extractAll(asarPath, tmpDir);

  const pkgDir = path.resolve(__dirname);
  const nmDir = path.join(tmpDir, "node_modules");
  fs.mkdirSync(nmDir, { recursive: true });

  for (const mod of ["electron-log", "ws"]) {
    const dst = path.join(nmDir, mod);
    if (fs.existsSync(dst)) continue;
    const resolved = require.resolve(mod + "/package.json", { paths: [pkgDir] });
    const src = path.dirname(resolved);
    fs.cpSync(src, dst, { recursive: true });
    console.log(`Injected ${mod} into asar`);
  }

  // node-pty is NATIVE — it MUST stay UNPACKED in the repacked asar or Electron
  // won't redirect its `prebuilds/<plat>-<arch>/pty.node` read to app.asar.unpacked
  // (the exact 0.0.130–0.0.133 bug: the binary was on disk in app.asar.unpacked
  // but the asar marked node-pty "packed", so the load looked inside the asar and
  // failed). extractAll did NOT reconstruct node-pty's prebuilds (electron-builder
  // never collected them from pnpm's symlinked node_modules), so materialize the
  // REAL package (with prebuilds) into tmpDir, then repack WITH the unpack rules so
  // createPackage writes node-pty back into app.asar.unpacked AND flags it unpacked.
  let unpackGlobs = null;
  try {
    const realNodePty = fs.realpathSync(
      path.dirname(require.resolve("node-pty/package.json", { paths: [pkgDir] })),
    );
    const dst = path.join(nmDir, "node-pty");
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(realNodePty, dst, { recursive: true, dereference: true });
    // Preserve electron-builder's asarUnpack set: the daemon entrypoint + node-pty.
    unpackGlobs = {
      unpack: "{**/*.node,**/daemon-entrypoint-runner.js}",
      unpackDir: "**/node_modules/node-pty",
    };
    console.log("Staged real node-pty (with prebuilds) for unpacked repack");
  } catch (err) {
    console.warn(`⚠️  could not stage node-pty for unpacked repack: ${err.message}`);
  }

  fs.rmSync(asarPath, { force: true });
  // createPackageWithOptions(unpack…) keeps node-pty + the daemon entrypoint
  // UNPACKED. Fall back to the plain repack if the options API ever changes — the
  // app still launches either way (setup-terminal loads node-pty lazily behind a
  // guard), so this can never re-brick; worst case the embedded terminal is off.
  try {
    if (unpackGlobs && typeof asar.createPackageWithOptions === "function") {
      await asar.createPackageWithOptions(tmpDir, asarPath, unpackGlobs);
    } else {
      await asar.createPackage(tmpDir, asarPath);
    }
  } catch (err) {
    console.warn(`⚠️  unpacked repack failed (${err.message}) — falling back to plain repack`);
    fs.rmSync(asarPath, { force: true });
    await asar.createPackage(tmpDir, asarPath);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("Repacked asar with injected modules");
}

// Copy the daemon bundle into the packaged app ourselves. electron-builder's
// extraResources copier strips node_modules directories at every level, so the
// daemon's deps never make it in via config. Copying here (raw cpSync) bypasses
// that filtering entirely. Source built by scripts/build-daemon-bundle.mjs.
function copyDaemonBundle(appOutDir, platform) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const src = path.join(__dirname, "daemon-resources");
  if (!fs.existsSync(path.join(src, "node_modules", "@getpaseo", "server"))) {
    throw new Error(
      `daemon bundle not found at ${src} — run "pnpm run build:daemon-bundle" before packaging`,
    );
  }
  const dst = path.join(resourcesDir, "daemon");
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log("Copied daemon bundle into Resources/daemon");
}

// The DESKTOP app's own node-pty (embedded Set-up-Cybo terminal) is a NATIVE
// N-API module. electron-builder can't traverse pnpm's symlinked node_modules to
// collect it whole, and injectIntoAsar's repack drops the unpacked tree — so the
// packed copy was missing `prebuilds/<platform>-<arch>/pty.node` and 0.0.130
// crashed at launch with "Cannot find module pty.node". Materialize the REAL
// resolved package (following the pnpm symlink), pruned to this platform/arch,
// into app.asar.unpacked AFTER the repack so nothing orphans it. Best-effort:
// the app still launches without it (setup-terminal-pty loads node-pty lazily
// behind a guard) — so a copy failure must WARN, never abort the build.
function copyDesktopNodePty(appOutDir, platform, arch) {
  try {
    const resourcesDir =
      platform === "darwin"
        ? path.join(appOutDir, `${EXECUTABLE_NAME}.app`, "Contents", "Resources")
        : path.join(appOutDir, "resources");

    const pkgJsonPath = require.resolve("node-pty/package.json", { paths: [__dirname] });
    const realSrc = fs.realpathSync(path.dirname(pkgJsonPath));

    const nmDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
    const dst = path.join(nmDir, "node-pty");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(realSrc, dst, { recursive: true, dereference: true });
    pruneNodePty(nmDir, platform, arch); // keep only this platform's prebuild

    const prebuilt = path.join(dst, "prebuilds", `${platform}-${arch}`);
    const built = path.join(dst, "build", "Release");
    const hasNative =
      (fs.existsSync(prebuilt) && fs.readdirSync(prebuilt).some((f) => f.endsWith(".node"))) ||
      (fs.existsSync(built) && fs.readdirSync(built).some((f) => f.endsWith(".node")));
    if (hasNative) {
      console.log(
        `Copied node-pty (${platform}-${arch}) into app.asar.unpacked with native binary`,
      );
    } else {
      console.warn(
        `⚠️  node-pty has no native binary for ${platform}-${arch} — the embedded Set-up-Cybo terminal will be disabled (app still launches; users run \`cybo login\` in a terminal).`,
      );
    }
  } catch (err) {
    console.warn(
      `⚠️  copyDesktopNodePty failed (embedded terminal disabled, app unaffected): ${err.message}`,
    );
  }
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_MAP[context.arch] || process.arch;
  copyDaemonBundle(context.appOutDir, platform);
  pruneNativeModules(context.appOutDir, platform, arch);
  await injectIntoAsar(context.appOutDir, platform);
  copyDesktopNodePty(context.appOutDir, platform, arch);
};
