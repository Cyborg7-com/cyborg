import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SlackClient } from "./client.js";

// #517: attachment upload PUTs to S3 via XMLHttpRequest (not fetch) so the
// browser/WebView can report upload progress, and an AbortSignal cancels the
// in-flight PUT. These tests mock the presign fetch + a fake XHR (the UI vitest
// env is plain node — no real window/XHR), driving uploadAsset end to end.

const PRESIGN = {
  presignedUrl: "https://s3.example.com/signed-put",
  publicUrl: "https://cdn.example.com/attachments/a.png",
  key: "attachments/a.png",
  requiredHeaders: { "Content-Type": "image/png" },
};

// Fake XHR whose send() is driven by the test (so we can fire progress, complete,
// or hang-then-abort). Captures the upload.onprogress handler the client wires.
type Listener = (e: unknown) => void;
class FakeXHR {
  static last: FakeXHR | null = null;
  status = 0;
  responseText = "";
  timeout = 0;
  headers: Record<string, string> = {};
  aborted = false;
  private listeners = new Map<string, Listener[]>();
  private uploadListeners = new Map<string, Listener[]>();
  // The client wires progress via `xhr.upload.addEventListener("progress", …)`.
  upload = {
    addEventListener: (type: string, fn: Listener) => {
      const l = this.uploadListeners.get(type) ?? [];
      l.push(fn);
      this.uploadListeners.set(type, l);
    },
  };
  constructor() {
    FakeXHR.last = this;
  }
  open(): void {}
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  send(): void {}
  abort(): void {
    this.aborted = true;
    for (const fn of this.listeners.get("abort") ?? []) fn(undefined);
  }
  // Test helpers.
  emitProgress(loaded: number, total: number): void {
    for (const fn of this.uploadListeners.get("progress") ?? [])
      fn({ lengthComputable: true, loaded, total });
  }
  complete(status = 200): void {
    this.status = status;
    for (const fn of this.listeners.get("load") ?? []) fn(undefined);
  }
}

function makeClient(): SlackClient {
  const client = new SlackClient();
  (client as unknown as { url: string }).url = "wss://relay.example.com/api/ws";
  (client as unknown as { token: string }).token = "test-token";
  return client;
}

const file = () => new File(["x".repeat(1000)], "a.png", { type: "image/png" });

beforeEach(() => {
  FakeXHR.last = null;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(PRESIGN), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploadAsset — XHR progress + cancel (#517)", () => {
  it("reports 0–100 upload progress and resolves with the public url/key", async () => {
    const client = makeClient();
    const seen: number[] = [];
    const p = client.uploadAsset(file(), "attachments", { onProgress: (pct) => seen.push(pct) });
    // Wait for the presign fetch to settle so the XHR has been created + send().
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    const xhr = FakeXHR.last!;
    xhr.emitProgress(25, 100);
    xhr.emitProgress(100, 100);
    xhr.complete(200);
    const res = await p;
    expect(seen).toEqual([25, 100]);
    expect(res).toEqual({ publicUrl: PRESIGN.publicUrl, key: PRESIGN.key });
    // The signed Content-Type header was replayed on the PUT.
    expect(xhr.headers["Content-Type"]).toBe("image/png");
  });

  it("aborts the in-flight PUT when the signal fires (cancel)", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const p = client.uploadAsset(file(), "attachments", { signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXHR.last!.aborted).toBe(true);
  });

  it("rejects (does not hang) when the signal is already aborted before send", async () => {
    const client = makeClient();
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    await expect(
      client.uploadAsset(file(), "attachments", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with the S3 error code on a non-2xx PUT", async () => {
    const client = makeClient();
    const p = client.uploadAsset(file(), "attachments");
    await vi.waitFor(() => expect(FakeXHR.last).not.toBeNull());
    const xhr = FakeXHR.last!;
    xhr.responseText = "<Error><Code>AccessDenied</Code></Error>";
    xhr.complete(403);
    await expect(p).rejects.toThrow(/HTTP 403 \(AccessDenied\)/);
  });
});
