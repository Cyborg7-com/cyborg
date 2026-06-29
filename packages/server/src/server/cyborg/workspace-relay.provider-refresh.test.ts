// FIX 2 (internal docs #2): the relay's per-daemon `providers` view must stay
// live across a host login/logout (`claude login`) on a LONG-HELD connection.
// Before this fix `conn.providers` was set only at `daemon_hello` and the
// heartbeat handler never touched it, so readiness + mention routing stayed
// frozen at the connect-time login state until a reconnect.
//
// Real-path: a raw WS speaks the real relay protocol (hello → heartbeat) against
// a live WorkspaceRelay; the assertion reads getDaemonProviders, the same getter
// computeCyboReadiness / pickMentionDaemon consume.
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { WorkspaceRelay } from "./workspace-relay.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WorkspaceRelay — provider refresh without reconnect (internal docs #2)", () => {
  let relay: WorkspaceRelay;
  let ws: WebSocket | null = null;

  afterEach(async () => {
    ws?.close();
    ws = null;
    await relay?.close();
  });

  async function helloAndWaitSubscribed(opts: {
    port: number;
    daemonId: string;
    workspaceIds: string[];
    providers?: string[];
  }): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${opts.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    const subscribed = new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === "relay_subscribed") resolve();
      });
    });
    socket.send(
      JSON.stringify({
        type: "daemon_hello",
        daemonId: opts.daemonId,
        token: "test-token",
        workspaceIds: opts.workspaceIds,
        ...(opts.providers ? { providers: opts.providers } : {}),
      }),
    );
    await subscribed;
    return socket;
  }

  it("a heartbeat updates conn.providers WITHOUT a reconnect", async () => {
    relay = new WorkspaceRelay();
    const port = await relay.listen(0);

    ws = await helloAndWaitSubscribed({
      port,
      daemonId: "daemon-a",
      workspaceIds: ["ws-1"],
      providers: ["claude", "pi"],
    });

    // Hello set the initial view.
    expect(relay.getDaemonProviders("daemon-a")).toEqual(["claude", "pi"]);

    // The host signs OUT of claude. The daemon re-publishes its current providers
    // on the SAME socket via the heartbeat — no reconnect, no new hello.
    ws.send(
      JSON.stringify({
        type: "relay_heartbeat",
        daemonId: "daemon-a",
        status: "online",
        providers: ["pi"],
      }),
    );
    await wait(100);

    expect(relay.getDaemonProviders("daemon-a")).toEqual(["pi"]);

    // The host signs back IN — propagates again on the next heartbeat.
    ws.send(
      JSON.stringify({
        type: "relay_heartbeat",
        daemonId: "daemon-a",
        status: "online",
        providers: ["claude", "pi"],
      }),
    );
    await wait(100);

    expect(relay.getDaemonProviders("daemon-a")).toEqual(["claude", "pi"]);
  });

  it("a heartbeat WITHOUT providers (older daemon) keeps the last hello value", async () => {
    relay = new WorkspaceRelay();
    const port = await relay.listen(0);

    ws = await helloAndWaitSubscribed({
      port,
      daemonId: "daemon-old",
      workspaceIds: ["ws-1"],
      providers: ["claude"],
    });

    expect(relay.getDaemonProviders("daemon-old")).toEqual(["claude"]);

    // Back-compat: an older daemon omits `providers` from its heartbeat. The relay
    // must NOT clobber the known-good hello value with undefined.
    ws.send(JSON.stringify({ type: "relay_heartbeat", daemonId: "daemon-old", status: "online" }));
    await wait(100);

    expect(relay.getDaemonProviders("daemon-old")).toEqual(["claude"]);
  });
});
