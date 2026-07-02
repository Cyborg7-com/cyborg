import { describe, it, expect } from "vitest";
import {
  JiraAdapter,
  JIRA_PROVIDER,
  JIRA_WEBHOOK_SECRET_HEADER,
  jiraAdapter,
  type FetchLike,
} from "./jira-adapter.js";

// The Jira adapter's HTTP methods over an INJECTED fetch (no network): verifyWebhook's
// shared-secret check, parseInbound delegating to the pure mapper, listStatuses category
// mapping, importItems pagination + 429 resume, and the wave-2 writeItem / writeStatus REST
// calls. Every provider response is a canned global Response.

const CLOUD_ID = "11111111-2222-3333-4444-555555555555";
const EPID = `${CLOUD_ID}:ENG`;
const TOKEN = "access-token-abc";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// A fake fetch that records every call and returns responses from a queue keyed by a
// matcher (method + url substring). Falls through to a 500 for an unmatched call.
function makeFetch(
  routes: { match: (url: string, method: string) => boolean; respond: () => Response }[],
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = normalizeHeaders(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, headers, body });
    const route = routes.find((r) => r.match(url, method));
    if (!route) return Promise.resolve(new Response("no route", { status: 500 }));
    return Promise.resolve(route.respond());
  };
  return { fetchImpl, calls };
}

