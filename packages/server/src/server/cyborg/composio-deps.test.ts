// The env gate for the Composio dependency. createComposioDeps is the single
// place COMPOSIO_API_KEY → wired deps happens; if it returns undefined the whole
// feature is dark (spawnCybo's injectComposioMcpServers is a strict no-op). These
// tests pin that gate so a daemon without the key stays byte-identical.

import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryComposioConnectionStore } from "./composio-connection-store.js";
import { createComposioDeps } from "./composio-deps.js";
import { buildComposioRouterMcpServer } from "./composio-mcp.js";
import { HttpComposioClient } from "./composio.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgStorage } from "./storage.js";

describe("createComposioDeps (COMPOSIO_API_KEY / COMPOSIO_CONSUMER_KEY gate)", () => {
  let storage: DualStorage;
  let tmpDir: string;
  let dbPath: string;
  const prevKey = process.env.COMPOSIO_API_KEY;
  const prevConsumer = process.env.COMPOSIO_CONSUMER_KEY;
  const prevRouter = process.env.COMPOSIO_ROUTER_URL;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-composio-deps-"));
    dbPath = path.join(tmpDir, "test.db");
    // Solo mode (pg = null): exercises the in-memory store branch deterministically.
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    // Isolate both transports so leaked env doesn't arm a branch under test.
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_CONSUMER_KEY;
    delete process.env.COMPOSIO_ROUTER_URL;
  });

  afterEach(() => {
    storage.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    }
    restore("COMPOSIO_API_KEY", prevKey);
    restore("COMPOSIO_CONSUMER_KEY", prevConsumer);
    restore("COMPOSIO_ROUTER_URL", prevRouter);
  });

  function restore(name: string, prev: string | undefined) {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }

  it("returns undefined when NEITHER key is set (feature dark)", () => {
    expect(createComposioDeps(storage)).toBeUndefined();
  });

  it("returns undefined for empty keys (an empty string must not arm the feature)", () => {
    process.env.COMPOSIO_API_KEY = "";
    process.env.COMPOSIO_CONSUMER_KEY = "";
    expect(createComposioDeps(storage)).toBeUndefined();
  });

  it("transport A: builds an HttpComposioClient + a store from COMPOSIO_API_KEY (solo → in-memory)", () => {
    process.env.COMPOSIO_API_KEY = "platform_test_key";
    const deps = createComposioDeps(storage);
    expect(deps).toBeDefined();
    expect(deps?.client).toBeInstanceOf(HttpComposioClient);
    expect(deps?.connections).toBeInstanceOf(InMemoryComposioConnectionStore);
    // No consumer key ⇒ no transport-B router on the deps.
    expect(deps?.router).toBeUndefined();
  });

  it("transport B: builds ONLY a router config from COMPOSIO_CONSUMER_KEY (no client/store)", () => {
    process.env.COMPOSIO_CONSUMER_KEY = "ck_test_consumer";
    const deps = createComposioDeps(storage);
    expect(deps).toBeDefined();
    expect(deps?.router).toEqual({ consumerKey: "ck_test_consumer", routerUrl: undefined });
    // The consumer router needs no daemon client / connection store.
    expect(deps?.client).toBeUndefined();
    expect(deps?.connections).toBeUndefined();
  });

  it("transport B: honors a custom COMPOSIO_ROUTER_URL", () => {
    process.env.COMPOSIO_CONSUMER_KEY = "ck_test_consumer";
    process.env.COMPOSIO_ROUTER_URL = "https://router.example/mcp";
    expect(createComposioDeps(storage)?.router?.routerUrl).toBe("https://router.example/mcp");
  });

  it("both transports can be wired at once", () => {
    process.env.COMPOSIO_API_KEY = "platform_test_key";
    process.env.COMPOSIO_CONSUMER_KEY = "ck_test_consumer";
    const deps = createComposioDeps(storage);
    expect(deps?.client).toBeInstanceOf(HttpComposioClient);
    expect(deps?.router?.consumerKey).toBe("ck_test_consumer");
  });
});

describe("buildComposioRouterMcpServer (transport B injection)", () => {
  it("injects a single http MCP server with the consumer-key header", () => {
    const servers = buildComposioRouterMcpServer({ consumerKey: "ck_abc" });
    expect(servers).toEqual({
      "composio:router": {
        type: "http",
        url: "https://connect.composio.dev/mcp",
        headers: { "x-consumer-api-key": "ck_abc" },
      },
    });
  });

  it("uses a custom router URL when provided", () => {
    const servers = buildComposioRouterMcpServer({
      consumerKey: "ck_abc",
      routerUrl: "https://router.example/mcp",
    });
    expect(servers["composio:router"].url).toBe("https://router.example/mcp");
  });
});
