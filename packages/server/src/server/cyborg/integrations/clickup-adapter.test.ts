import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { clickUpAdapter, CLICKUP_PROVIDER } from "./clickup-adapter.js";

const SECRET = "clickup-webhook-secret-abc123";

// The X-Signature header ClickUp sends: hex HMAC-SHA256(secret, rawBody). Pass a wrong
// secret to forge a bad signature.
function signature(rawBody: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// A minimal Response-like stub for the fetch mock (only the fields the adapter reads).
interface FetchCall {
  url: string;
  init: { method?: string; body?: string; headers?: Record<string, string> } | undefined;
}

function mockResponse(opts: { ok?: boolean; status?: number; json?: unknown }): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    json: async () => opts.json ?? {},
    body: { cancel: async () => {} },
  } as unknown as Response;
}

// Install a fetch stub that routes by URL, recording every call for assertions.
function stubFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: unknown) => {
    const call: FetchCall = { url: String(url), init: init as FetchCall["init"] };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clickUpAdapter.provider", () => {
  it("is 'clickup'", () => {
    expect(clickUpAdapter.provider).toBe(CLICKUP_PROVIDER);
    expect(CLICKUP_PROVIDER).toBe("clickup");
  });
});

describe("clickUpAdapter.verifyWebhook", () => {
  const body = JSON.stringify({ event: "taskStatusUpdated", task_id: "86xy1" });

  it("accepts a correctly-signed request", () => {
    const headers = { "x-signature": signature(body) };
    expect(clickUpAdapter.verifyWebhook(body, headers, SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const headers = { "x-signature": signature(body, "wrong-secret") };
    expect(clickUpAdapter.verifyWebhook(body, headers, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const headers = { "x-signature": signature(body) };
    expect(clickUpAdapter.verifyWebhook(`${body} tampered`, headers, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(clickUpAdapter.verifyWebhook(body, {}, SECRET)).toBe(false);
  });

  it("rejects an empty secret", () => {
    const headers = { "x-signature": signature(body) };
    expect(clickUpAdapter.verifyWebhook(body, headers, "")).toBe(false);
  });
});

describe("clickUpAdapter.parseInbound", () => {
  it("delegates to the mapper and returns normalized events", () => {
    const events = clickUpAdapter.parseInbound({
      event: "taskDeleted",
      task_id: "86xy1",
      list_id: "list-900",
      history_items: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0].itemType).toBe("deleted");
    expect(events[0].itemNumber).toBe("86xy1");
  });

  it("returns [] for an unrecognized payload", () => {
    expect(clickUpAdapter.parseInbound({ foo: "bar" })).toEqual([]);
    expect(clickUpAdapter.parseInbound(null)).toEqual([]);
  });
});

describe("clickUpAdapter.listStatuses", () => {
  it("GETs the List and maps its statuses[] (ordered by orderindex, category mapped)", async () => {
    const calls = stubFetch(() =>
      mockResponse({
        json: {
          id: "list-900",
          statuses: [
            { id: "s2", status: "in progress", type: "custom", orderindex: 1 },
            { id: "s1", status: "to do", type: "open", orderindex: 0 },
            { id: "s3", status: "cancelled", type: "closed", orderindex: 2 },
          ],
        },
      }),
    );

    const statuses = await clickUpAdapter.listStatuses("pk_token", "list-900");

    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/list-900");
    expect(calls[0].init?.headers?.Authorization).toBe("pk_token");
    expect(statuses).toEqual([
      { id: "s1", name: "to do", category: "unstarted" },
      { id: "s2", name: "in progress", category: "started" },
      { id: "s3", name: "cancelled", category: "cancelled" },
    ]);
  });

  it("throws on a provider error", async () => {
    stubFetch(() => mockResponse({ ok: false, status: 401, json: { err: "Token invalid" } }));
    await expect(clickUpAdapter.listStatuses("bad", "list-900")).rejects.toThrow(/Token invalid/);
  });
});

describe("clickUpAdapter.importItems", () => {
  function taskPage(ids: string[], lastPage: boolean): unknown {
    return {
      last_page: lastPage,
      tasks: ids.map((id) => ({
        id,
        name: `Task ${id}`,
        status: { id: "s1", status: "to do", type: "open" },
        list: { id: "list-900" },
      })),
    };
  }

  it("maps a page and returns nextCursor while a non-last page returns", async () => {
    const calls = stubFetch(() => mockResponse({ json: taskPage(["a", "b"], false) }));

    const page = await clickUpAdapter.importItems("pk_token", "list-900");

    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/list-900/task?page=0");
    expect(page.items.map((i) => i.itemNumber)).toEqual(["a", "b"]);
    expect(page.items[0].itemType).toBe("task");
    expect(page.nextCursor).toBe("1");
  });

  it("resumes from the cursor page and stops on the last page", async () => {
    const calls = stubFetch(() => mockResponse({ json: taskPage(["c"], true) }));

    const page = await clickUpAdapter.importItems("pk_token", "list-900", "3");

    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/list-900/task?page=3");
    expect(page.items.map((i) => i.itemNumber)).toEqual(["c"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("on a 429 returns the SAME page as the cursor with no items (resume, no throw)", async () => {
    stubFetch(() => mockResponse({ ok: false, status: 429 }));

    const page = await clickUpAdapter.importItems("pk_token", "list-900", "2");

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe("2");
  });

  it("throws on a non-429 provider error", async () => {
    stubFetch(() => mockResponse({ ok: false, status: 500, json: { err: "boom" } }));
    await expect(clickUpAdapter.importItems("pk_token", "list-900")).rejects.toThrow(/boom/);
  });
});

describe("clickUpAdapter.writeItem / writeStatus", () => {
  it("PUTs name/description/priority/due/start (priority mapped back to ClickUp scale)", async () => {
    const calls = stubFetch(() => mockResponse({ json: {} }));

    await clickUpAdapter.writeItem("pk_token", {
      externalProjectId: "list-900",
      itemType: "task",
      itemNumber: "86xy1",
      providerItemId: "86xy1",
      title: "Renamed",
      description: "new body",
      priority: "medium",
      dueAt: 1508369194377,
      startAt: null,
    });

    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/task/86xy1");
    expect(calls[0].init?.method).toBe("PUT");
    const sent = JSON.parse(calls[0].init?.body ?? "{}");
    expect(sent).toEqual({
      name: "Renamed",
      description: "new body",
      priority: 3,
      due_date: 1508369194377,
      start_date: null,
    });
  });

  it("skips the PUT entirely when the patch carries no writable fields", async () => {
    const calls = stubFetch(() => mockResponse({ json: {} }));
    await clickUpAdapter.writeItem("pk_token", {
      externalProjectId: "list-900",
      itemType: "task",
      itemNumber: "86xy1",
      providerItemId: "86xy1",
    });
    expect(calls).toHaveLength(0);
  });

  it("writeStatus PUTs the status by name", async () => {
    const calls = stubFetch(() => mockResponse({ json: {} }));

    await clickUpAdapter.writeStatus("pk_token", {
      externalProjectId: "list-900",
      itemType: "task",
      itemNumber: "86xy1",
      providerItemId: "86xy1",
      sourceStatusName: "done",
    });

    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/task/86xy1");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({ status: "done" });
  });

  it("throws on a provider error", async () => {
    stubFetch(() => mockResponse({ ok: false, status: 400, json: { err: "bad status" } }));
    await expect(
      clickUpAdapter.writeStatus("pk_token", {
        externalProjectId: "list-900",
        itemType: "task",
        itemNumber: "86xy1",
        providerItemId: "86xy1",
        sourceStatusName: "nope",
      }),
    ).rejects.toThrow(/bad status/);
  });
});
