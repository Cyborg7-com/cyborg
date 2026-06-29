import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";
import {
  createNodeEntrypointInvocation as createSharedNodeEntrypointInvocation,
  type NodeEntrypointArgvMode,
  type NodeEntrypointInvocation,
  type NodeEntrypointSpec,
} from "./daemon-entrypoint-launcher.js";
import { assertPathExists, findPackageRootFromResolvedPath } from "./daemon-package-paths.js";

const SERVER_PACKAGE_NAME = "@getpaseo/server";

const esmRequire = createRequire(import.meta.url);

function resolveServerPackageInfo(): { root: string } | null {
  try {
    const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
    return findPackageRootFromResolvedPath({
      resolvedPath: serverExportPath,
      packageName: SERVER_PACKAGE_NAME,
    });
  } catch {
    return null;
  }
}

export function resolvePackagedNodeEntrypointRunnerPath(): string {
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "dist",
    "daemon-entrypoint-runner.js",
  );
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    // The daemon is shipped as a self-contained bundle via extraResources
    // (Contents/Resources/daemon), NOT inside the asar — it spawns child
    // processes and loads native .node modules, which must live on the real
    // filesystem. See scripts/build-daemon-bundle.mjs.
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          process.resourcesPath,
          "daemon",
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "scripts",
          "supervisor-entrypoint.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  if (!serverPackage) {
    throw new Error("Server package not available — cloud-only mode, no local daemon");
  }
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "supervisor-entrypoint.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "supervisor-entrypoint.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolveNodeExecPath(): string {
  if (app.isPackaged && process.platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = process.execPath.substring(0, markerIndex + ".app".length);
      const name = path.basename(process.execPath);
      const helperPath = path.posix.join(
        bundleRoot,
        "Contents",
        "Frameworks",
        `${name} Helper.app`,
        "Contents",
        "MacOS",
        `${name} Helper`,
      );
      if (existsSync(helperPath)) {
        return helperPath;
      }
    }
  }
  return process.execPath;
}

export function createNodeEntrypointInvocation(input: {
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}): NodeEntrypointInvocation {
  return createSharedNodeEntrypointInvocation({
    execPath: resolveNodeExecPath(),
    isPackaged: app.isPackaged,
    packagedRunnerPath: app.isPackaged
      ? assertPathExists({
          label: "Bundled node entrypoint runner",
          filePath: resolvePackagedNodeEntrypointRunnerPath(),
        })
      : null,
    entrypoint: input.entrypoint,
    argvMode: input.argvMode,
    args: input.args,
    baseEnv: input.baseEnv,
  });
}
