/* eslint-disable @typescript-eslint/no-explicit-any */
// REAL end-to-end coverage for the Update button cycle (cyborg:cybo_cli_update).
// No mocks of the update machinery: these tests run the REAL `npm i -g
// @cyborg7/cybo@latest` on this machine (idempotent when already at latest) and
// the REAL `cybo --version` detection. They live behind the *.local.e2e.test.ts
// suffix (pnpm test:integration:local) because they mutate the host's global npm
// prefix and need npm + network.
//
// Covers Rodrigo's worst case (#357 follow-up): with multiple node prefixes
// (proto + homebrew), `npm i -g` installs into the running npm's prefix while
// detection probes whatever `cybo` the PATH resolves first — the install
// "succeeds" but the version never changes, so the UI loops on "update
// available" forever. Simulated here with a stale stub prefix prepended to PATH.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher, updateCyboCli } from "./dispatcher.js";

const posixOnly = process.platform !== "win32";

function findByType(emitted: unknown[], type: string): any {
  return emitted.find((m: any) => m.type === type);
}

function npmViewLatest(): string {
  return execFileSync("npm", ["view", "@cyborg7/cybo@latest", "version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

describe.runIf(posixOnly)("cybo CLI update — REAL e2e on this host", () => {
  describe("multi-prefix repro: stale cybo earlier on PATH than the npm prefix", () => {
    let stubDir: string;
    let savedPath: string | undefined;

    beforeEach(() => {
      // A simulated second prefix holding a STALE cybo 0.2.4 (Rodrigo's homebrew
      // copy / any pre-proto leftover). It deliberately has NO npm next to it, so
      // the update runs the PATH npm — whose global prefix is a different dir.
      stubDir = mkdtempSync(path.join(tmpdir(), "cybo-stale-prefix-"));
      writeFileSync(path.join(stubDir, "cybo"), "#!/bin/sh\necho 0.2.4\n");
      chmodSync(path.join(stubDir, "cybo"), 0o755);
      savedPath = process.env.PATH;
      process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
    });

    afterEach(() => {
      process.env.PATH = savedPath;
      rmSync(stubDir, { recursive: true, force: true });
    });

    it(
      "REAL npm install succeeds but PATH resolves the stale copy → clear mismatch error (no silent loop)",
      { timeout: 300_000 },
      async () => {
        const latest = npmViewLatest();
        const logs: string[] = [];

        // No injection: real `which -a`, real npm install, real --version probes.
        const result = await updateCyboCli({ log: (m) => logs.push(m) });

        // The PRE-FIX behavior was ok:true + version 0.2.4 (silent stale success);
        // now the cycle reports the prefix conflict with both locations.
        expect(result.ok).toBe(false);
        expect(result.installed).toBe(true);
        expect(result.version).toBe("0.2.4"); // what the PATH (stub) answers
        expect(result.error).toContain(`Installed ${latest} at `);
        expect(result.error).toContain(`${stubDir}/cybo`);
        expect(result.error).toContain("(0.2.4)");
        expect(result.error).toMatch(/Fix your PATH order or remove the old copy/);
        expect(logs.join("\n")).toContain("prefix mismatch");
      },
    );
  });

  describe("full RPC cycle against a real dispatcher (daemon code path)", () => {
    let storage: DualStorage;
    let auth: CyborgAuth;
    let dispatcher: CyborgDispatcher;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-cli-update-"));
      storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
      auth = new CyborgAuth(storage);
      const workspaceManager = new WorkspaceManager(storage);
      const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
      const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
      dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    });

    afterEach(() => {
      storage.close();
      const dbPath = path.join(tmpDir, "test.db");
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(f)) unlinkSync(f);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    async function dispatch(msg: Record<string, unknown>, authCtx: unknown) {
      const emitted: unknown[] = [];
      await dispatcher.dispatch(msg as any, authCtx as any, (m) => emitted.push(m));
      return emitted;
    }

    it(
      "cyborg:cybo_cli_update runs the real install + detection and acks the real version",
      { timeout: 300_000 },
      async () => {
        const latest = npmViewLatest();
        const owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
        const wsResp = await dispatch(
          { type: "cyborg:create_workspace", name: "CLI Update E2E", requestId: "ws" },
          owner,
        );
        const workspaceId = (wsResp[0] as any).payload.workspace.id;

        const emitted = await dispatch(
          { type: "cyborg:cybo_cli_update", requestId: "upd", workspaceId },
          owner,
        );

        const resp = findByType(emitted, "cyborg:cybo_cli_update_response");
        expect(resp).toBeTruthy();
        expect(resp.payload.requestId).toBe("upd");
        // On a single-prefix host (this machine) the cycle completes cleanly and
        // the detected version IS the latest npm just installed — the exact loop
        // Rodrigo never exits is `ok:true` with a version ≠ latest, asserted
        // impossible here.
        expect(resp.payload.ok).toBe(true);
        expect(resp.payload.installed).toBe(true);
        expect(resp.payload.version).toBe(latest);
        expect(resp.payload.error ?? null).toBeNull();
      },
    );

    it("rejects the update RPC without create_agent permission (viewer)", async () => {
      const owner = auth.validateToken(auth.createToken("owner2@test.com", "Owner"))!;
      const wsResp = await dispatch(
        { type: "cyborg:create_workspace", name: "CLI Update Perms", requestId: "ws" },
        owner,
      );
      const workspaceId = (wsResp[0] as any).payload.workspace.id;
      await dispatch(
        {
          type: "cyborg:invite_member",
          workspaceId,
          email: "viewer@test.com",
          role: "viewer",
          requestId: "inv",
        },
        owner,
      );
      const viewer = auth.validateToken(auth.createToken("viewer@test.com", "Viewer"))!;

      const emitted = await dispatch(
        { type: "cyborg:cybo_cli_update", requestId: "upd2", workspaceId },
        viewer,
      );
      const err = findByType(emitted, "cyborg:error");
      expect(err).toBeTruthy();
      expect(err.payload.code).toBe("forbidden");
    });
  });
});
