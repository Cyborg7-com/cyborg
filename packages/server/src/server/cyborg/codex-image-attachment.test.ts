import { describe, expect, test } from "vitest";
import {
  buildAgentImageAttachments,
  prepareAgentImageUploads,
  extractLocalImageRefs,
  mimeForImageExt,
  stripImageTokens,
} from "./codex-image-attachment.js";

const baseOpts = {
  basename: (p: string) => p.split("/").pop() ?? p,
  maxBytes: 10 * 1024 * 1024,
  allowedDir: "/tmp/paseo-attachments",
};

describe("extractLocalImageRefs", () => {
  test("matches a local paseo-attachments image token", () => {
    const text = "Here is the image:\n![Image](/tmp/paseo-attachments/abc-123.png)";
    const refs = extractLocalImageRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      alt: "Image",
      path: "/tmp/paseo-attachments/abc-123.png",
      ext: "png",
      token: "![Image](/tmp/paseo-attachments/abc-123.png)",
    });
  });

  test("matches multiple images and preserves order", () => {
    const text =
      "![One](/var/folders/x/paseo-attachments/1.png) and ![Two](/var/folders/x/paseo-attachments/2.jpeg)";
    const refs = extractLocalImageRefs(text);
    expect(refs.map((r) => r.path)).toEqual([
      "/var/folders/x/paseo-attachments/1.png",
      "/var/folders/x/paseo-attachments/2.jpeg",
    ]);
    expect(refs[1].ext).toBe("jpeg");
  });

  test("ignores a regular markdown link (not an image)", () => {
    expect(extractLocalImageRefs("[click](/tmp/paseo-attachments/x.png)")).toHaveLength(0);
  });

  test("extracts ANY local image path (capture safety is the allowedDir containment, not the path)", () => {
    // Skill-generated images (e.g. imagegen) live OUTSIDE paseo-attachments — they
    // must be recognised here; buildAgentImageAttachments' containment gate decides
    // whether a given path is safe to read.
    expect(extractLocalImageRefs("![x](/tmp/some-skill-out/pic.png)")).toHaveLength(1);
    expect(extractLocalImageRefs("![x](/home/user/pic.png)")).toHaveLength(1);
  });

  test("ignores http(s) and data URLs even under the dir name", () => {
    expect(extractLocalImageRefs("![x](https://cdn/paseo-attachments/x.png)")).toHaveLength(0);
    expect(extractLocalImageRefs("![x](data:image/png;base64,AAAA)")).toHaveLength(0);
  });

  test("ignores non-image extensions", () => {
    expect(extractLocalImageRefs("![x](/tmp/paseo-attachments/x.txt)")).toHaveLength(0);
  });

  test("decodes escaped alt and defaults empty alt to 'Image'", () => {
    const refs = extractLocalImageRefs("![a\\]b](/tmp/paseo-attachments/x.webp)");
    expect(refs[0].alt).toBe("a]b");
    const empty = extractLocalImageRefs("![](/tmp/paseo-attachments/y.gif)");
    expect(empty[0].alt).toBe("Image");
  });

  test("returns nothing for empty/nullish input", () => {
    expect(extractLocalImageRefs("")).toEqual([]);
    expect(extractLocalImageRefs(null)).toEqual([]);
    expect(extractLocalImageRefs(undefined)).toEqual([]);
  });
});

describe("stripImageTokens", () => {
  test("removes the token and trims leftover whitespace", () => {
    const text = "Result:\n\n![Image](/tmp/paseo-attachments/x.png)";
    const ref = extractLocalImageRefs(text)[0];
    expect(stripImageTokens(text, [ref.token])).toBe("Result:");
  });

  test("an image-only message becomes empty", () => {
    const text = "![Image](/tmp/paseo-attachments/x.png)";
    expect(stripImageTokens(text, [text])).toBe("");
  });

  test("leaves surrounding prose intact between two images", () => {
    const text =
      "![One](/tmp/paseo-attachments/1.png)\nmiddle\n![Two](/tmp/paseo-attachments/2.png)";
    const refs = extractLocalImageRefs(text);
    expect(
      stripImageTokens(
        text,
        refs.map((r) => r.token),
      ),
    ).toBe("middle");
  });
});