function normalizeHeaders(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("jiraAdapter.provider", () => {
  it("is the 'jira' discriminator", () => {
    expect(jiraAdapter.provider).toBe(JIRA_PROVIDER);
    expect(JIRA_PROVIDER).toBe("jira");
  });
});

describe("JiraAdapter.verifyWebhook", () => {
  const adapter = new JiraAdapter();
  const SECRET = "shared-webhook-secret-value";

  it("accepts a request whose secret header matches the configured secret", () => {
    const headers = { [JIRA_WEBHOOK_SECRET_HEADER]: SECRET };
    expect(adapter.verifyWebhook("{}", headers, SECRET)).toBe(true);
  });

  it("rejects a wrong presented secret", () => {
    const headers = { [JIRA_WEBHOOK_SECRET_HEADER]: "wrong-secret-value-here" };
    expect(adapter.verifyWebhook("{}", headers, SECRET)).toBe(false);
  });

  it("rejects a missing secret header and an empty configured secret", () => {
    expect(adapter.verifyWebhook("{}", {}, SECRET)).toBe(false);
    expect(adapter.verifyWebhook("{}", { [JIRA_WEBHOOK_SECRET_HEADER]: SECRET }, "")).toBe(false);
  });

  it("rejects a length-mismatched secret without throwing", () => {
    expect(adapter.verifyWebhook("{}", { [JIRA_WEBHOOK_SECRET_HEADER]: "short" }, SECRET)).toBe(
      false,
    );
  });
});

describe("JiraAdapter.parseInbound", () => {
  const adapter = new JiraAdapter();

  it("delegates to the mapper for a recognized webhook event", () => {
    const events = adapter.parseInbound({
      webhookEvent: "jira:issue_created",
      cloudId: CLOUD_ID,
      issue: { id: "1", key: "ENG-1", fields: { summary: "x", project: { key: "ENG" } } },
    });
    expect(events).toHaveLength(1);
    expect(events[0].externalProjectId).toBe(`${CLOUD_ID}:ENG`);
  });

  it("returns [] for irrelevant or garbage payloads (never throws)", () => {
    expect(adapter.parseInbound({ webhookEvent: "jira:worklog_updated" })).toEqual([]);
    expect(adapter.parseInbound(undefined)).toEqual([]);
    expect(adapter.parseInbound(42)).toEqual([]);
  });
});

describe("JiraAdapter.listStatuses", () => {
  it("flattens statuses grouped by issue type, de-dupes, and maps categories", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/project/ENG/statuses"),
        respond: () =>
          json([
            {
              id: "10001",
              name: "Bug",
              statuses: [
                { id: "1", name: "To Do", statusCategory: { key: "new" } },
                { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
              ],
            },
            {
              id: "10002",
              name: "Task",
              statuses: [
                { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } }, // dup id
                { id: "6", name: "Won't Do", statusCategory: { key: "done" } },
              ],
            },
          ]),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const statuses = await adapter.listStatuses(TOKEN, EPID);

    expect(statuses).toEqual([
      { id: "1", name: "To Do", category: "unstarted" },
      { id: "3", name: "In Progress", category: "started" },
      { id: "6", name: "Won't Do", category: "cancelled" }, // done-category, cancelled by name
    ]);
    expect(calls[0].url).toContain(`/ex/jira/${CLOUD_ID}/rest/api/3/project/ENG/statuses`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws on a provider error", async () => {
    const { fetchImpl } = makeFetch([
      { match: () => true, respond: () => new Response("nope", { status: 403 }) },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await expect(adapter.listStatuses(TOKEN, EPID)).rejects.toThrow(/listStatuses failed: 403/);
  });

  it("throws on a malformed externalProjectId", async () => {
    const adapter = new JiraAdapter({ fetchImpl: () => Promise.resolve(json([])) });
    await expect(adapter.listStatuses(TOKEN, "no-colon")).rejects.toThrow(/must be/);
  });
});

describe("JiraAdapter.importItems", () => {
  function issue(key: string) {
    return {
      id: key.replace("ENG-", "10"),
      key,
      self: `https://acme.atlassian.net/rest/api/3/issue/${key}`,
      fields: {
        summary: `Issue ${key}`,
        status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
        project: { key: "ENG" },
      },
    };
  }

  it("returns a first page + a resume cursor, and passes the token on the next page", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) =>
          m === "GET" && url.includes("/search/jql") && !url.includes("nextPageToken"),
        respond: () =>
          json({ issues: [issue("ENG-1"), issue("ENG-2")], nextPageToken: "TOKEN_P2" }),
      },
      {
        match: (url, m) => m === "GET" && url.includes("nextPageToken=TOKEN_P2"),
        respond: () => json({ issues: [issue("ENG-3")], isLast: true }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });

    const page1 = await adapter.importItems(TOKEN, EPID);
    expect(page1.items.map((i) => i.itemNumber)).toEqual(["ENG-1", "ENG-2"]);
    expect(page1.nextCursor).toBeDefined();
    expect(calls[0].url).toContain("ORDER+BY+created+ASC"); // URLSearchParams form-encodes spaces as "+"

    const page2 = await adapter.importItems(TOKEN, EPID, page1.nextCursor);
    expect(page2.items.map((i) => i.itemNumber)).toEqual(["ENG-3"]);
    expect(page2.nextCursor).toBeUndefined(); // isLast -> done
  });

  it("on a 429 returns an empty page + a cursor that resumes the same page", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/search/jql"),
        respond: () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const page = await adapter.importItems(TOKEN, EPID);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeDefined(); // resumable even on the first page
  });

  it("throws on a non-429 provider error", async () => {
    const { fetchImpl } = makeFetch([
      { match: () => true, respond: () => new Response("boom", { status: 500 }) },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await expect(adapter.importItems(TOKEN, EPID)).rejects.toThrow(/importItems failed: 500/);
  });
});

describe("JiraAdapter.writeItem", () => {
  it("PUTs the mapped issue fields (summary, description ADF, labels, duedate, priority)", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "PUT" && url.includes("/issue/10042"),
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await adapter.writeItem(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
      title: "New title",
      description: "line one\nline two",
      labels: ["backend"],
      priority: "urgent",
      dueAt: Date.parse("2026-08-01"),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    const sent = JSON.parse(calls[0].body ?? "{}");
    expect(sent.fields.summary).toBe("New title");
    expect(sent.fields.labels).toEqual(["backend"]);
    expect(sent.fields.priority).toEqual({ name: "Highest" });
    expect(sent.fields.duedate).toBe("2026-08-01");
    expect(sent.fields.description.type).toBe("doc"); // wrapped as ADF
    expect(sent.fields.description.content[0].content).toEqual([
      { type: "text", text: "line one" },
      { type: "hardBreak" },
      { type: "text", text: "line two" },
    ]);
  });

  it("resolves an assignee email to an accountId via user search", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/user/search"),
        respond: () => json([{ accountId: "acc-777", emailAddress: "dev@acme.io" }]),
      },
      {
        match: (url, m) => m === "PUT" && url.includes("/issue/"),
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await adapter.writeItem(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
      assigneeEmail: "dev@acme.io",
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").fields.assignee).toEqual({ accountId: "acc-777" });
  });

  it("makes no request for an empty patch and throws on a provider error", async () => {
    const noop = makeFetch([]);
    const adapter1 = new JiraAdapter({ fetchImpl: noop.fetchImpl });
    await adapter1.writeItem(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
    });
    expect(noop.calls).toHaveLength(0);

    const err = makeFetch([
      { match: () => true, respond: () => new Response("no", { status: 400 }) },
    ]);
    const adapter2 = new JiraAdapter({ fetchImpl: err.fetchImpl });
    await expect(
      adapter2.writeItem(TOKEN, {
        externalProjectId: EPID,
        itemType: "issue",
        itemNumber: "ENG-42",
        providerItemId: "10042",
        title: "x",
      }),
    ).rejects.toThrow(/writeItem failed/);
  });
});

