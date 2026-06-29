/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { WorkspaceRelay } from "./workspace-relay.js";

// A minimal stand-in for a daemon control socket — enough surface for the relay's
// keepalive + send paths (ws.readyState/send/ping/terminate/close + the
// message/close/error events handleConnection wires).
class FakeDaemonWs extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  pings = 0;
  terminated = false;
  throwOnSend = false;
  send(data: string): void {
    if (this.throwOnSend) throw new Error("WebSocket is not open");
    this.sent.push(data);
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
  }
  closedCode: number | null = null;
  close(code?: number): void {
    this.closedCode = code ?? null;
    this.readyState = 3; // CLOSED
  }
}

// Register a fake daemon by driving the real auth handshake (daemon_hello).
function connectFakeDaemon(
  relay: WorkspaceRelay,
  daemonId: string,
  workspaceIds: string[],
): FakeDaemonWs {
  const ws = new FakeDaemonWs();
  (relay as any).handleConnection(ws, {});
  ws.emit("message", JSON.stringify({ type: "daemon_hello", daemonId, token: "t", workspaceIds }));
  return ws;
}

describe("WorkspaceRelay daemon keepalive + delivery (#692)", () => {
  it("pings every OPEN daemon control connection (keepalive)", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    const b = connectFakeDaemon(relay, "daemon-b", ["w2"]);

    (relay as any).pingDaemons();
    expect(a.pings).toBe(1);
    expect(b.pings).toBe(1);
  });

  it("does NOT terminate a daemon on the keepalive path (no kill-on-missed-pong, #277)", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    // Many keepalive cycles with no pong ever simulated — must never terminate;
    // death is owned by the staleness sweep, not the ping.
    for (let i = 0; i < 10; i++) (relay as any).pingDaemons();
    expect(a.terminated).toBe(false);
    expect(a.pings).toBe(10);
  });

  it("skips a non-OPEN socket when pinging", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    a.readyState = 2; // CLOSING
    (relay as any).pingDaemons();
    expect(a.pings).toBe(0);
  });

  it("sendToDaemonInWorkspace returns true on a real delivery", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    a.sent.length = 0; // drop the relay_connected handshake ack
    expect(relay.sendToDaemonInWorkspace("w1", { type: "cyborg:relay_rpc" }, "daemon-a")).toBe(
      true,
    );
    expect(a.sent.length).toBe(1);
    expect(a.sent[0]).toContain("cyborg:relay_rpc");
  });

  it("sendToDaemonInWorkspace returns FALSE when the send fails (no blind success, #692)", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    a.throwOnSend = true; // OPEN per readyState, but the write throws (closing race)
    expect(relay.sendToDaemonInWorkspace("w1", { type: "cyborg:relay_rpc" }, "daemon-a")).toBe(
      false,
    );
  });

  it("a reconnect evicts the prior (zombie) connection — forwards reach the LIVE socket (#694)", () => {
    const relay = new WorkspaceRelay();
    // First connection, then a reconnect for the SAME daemon whose old socket was
    // never closed (a zombie). Pre-fix, both stayed registered and a forward hit
    // the zombie first (insertion order) → delivered into the void.
    const zombie = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    const live = connectFakeDaemon(relay, "daemon-a", ["w1"]);

    // The zombie is evicted on the new hello: exactly one connection remains, and
    // the stale socket was asked to close (1012 = superseded).
    expect(relay.getConnectedDaemons().filter((d) => d === "daemon-a")).toHaveLength(1);
    expect(zombie.closedCode).toBe(1012);

    // A targeted forward now lands on the LIVE socket — never the zombie.
    zombie.sent.length = 0;
    live.sent.length = 0;
    const rpc = { type: "cyborg:relay_rpc", inner: { type: "cyborg:invoke_cybo_mention" } };
    expect(relay.sendToDaemonInWorkspace("w1", rpc, "daemon-a")).toBe(true);
    expect(live.sent.some((s) => s.includes("invoke_cybo_mention"))).toBe(true);
    expect(zombie.sent.length).toBe(0);
  });

  it("eviction is scoped to the SAME daemon id — other daemons are untouched (#694)", () => {
    const relay = new WorkspaceRelay();
    const other = connectFakeDaemon(relay, "daemon-b", ["w1"]);
    connectFakeDaemon(relay, "daemon-a", ["w1"]);
    connectFakeDaemon(relay, "daemon-a", ["w1"]); // reconnect daemon-a
    // daemon-b must survive (different id) and still receive its forwards.
    expect(other.closedCode).toBeNull();
    expect(relay.getConnectedDaemons().filter((d) => d === "daemon-b")).toHaveLength(1);
    other.sent.length = 0;
    expect(relay.sendToDaemonInWorkspace("w1", { type: "cyborg:relay_rpc" }, "daemon-b")).toBe(
      true,
    );
    expect(other.sent.length).toBe(1);
  });

  it("falls back to another subscribed daemon when the first send fails (#692)", () => {
    const relay = new WorkspaceRelay();
    const a = connectFakeDaemon(relay, "daemon-a", ["w1"]);
    const b = connectFakeDaemon(relay, "daemon-b", ["w1"]);
    a.throwOnSend = true; // first subscriber is in a CLOSING race
    // No explicit target → walks the workspace subscribers; must skip the broken
    // one and deliver to the healthy daemon instead of reporting failure.
    expect(relay.sendToDaemonInWorkspace("w1", { type: "cyborg:relay_rpc" })).toBe(true);
    expect(b.sent.some((s) => s.includes("cyborg:relay_rpc"))).toBe(true);
  });

  it("clears the keepalive timer on close()", async () => {
    const relay = new WorkspaceRelay();
    connectFakeDaemon(relay, "daemon-a", ["w1"]);
    (relay as any).startPresenceSweep(); // also arms the keepalive timer
    expect((relay as any).keepaliveTimer).not.toBeNull();
    await relay.close();
    expect((relay as any).keepaliveTimer).toBeNull();
  });
});
