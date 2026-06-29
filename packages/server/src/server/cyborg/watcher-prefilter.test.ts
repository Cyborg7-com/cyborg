import { describe, expect, it } from "vitest";
import { shouldConsiderWatch } from "./watcher-prefilter.js";

describe("shouldConsiderWatch", () => {
  it("short-circuits true when the channel has open tasks, regardless of text", () => {
    // Even trivial chatter must pass when open tasks exist — it could be a
    // status update on one of them ("done", "👍").
    expect(shouldConsiderWatch({ text: "ok", hasOpenTasks: true })).toBe(true);
    expect(shouldConsiderWatch({ text: "", hasOpenTasks: true })).toBe(true);
    expect(shouldConsiderWatch({ text: "👍", hasOpenTasks: true })).toBe(true);
  });

  it("passes EN actionable messages of sufficient length when no open tasks", () => {
    expect(shouldConsiderWatch({ text: "can you deploy the relay?", hasOpenTasks: false })).toBe(
      true,
    );
    expect(shouldConsiderWatch({ text: "I finished the login fix", hasOpenTasks: false })).toBe(
      true,
    );
    expect(shouldConsiderWatch({ text: "this is blocked on review", hasOpenTasks: false })).toBe(
      true,
    );
    expect(shouldConsiderWatch({ text: "please review the PR today", hasOpenTasks: false })).toBe(
      true,
    );
  });

  it("passes scheduling / recurring intent with no open tasks (routes to schedule_create)", () => {
    expect(
      shouldConsiderWatch({
        text: "set up a recurring schedule every minute in this channel",
        hasOpenTasks: false,
      }),
    ).toBe(true);
    expect(
      shouldConsiderWatch({ text: "remind us daily about the standup", hasOpenTasks: false }),
    ).toBe(true);
    expect(
      shouldConsiderWatch({ text: "programa un recordatorio cada semana", hasOpenTasks: false }),
    ).toBe(true);
  });

  it("passes ES actionable messages of sufficient length when no open tasks", () => {
    expect(shouldConsiderWatch({ text: "ya hice el login", hasOpenTasks: false })).toBe(true);
    expect(shouldConsiderWatch({ text: "listo, ya terminé eso", hasOpenTasks: false })).toBe(true);
    expect(shouldConsiderWatch({ text: "está bloqueado por el review", hasOpenTasks: false })).toBe(
      true,
    );
    expect(shouldConsiderWatch({ text: "puedes revisar el deploy", hasOpenTasks: false })).toBe(
      true,
    );
    expect(shouldConsiderWatch({ text: "necesito que arregles esto", hasOpenTasks: false })).toBe(
      true,
    );
  });

  it("sheds trivial short chatter when there are no open tasks", () => {
    expect(shouldConsiderWatch({ text: "ok", hasOpenTasks: false })).toBe(false);
    expect(shouldConsiderWatch({ text: "lol", hasOpenTasks: false })).toBe(false);
    expect(shouldConsiderWatch({ text: "jaja", hasOpenTasks: false })).toBe(false);
    expect(shouldConsiderWatch({ text: "👍", hasOpenTasks: false })).toBe(false);
    expect(shouldConsiderWatch({ text: "   ", hasOpenTasks: false })).toBe(false);
  });

  it("sheds long but non-actionable chatter when there are no open tasks", () => {
    // >= 12 chars but no actionable verb → nothing to do.
    expect(shouldConsiderWatch({ text: "haha that was a funny meme", hasOpenTasks: false })).toBe(
      false,
    );
    expect(shouldConsiderWatch({ text: "good morning everyone", hasOpenTasks: false })).toBe(false);
  });

  it("errs toward true on ambiguous/borderline actionable phrasing (in-doubt → true)", () => {
    // A request phrasing must always look — never silently drop a real ask.
    expect(shouldConsiderWatch({ text: "could you take a look", hasOpenTasks: false })).toBe(true);
    expect(shouldConsiderWatch({ text: "we need to ship this", hasOpenTasks: false })).toBe(true);
  });
});