describe("JiraAdapter.writeStatus", () => {
  const transitions = {
    transitions: [
      { id: "11", name: "Start", to: { id: "3", name: "In Progress" } },
      { id: "31", name: "Finish", to: { id: "10001", name: "Done" } },
    ],
  };

  it("finds a transition by target status name and POSTs it", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/transitions"),
        respond: () => json(transitions),
      },
      {
        match: (url, m) => m === "POST" && url.includes("/transitions"),
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await adapter.writeStatus(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
      sourceStatusName: "Done",
    });
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ transition: { id: "31" } });
  });

  it("finds a transition by target status id when supplied", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/transitions"),
        respond: () => json(transitions),
      },
      {
        match: (url, m) => m === "POST" && url.includes("/transitions"),
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await adapter.writeStatus(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
      sourceStatusId: "3",
      sourceStatusName: "In Progress",
    });
    expect(JSON.parse(calls.find((c) => c.method === "POST")?.body ?? "{}")).toEqual({
      transition: { id: "11" },
    });
  });

  it("skips (no POST) when no transition reaches the target status", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/transitions"),
        respond: () => json(transitions),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await adapter.writeStatus(TOKEN, {
      externalProjectId: EPID,
      itemType: "issue",
      itemNumber: "ENG-42",
      providerItemId: "10042",
      sourceStatusName: "Blocked",
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("throws when listing transitions fails", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "GET" && url.includes("/transitions"),
        respond: () => new Response("no", { status: 401 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    await expect(
      adapter.writeStatus(TOKEN, {
        externalProjectId: EPID,
        itemType: "issue",
        itemNumber: "ENG-42",
        providerItemId: "10042",
        sourceStatusName: "Done",
      }),
    ).rejects.toThrow(/failed to list transitions/);
  });
});

// ── dynamic-webhook auto-registration (best-effort, never throws) ──────────────
describe("JiraAdapter.registerWebhook", () => {
  const HOOK_URL = "https://app.cyborg7.com/api/jira/webhook?install=intg_1&secret=s3cr3t";

  it("POSTs {url, webhooks:[{events,jqlFilter}]} and returns the created id + 30d expiry", async () => {
    const before = Date.now();
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "POST" && url.endsWith("/rest/api/3/webhook"),
        respond: () => json({ webhookRegistrationResult: [{ createdWebhookId: 42 }] }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.registerWebhook(TOKEN, CLOUD_ID, {
      url: HOOK_URL,
      events: ["jira:issue_created", "comment_created"],
      jqlFilter: 'project = "ENG"',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.registration.webhookIds).toEqual([42]);
    const expiry = Date.parse(result.registration.expirationDate);
    // ~30 days out (allow a generous window around the 30d constant).
    expect(expiry).toBeGreaterThan(before + 29 * 24 * 3600_000);
    expect(expiry).toBeLessThan(before + 31 * 24 * 3600_000);
    // The request targets the cloudId-scoped gateway with a Bearer token + the exact body.
    const call = calls[0]!;
    expect(call.url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/webhook`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(call.body ?? "{}") as {
      url: string;
      webhooks: Array<{ events: string[]; jqlFilter: string }>;
    };
    expect(body.url).toBe(HOOK_URL);
    expect(body.webhooks).toEqual([
      { events: ["jira:issue_created", "comment_created"], jqlFilter: 'project = "ENG"' },
    ]);
  });

  it("returns ok:false with status on a 403 (missing scope) — never throws", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "POST" && url.endsWith("/rest/api/3/webhook"),
        respond: () => new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.registerWebhook(TOKEN, CLOUD_ID, {
      url: HOOK_URL,
      events: ["jira:issue_created"],
      jqlFilter: 'project = "ENG"',
    });
    expect(result).toEqual({ ok: false, status: 403, error: expect.stringContaining("403") });
  });

  it("treats a per-entry errors payload with no created id as a failure", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "POST" && url.endsWith("/rest/api/3/webhook"),
        respond: () => json({ webhookRegistrationResult: [{ errors: ["The URL is not allowed"] }] }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.registerWebhook(TOKEN, CLOUD_ID, {
      url: HOOK_URL,
      events: ["jira:issue_created"],
      jqlFilter: 'project = "ENG"',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("The URL is not allowed");
  });

  it("returns ok:false on a thrown transport error (never throws)", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNRESET"));
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.registerWebhook(TOKEN, CLOUD_ID, {
      url: HOOK_URL,
      events: ["jira:issue_created"],
      jqlFilter: 'project = "ENG"',
    });
    expect(result).toEqual({ ok: false, status: null, error: "ECONNRESET" });
  });
});

describe("JiraAdapter.refreshWebhooks", () => {
  it("PUTs {webhookIds} to /webhook/refresh and returns the new expirationDate", async () => {
    const EXPIRY = "2027-01-01T00:00:00.000Z";
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "PUT" && url.endsWith("/rest/api/3/webhook/refresh"),
        respond: () => json({ webhookIds: [42], expirationDate: EXPIRY }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.refreshWebhooks(TOKEN, CLOUD_ID, [42]);
    expect(result).toEqual({ ok: true, webhookIds: [42], expirationDate: EXPIRY });
    const body = JSON.parse(calls[0]?.body ?? "{}") as { webhookIds: number[] };
    expect(body.webhookIds).toEqual([42]);
  });

  it("returns ok:false when the refresh response omits expirationDate", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "PUT" && url.endsWith("/rest/api/3/webhook/refresh"),
        respond: () => json({ webhookIds: [42] }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.refreshWebhooks(TOKEN, CLOUD_ID, [42]);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false with status on a non-2xx — never throws", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "PUT" && url.endsWith("/rest/api/3/webhook/refresh"),
        respond: () => new Response("no", { status: 400, statusText: "Bad Request" }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.refreshWebhooks(TOKEN, CLOUD_ID, [42]);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe("JiraAdapter.deleteWebhook", () => {
  it("DELETEs {webhookIds} to /webhook and returns ok on a 202", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        match: (url, m) => m === "DELETE" && url.endsWith("/rest/api/3/webhook"),
        respond: () => new Response(null, { status: 202 }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.deleteWebhook(TOKEN, CLOUD_ID, [42, 43]);
    expect(result).toEqual({ ok: true });
    const body = JSON.parse(calls[0]?.body ?? "{}") as { webhookIds: number[] };
    expect(body.webhookIds).toEqual([42, 43]);
  });

  it("returns ok:false on a non-2xx — never throws", async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (url, m) => m === "DELETE" && url.endsWith("/rest/api/3/webhook"),
        respond: () => new Response("no", { status: 404, statusText: "Not Found" }),
      },
    ]);
    const adapter = new JiraAdapter({ fetchImpl });
    const result = await adapter.deleteWebhook(TOKEN, CLOUD_ID, [42]);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
