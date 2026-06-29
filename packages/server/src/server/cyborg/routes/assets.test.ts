import { describe, it, expect } from "vitest";
import {
  resolvePresignMetadata,
  buildContentDisposition,
  PresignContentTypeError,
  INLINE_SAFE_TYPES,
  BLOCKED_UPLOAD_TYPES,
} from "./assets.js";

// These tests pin the presign-time download/XSS hardening policy: which declared
// content-types are inline, forced to download, neutralized to text/plain, or
// rejected outright. The metadata returned here is bound on the PutObjectCommand
// and is exactly what S3/CloudFront echo on GET (and what the client must replay
// on its PUT), so getting it right is the whole defense.

describe("resolvePresignMetadata — inline-safe types render inline", () => {
  const inlineSafe = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
  ];

  for (const type of inlineSafe) {
    it(`${type} → real ContentType, NO forced disposition`, () => {
      const meta = resolvePresignMetadata(type, "clip.bin");
      expect(meta.ContentType).toBe(type);
      expect(meta.ContentDisposition).toBeUndefined();
    });
  }

  it("the exported INLINE_SAFE_TYPES set excludes image/svg+xml", () => {
    expect(INLINE_SAFE_TYPES.has("image/svg+xml")).toBe(false);
  });
});

describe("resolvePresignMetadata — docs & generic files force download", () => {
  const downloadTypes = ["application/pdf", "text/plain", "application/json", "text/markdown"];

  for (const type of downloadTypes) {
    it(`${type} → real ContentType + attachment disposition`, () => {
      const meta = resolvePresignMetadata(type, "report.pdf");
      expect(meta.ContentType).toBe(type);
      expect(meta.ContentDisposition).toBeDefined();
      expect(meta.ContentDisposition).toMatch(/^attachment;/);
    });
  }
});

describe("resolvePresignMetadata — scriptable types are neutralized", () => {
  const scriptable = [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/ecmascript",
    "text/ecmascript",
    "application/x-javascript",
  ];

  for (const type of scriptable) {
    it(`${type} → ContentType forced to text/plain AND attachment`, () => {
      const meta = resolvePresignMetadata(type, "payload.html");
      // Forced to text/plain so the browser can never execute it.
      expect(meta.ContentType).toBe("text/plain");
      // AND forced to download.
      expect(meta.ContentDisposition).toBeDefined();
      expect(meta.ContentDisposition).toMatch(/^attachment;/);
    });
  }

  it("svg is NOT served as image/svg+xml (would allow inline <script>)", () => {
    const meta = resolvePresignMetadata("image/svg+xml", "logo.svg");
    expect(meta.ContentType).not.toBe("image/svg+xml");
    expect(meta.ContentType).toBe("text/plain");
  });
});

describe("resolvePresignMetadata — blocked executable/script types are rejected", () => {
  const blocked = [
    "application/x-msdownload",
    "application/x-sh",
    "application/x-executable",
    "application/java-archive",
    "application/vnd.microsoft.portable-executable",
  ];

  for (const type of blocked) {
    it(`${type} → throws PresignContentTypeError(blocked)`, () => {
      let caught: unknown;
      try {
        resolvePresignMetadata(type, "evil.exe");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PresignContentTypeError);
      expect((caught as PresignContentTypeError).reason).toBe("blocked");
    });

    it(`${type} is present in the exported BLOCKED_UPLOAD_TYPES set`, () => {
      expect(BLOCKED_UPLOAD_TYPES.has(type)).toBe(true);
    });
  }
});

describe("resolvePresignMetadata — unknown types are rejected", () => {
  it("an unrecognized content-type throws PresignContentTypeError(unsupported)", () => {
    let caught: unknown;
    try {
      resolvePresignMetadata("application/x-totally-made-up", "thing.xyz");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PresignContentTypeError);
    expect((caught as PresignContentTypeError).reason).toBe("unsupported");
  });

  it("empty content-type is rejected as unsupported", () => {
    expect(() => resolvePresignMetadata("", "x")).toThrow(PresignContentTypeError);
  });
});

describe("buildContentDisposition — filename sanitization", () => {
  it("strips control chars and header-injection attempts (CR/LF)", () => {
    const cd = buildContentDisposition("a\r\nContent-Length: 0\tb.txt");
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("\n");
    expect(cd).not.toContain("\t");
    expect(cd).toMatch(/^attachment;/);
  });

  it("strips quotes, backslashes and path separators from the ASCII fallback", () => {
    const cd = buildContentDisposition('../../etc/"passwd"\\x.txt');
    const fallback = /filename="([^"]*)"/.exec(cd)?.[1] ?? "";
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain("\\");
    expect(fallback).not.toContain("/");
  });

  it("RFC 5987-encodes non-ASCII filenames via filename*", () => {
    const cd = buildContentDisposition("résumé—café.pdf");
    // Plain ASCII fallback must not contain raw non-ASCII bytes.
    const fallback = /filename="([^"]*)"/.exec(cd)?.[1] ?? "";
    // eslint-disable-next-line no-control-regex
    expect(/[^\x20-\x7e]/.test(fallback)).toBe(false);
    // The extended form carries the real, percent-encoded UTF-8 name.
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent("résumé—café.pdf"));
  });

  it("falls back to a non-empty name when the input sanitizes to nothing", () => {
    const cd = buildContentDisposition("\x00\x01\x02");
    expect(cd).toMatch(/filename="[^"]+"/);
  });

  it("percent-encodes ' ( ) * in filename* (RFC 5987 attr-char excludes them)", () => {
    const cd = buildContentDisposition("song (live) 'remix'*.mp3");
    const ext = /filename\*=UTF-8''(\S+)$/.exec(cd)?.[1] ?? "";
    // None of these characters may appear literally in the ext-value.
    expect(ext).not.toMatch(/['()*]/);
    // They must be present in their percent-encoded form instead.
    expect(ext).toContain("%27"); // '
    expect(ext).toContain("%28"); // (
    expect(ext).toContain("%29"); // )
    expect(ext).toContain("%2A"); // *
  });
});
