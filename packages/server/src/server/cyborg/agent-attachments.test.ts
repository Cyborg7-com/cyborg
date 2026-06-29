import { describe, it, expect } from "vitest";
import { buildAgentPrompt, isPrivateAddress, promptInputToText } from "./agent-attachments.js";
import type { AgentPromptContentBlock } from "../agent/agent-sdk-types.js";

// 1x1 transparent PNG as a data: URL — exercises the no-network base64 path.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function asBlocks(input: string | AgentPromptContentBlock[]): AgentPromptContentBlock[] {
  if (typeof input === "string") throw new Error("expected content blocks, got a string");
  return input;
}

describe("buildAgentPrompt (#579)", () => {
  it("returns the plain string when there are no attachments (no behavior change)", async () => {
    expect(await buildAgentPrompt({ text: "hello", supportsImageBlocks: true })).toBe("hello");
    expect(
      await buildAgentPrompt({ text: "hi", attachments: [], supportsImageBlocks: false }),
    ).toBe("hi");
  });

  it("inlines a supported image as a base64 vision block for image-capable providers", async () => {
    const out = await buildAgentPrompt({
      text: "look at this",
      attachments: [{ name: "shot.png", type: "image/png", size: 100, url: PNG_DATA_URL }],
      supportsImageBlocks: true,
    });
    const blocks = asBlocks(out);
    expect(blocks[0]).toEqual({ type: "text", text: "look at this" });
    expect(blocks[1].type).toBe("image");
    const img = blocks[1] as { type: "image"; data: string; mimeType: string };
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toMatch(/^iVBOR/); // raw base64, no data: prefix
  });

  it("non-vision providers get a TEXT reference for an image (never silently dropped)", async () => {
    const out = await buildAgentPrompt({
      text: "look",
      attachments: [{ name: "shot.png", type: "image/png", size: 100, url: PNG_DATA_URL }],
      supportsImageBlocks: false,
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("look");
    expect(out).toContain("[Attached file: shot.png");
  });

  it("inlines a text file as a fenced excerpt (both provider kinds)", async () => {
    const textUrl = `data:text/plain;base64,${Buffer.from("line1\nline2").toString("base64")}`;
    const att = [{ name: "notes.txt", type: "text/plain", size: 11, url: textUrl }];

    const visionOut = asBlocks(
      await buildAgentPrompt({ text: "", attachments: att, supportsImageBlocks: true }),
    );
    expect(visionOut[0]).toEqual({
      type: "text",
      text: "Attached file notes.txt:\n```\nline1\nline2\n```",
    });

    const plainOut = await buildAgentPrompt({
      text: "see file",
      attachments: att,
      supportsImageBlocks: false,
    });
    expect(plainOut).toBe("see file\n\nAttached file notes.txt:\n```\nline1\nline2\n```");
  });

  it("an unsupported image type (svg/heic) degrades to a reference, not a broken block", async () => {
    const out = asBlocks(
      await buildAgentPrompt({
        text: "x",
        attachments: [
          { name: "diagram.svg", type: "image/svg+xml", size: 50, url: "https://x/d.svg" },
        ],
        supportsImageBlocks: true,
      }),
    );
    expect(out.find((b) => b.type === "image")).toBeUndefined();
    expect(out.some((b) => b.type === "text" && b.text.includes("diagram.svg"))).toBe(true);
  });

  it("a fetch failure degrades that attachment to a reference (never throws)", async () => {
    const out = asBlocks(
      await buildAgentPrompt({
        text: "x",
        attachments: [{ name: "p.png", type: "image/png", size: 10, url: "https://x/p.png" }],
        supportsImageBlocks: true,
        fetchBytes: async () => {
          throw new Error("network down");
        },
      }),
    );
    expect(out.find((b) => b.type === "image")).toBeUndefined();
    expect(out.some((b) => b.type === "text" && b.text.includes("[Attached file: p.png"))).toBe(
      true,
    );
  });

  it("references carry name/type/size but NEVER the (possibly signed) url", async () => {
    const out = await buildAgentPrompt({
      text: "",
      attachments: [
        {
          name: "clip.mp4",
          type: "video/mp4",
          size: 1024 * 1024,
          url: "https://signed.example/clip.mp4?token=secret",
        },
      ],
      supportsImageBlocks: false,
    });
    expect(out).toContain("clip.mp4");
    expect(out).toContain("1.0 MB");
    expect(out).not.toContain("token=secret");
  });
});

describe("SSRF guard (#618)", () => {
  it("flags private / loopback / link-local / ULA / CGNAT addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.5",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast 224/4
      "240.0.0.1", // reserved / Class E 240/4
      "255.255.255.255", // broadcast
      "::1",
      "fe80::1",
      "fe90::1", // link-local /10 beyond fe80
      "feba::1", // link-local /10 upper edge
      "fc00::1",
      "fd12::3",
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "::127.0.0.1", // IPv4-compatible loopback
      "not-an-ip", // unrecognized → unsafe
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it("an image URL pointing at the cloud metadata IP degrades to a reference (no fetch)", async () => {
    // IP literals resolve to themselves via dns.lookup (no network), so the
    // guard rejects 169.254.169.254 deterministically and the image becomes a
    // safe text reference instead of an SSRF fetch.
    const out = asBlocks(
      await buildAgentPrompt({
        text: "x",
        attachments: [
          { name: "evil.png", type: "image/png", size: 10, url: "https://169.254.169.254/x.png" },
        ],
        supportsImageBlocks: true,
      }),
    );
    expect(out.find((b) => b.type === "image")).toBeUndefined();
    expect(out.some((b) => b.type === "text" && b.text.includes("[Attached file: evil.png"))).toBe(
      true,
    );
  });

  it("a non-https attachment URL is rejected (degrades to a reference)", async () => {
    const out = await buildAgentPrompt({
      text: "x",
      attachments: [
        { name: "f.txt", type: "text/plain", size: 5, url: "http://example.com/f.txt" },
      ],
      supportsImageBlocks: false,
    });
    expect(out).toContain("[Attached file: f.txt");
  });
});

describe("promptInputToText", () => {
  it("passes a string through unchanged", () => {
    expect(promptInputToText("hi")).toBe("hi");
  });

  it("joins text blocks and elides images", () => {
    expect(
      promptInputToText([
        { type: "text", text: "caption" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "more" },
      ]),
    ).toBe("caption\n\n[image]\n\nmore");
  });
});