describe("buildAgentImageAttachments", () => {
  test("captures the image, strips the token, and base64-encodes the bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const text = "Done!\n![Image](/tmp/paseo-attachments/x.png)";
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      readFile: () => png,
    });
    expect(out.text).toBe("Done!");
    expect(out.imageAttachments).toHaveLength(1);
    expect(out.imageAttachments[0]).toMatchObject({
      dataBase64: png.toString("base64"),
      mimeType: "image/png",
      filename: "x.png",
      size: png.length,
      alt: "Image",
    });
  });

  test("captures a SKILL-generated image outside paseo-attachments (the imagegen '!Image' bug)", () => {
    // imagegen writes under the temp dir but NOT in paseo-attachments — before the
    // fix the narrow path filter dropped it and the user saw a raw "!Image" token.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const out = buildAgentImageAttachments("![Image](/tmp/codex-imagegen/dog.png)", {
      ...baseOpts,
      allowedDir: "/tmp", // the production caller passes os.tmpdir()
      readFile: () => png,
    });
    expect(out.imageAttachments).toHaveLength(1);
    expect(out.imageAttachments[0]?.filename).toBe("dog.png");
    expect(out.text).toBe("");
  });

  test("containment still blocks a `..` traversal OUT of the allowed temp dir", () => {
    const errors: string[] = [];
    const out = buildAgentImageAttachments("![x](/tmp/../etc/secret.png)", {
      ...baseOpts,
      allowedDir: "/tmp",
      readFile: () => Buffer.from([1, 2, 3]),
      onError: (p) => errors.push(p),
    });
    expect(out.imageAttachments).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test("skips an oversized file and leaves its token in place", () => {
    const text = "![Image](/tmp/paseo-attachments/big.png)";
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      maxBytes: 3,
      readFile: () => Buffer.alloc(10),
    });
    expect(out.imageAttachments).toHaveLength(0);
    expect(out.text).toBe(text);
  });

  test("skips an empty file", () => {
    const out = buildAgentImageAttachments("![x](/tmp/paseo-attachments/e.png)", {
      ...baseOpts,
      readFile: () => Buffer.alloc(0),
    });
    expect(out.imageAttachments).toHaveLength(0);
  });

  test("a failed read is reported and the token is left untouched", () => {
    const errors: string[] = [];
    const text = "![x](/tmp/paseo-attachments/missing.png)";
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      readFile: () => {
        throw new Error("ENOENT");
      },
      onError: (p) => errors.push(p),
    });
    expect(out.imageAttachments).toHaveLength(0);
    expect(out.text).toBe(text);
    expect(errors).toEqual(["/tmp/paseo-attachments/missing.png"]);
  });

  test("captures multiple images and strips all their tokens", () => {
    const text = "![A](/tmp/paseo-attachments/a.png)\nmid\n![B](/tmp/paseo-attachments/b.webp)";
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      readFile: (p) => Buffer.from(p),
    });
    expect(out.imageAttachments.map((a) => a.filename)).toEqual(["a.png", "b.webp"]);
    expect(out.imageAttachments[1].mimeType).toBe("image/webp");
    expect(out.text).toBe("mid");
  });

  test("rejects a path that escapes the allowed dir via .. traversal", () => {
    const errors: string[] = [];
    let read = false;
    // extractLocalImageRefs matches it (substring + .png), but containment must
    // reject it because it resolves to /etc/secret.png, outside the allowed dir.
    const text = "![x](/tmp/paseo-attachments/../../../etc/secret.png)";
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      readFile: () => {
        read = true;
        return Buffer.from("secret");
      },
      onError: (p) => errors.push(p),
    });
    expect(out.imageAttachments).toHaveLength(0);
    expect(out.text).toBe(text);
    expect(read).toBe(false);
    expect(errors).toHaveLength(1);
  });

  test("reads the RESOLVED path inside the allowed dir", () => {
    let readPath = "";
    buildAgentImageAttachments("![x](/tmp/paseo-attachments/ok.png)", {
      ...baseOpts,
      readFile: (p) => {
        readPath = p;
        return Buffer.from("png");
      },
    });
    expect(readPath).toBe("/tmp/paseo-attachments/ok.png");
  });

  test("caps captured images per message at 10", () => {
    const text = Array.from({ length: 15 }, (_, i) => `![x](/tmp/paseo-attachments/${i}.png)`).join(
      "\n",
    );
    const out = buildAgentImageAttachments(text, {
      ...baseOpts,
      readFile: (p) => Buffer.from(p),
    });
    expect(out.imageAttachments).toHaveLength(10);
  });

  test("no local image → text unchanged, no attachments, reader never called", () => {
    let called = false;
    const out = buildAgentImageAttachments("just text [link](/x.png)", {
      ...baseOpts,
      readFile: () => {
        called = true;
        return Buffer.alloc(1);
      },
    });
    expect(out.imageAttachments).toEqual([]);
    expect(out.text).toBe("just text [link](/x.png)");
    expect(called).toBe(false);
  });
});

describe("mimeForImageExt", () => {
  test("maps known extensions", () => {
    expect(mimeForImageExt("png")).toBe("image/png");
    expect(mimeForImageExt("jpg")).toBe("image/jpeg");
    expect(mimeForImageExt("jpeg")).toBe("image/jpeg");
    expect(mimeForImageExt("webp")).toBe("image/webp");
    expect(mimeForImageExt("gif")).toBe("image/gif");
  });

  test("defaults unknown to image/png", () => {
    expect(mimeForImageExt("bmp")).toBe("image/png");
  });
});

describe("prepareAgentImageUploads (inline-render path: read bytes, keep token)", () => {
  const readFile = () => Buffer.from("PNGDATA");
  const opts = { ...baseOpts, readFile };

  test("returns the token + path + bytes WITHOUT stripping (so the caller rewrites in place)", () => {
    const text = "see ![diagram](/tmp/paseo-attachments/d.png) here";
    const ups = prepareAgentImageUploads(text, opts);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatchObject({
      token: "![diagram](/tmp/paseo-attachments/d.png)",
      path: "/tmp/paseo-attachments/d.png",
      alt: "diagram",
      mimeType: "image/png",
      filename: "d.png",
    });
    expect(ups[0].dataBase64).toBe(Buffer.from("PNGDATA").toString("base64"));
  });

  test("rejects a path that escapes the allowed dir (traversal-proof)", () => {
    const text = "![x](/tmp/paseo-attachments/../../etc/secret.png)";
    expect(prepareAgentImageUploads(text, opts)).toHaveLength(0);
  });

  test("skips an empty file but keeps a valid one", () => {
    const text = "![a](/tmp/paseo-attachments/a.png) ![b](/tmp/paseo-attachments/b.png)";
    const sized = {
      ...baseOpts,
      readFile: (p: string) => (p.endsWith("a.png") ? Buffer.alloc(0) : Buffer.from("x")),
    };
    const ups = prepareAgentImageUploads(text, sized);
    expect(ups.map((u) => u.filename)).toEqual(["b.png"]);
  });

  test("no image tokens → empty", () => {
    expect(prepareAgentImageUploads("just text, no image", opts)).toHaveLength(0);
  });
});
