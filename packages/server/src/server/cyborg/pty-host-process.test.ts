// PtyHost — the load-bearing "live session survives daemon restart" proof
// (internal docs modeled on the real-pty test in PR #773).
//
// We spawn a REAL host (real node-pty via Paseo's createTerminal), create a
// terminal, write `echo hi`, then CLOSE the control socket (simulating the daemon
// dying). A NEW client reconnects: listTerminals() still shows the pty, attach
// replays the `hi` from the ring, and the pty is STILL INTERACTIVE (`pwd`
// returns). That is the survival property the worker structurally cannot give.
import { describe, it, expect, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPtyHost, type PtyHostHandle } from "./pty-host-process.js";
import {
  FrameDecoder,
  encodeFrame,
  isPtyHostResponse,
  type PtyHostRequest,
  type PtyHostTerminalInfo,
  type PtyHostToClientMessage,
} from "./pty-host-protocol.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

// A minimal raw client over the host socket: tracks responses by requestId and
// accumulates every output frame so the test can assert replay/interactivity.
class RawClient {
  readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, (result: unknown) => void>();
  output = "";
  private seq = 0;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const frame of this.decoder.feed(chunk)) {
        const message = frame as PtyHostToClientMessage;
        if (isPtyHostResponse(message)) {
          this.pending.get(message.requestId)?.(message.ok ? message.result : undefined);
          this.pending.delete(message.requestId);
          continue;
        }
        if (message.type === "terminalMessage" && message.message.type === "output") {
          this.output += message.message.data;
        }
      }
    });
  }

  request(input: Omit<PtyHostRequest, "requestId">): Promise<unknown> {
    const requestId = `req-${this.seq++}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.socket.write(encodeFrame({ ...input, requestId } as PtyHostRequest));
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

function connectClient(socketPath: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(new RawClient(socket)));
    socket.once("error", reject);
  });
}

describe("pty-host process — live session survives a daemon restart", () => {
  const dirs: string[] = [];
  const hosts: PtyHostHandle[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "keeps the pty alive across a control-socket drop and re-attaches",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-host-"));
      dirs.push(baseDir);
      const socketPath = join(baseDir, "pty-host.sock");

      const host = await startPtyHost({ baseDir, socketPath });
      hosts.push(host);

      // ── client A: create a terminal, write `echo hi`, see it echo back ──
      const clientA = await connectClient(socketPath);
      const created = (await clientA.request({
        type: "createTerminal",
        options: { cwd: baseDir },
      })) as PtyHostTerminalInfo;
      expect(created.id).toBeTruthy();

      await clientA.request({
        type: "input",
        terminalId: created.id,
        message: { type: "input", data: "echo hi\r" },
      });
      await waitFor("client A sees 'hi'", () => clientA.output.includes("hi"));

      // ── simulate the daemon dying: drop the control socket entirely ──
      clientA.close();
      await waitFor("host registers the client drop", () => host.clientCount() === 0);
      // The pty MUST still be alive in the host — the survival invariant.
      expect(host.terminalCount()).toBe(1);

      // ── client B (the "restarted daemon"): reconnect, list, re-attach ──
      const clientB = await connectClient(socketPath);
      const list = (await clientB.request({ type: "listTerminals" })) as PtyHostTerminalInfo[];
      expect(list.map((t) => t.id)).toContain(created.id);

      // attach replays the ring → client B sees the `hi` that scrolled while the
      // "daemon" was down.
      await clientB.request({ type: "attach", terminalId: created.id });
      await waitFor("client B replays 'hi'", () => clientB.output.includes("hi"));

      // the pty is STILL INTERACTIVE: a fresh command runs and returns.
      const marker = `MARKER_${Date.now()}`;
      await clientB.request({
        type: "input",
        terminalId: created.id,
        message: { type: "input", data: `echo ${marker}\r` },
      });
      await waitFor("client B sees fresh marker", () => clientB.output.includes(marker));

      clientB.close();
    },
    20000,
  );

  it.skipIf(process.platform === "win32")(
    "reports its wire version on hello",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-host-"));
      dirs.push(baseDir);
      const socketPath = join(baseDir, "pty-host.sock");
      const host = await startPtyHost({ baseDir, socketPath });
      hosts.push(host);

      const client = await connectClient(socketPath);
      const hello = (await client.request({ type: "hello" })) as {
        wireVersion: number;
        pid: number;
      };
      expect(hello.wireVersion).toBe(1);
      expect(hello.pid).toBeGreaterThan(0);
      client.close();
    },
    20000,
  );

  // #860 latent fix: the launcher passes CYBORG7_PTY_HOST_SOCKET to the spawned
  // host; the host MUST read it (when no explicit socketPath is given) so launcher
  // and host bind the SAME socket instead of relying on a shared PASEO_HOME.
  it.skipIf(process.platform === "win32")(
    "honors CYBORG7_PTY_HOST_SOCKET when no explicit socketPath is given",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-host-env-"));
      dirs.push(baseDir);
      // A socket path that is NOT the PASEO_HOME-derived default — only an env-aware
      // host will bind here. (PASEO_HOME-derived would be <baseDir>/pty-host.sock.)
      const socketPath = join(baseDir, "from-env.sock");

      const prevHome = process.env.PASEO_HOME;
      const prevSock = process.env.CYBORG7_PTY_HOST_SOCKET;
      process.env.PASEO_HOME = baseDir;
      process.env.CYBORG7_PTY_HOST_SOCKET = socketPath;
      try {
        // No socketPath, no baseDir option → host must derive from the env.
        const host = await startPtyHost({});
        hosts.push(host);
        expect(host.socketPath).toBe(socketPath);

        // And it is actually listening there: a client connects + says hello.
        const client = await connectClient(socketPath);
        const hello = (await client.request({ type: "hello" })) as { wireVersion: number };
        expect(hello.wireVersion).toBe(1);
        client.close();
      } finally {
        if (prevHome === undefined) delete process.env.PASEO_HOME;
        else process.env.PASEO_HOME = prevHome;
        if (prevSock === undefined) delete process.env.CYBORG7_PTY_HOST_SOCKET;
        else process.env.CYBORG7_PTY_HOST_SOCKET = prevSock;
      }
    },
    20000,
  );
});
