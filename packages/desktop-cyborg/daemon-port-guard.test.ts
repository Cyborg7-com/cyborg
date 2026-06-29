import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureDaemonPortFree,
  type FreePortResult,
  isOurDaemonCommand,
  parseListenPort,
  type PortGuardDeps,
  type PortOwner,
} from "./daemon-port-guard.js";

const OUR_SUPERVISOR =
  "/Applications/Cyborg.app/Contents/Resources/daemon/.../node supervisor-entrypoint.js";
const OUR_WORKER = "node /opt/cyborg/node_modules/@getpaseo/server/dist/server/daemon-worker.js";
const FOREIGN = "/usr/bin/python3 -m http.server 6767";

// Build PortGuardDeps that replays a fixed queue of port-owner lookup results
// (the last entry repeats once exhausted) and records every SIGKILLed pid.
function makeDeps(owners: (PortOwner | null)[]): { deps: PortGuardDeps; killed: number[] } {
  const killed: number[] = [];
  let lookupIndex = 0;
  const deps: PortGuardDeps = {
    lookupPortOwner: async () => {
      const value = lookupIndex < owners.length ? owners[lookupIndex] : owners[owners.length - 1];
      lookupIndex++;
      return value;
    },
    killPid: async (pid: number) => {
      killed.push(pid);
    },
    sleep: async () => {},
    log: () => {},
  };
  return { deps, killed };
}

test("parseListenPort: host:port forms", () => {
  assert.equal(parseListenPort("127.0.0.1:6767"), 6767);
  assert.equal(parseListenPort("127.0.0.1:6780"), 6780);
  assert.equal(parseListenPort("0.0.0.0:9999"), 9999);
});

test("parseListenPort: ipv6 takes the last colon-segment", () => {
  assert.equal(parseListenPort("[::1]:6767"), 6767);
});

test("parseListenPort: unix sockets have no TCP port", () => {
  assert.equal(parseListenPort("/tmp/paseo.sock"), null);
  assert.equal(parseListenPort("unix:///tmp/paseo.sock"), null);
});

test("parseListenPort: empty / garbage → null", () => {
  assert.equal(parseListenPort(""), null);
  assert.equal(parseListenPort(undefined), null);
  assert.equal(parseListenPort(null), null);
  assert.equal(parseListenPort("127.0.0.1:notaport"), null);
  assert.equal(parseListenPort("127.0.0.1:70000"), null);
});

test("isOurDaemonCommand: matches our entrypoints", () => {
  assert.equal(isOurDaemonCommand(OUR_SUPERVISOR), true);
  assert.equal(isOurDaemonCommand(OUR_WORKER), true);
  assert.equal(isOurDaemonCommand("node daemon-entrypoint-runner.js"), true);
});

test("isOurDaemonCommand: does NOT match unrelated apps", () => {
  assert.equal(isOurDaemonCommand(FOREIGN), false);
  assert.equal(isOurDaemonCommand("/usr/sbin/nginx"), false);
  assert.equal(isOurDaemonCommand(""), false);
});

test("port already free → no kill", async () => {
  const { deps, killed } = makeDeps([null]);
  const result: FreePortResult = await ensureDaemonPortFree(6767, deps);
  assert.deepEqual(result, { status: "free" });
  assert.deepEqual(killed, []);
});

test("OUR orphan squatting → SIGKILL then freed", async () => {
  // first lookup: orphan present; after kill: free
  const { deps, killed } = makeDeps([{ pid: 67936, command: OUR_SUPERVISOR }, null]);
  const result = await ensureDaemonPortFree(6767, deps);
  assert.deepEqual(result, { status: "freed", killedPid: 67936 });
  assert.deepEqual(killed, [67936]);
});

test("FOREIGN process squatting → never killed, reported", async () => {
  const { deps, killed } = makeDeps([{ pid: 4242, command: FOREIGN }]);
  const result = await ensureDaemonPortFree(6767, deps);
  assert.deepEqual(result, { status: "skipped-foreign", pid: 4242, command: FOREIGN });
  assert.deepEqual(killed, []);
});

test("orphan re-grabbed by another OUR daemon → keep killing until free", async () => {
  const { deps, killed } = makeDeps([
    { pid: 100, command: OUR_SUPERVISOR }, // initial
    { pid: 200, command: OUR_WORKER }, // respawned by crash-loop
    null, // freed
  ]);
  const result = await ensureDaemonPortFree(6767, deps);
  assert.deepEqual(result, { status: "freed", killedPid: 100 });
  assert.deepEqual(killed, [100, 200]);
});

test("port can never be freed → stuck (bounded, no infinite loop)", async () => {
  // lookup always returns the SAME orphan; kill never takes effect.
  const owner: PortOwner = { pid: 999, command: OUR_SUPERVISOR };
  let killCount = 0;
  const deps: PortGuardDeps = {
    lookupPortOwner: async () => owner,
    killPid: async () => {
      killCount++;
    },
    sleep: async () => {},
    log: () => {},
  };
  const result = await ensureDaemonPortFree(6767, deps);
  assert.equal(result.status, "stuck");
  if (result.status === "stuck") {
    assert.equal(result.pid, 999);
  }
  // Only the original pid is killed repeatedly is NOT desired; same-pid is killed
  // once up front, and the loop only re-kills DIFFERENT pids. So exactly 1 kill.
  assert.equal(killCount, 1);
});
