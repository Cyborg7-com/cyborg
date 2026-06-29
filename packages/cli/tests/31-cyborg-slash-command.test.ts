#!/usr/bin/env npx tsx

/**
 * Cyborg7 E2E: channel slash commands via CLI (CLI-first for #62/#85)
 *
 * 1. cyborg --help lists the slash command
 * 2. Unknown trigger → SLASH_FAILED with the server's "unknown command" error
 * 3. /summarize on an empty channel → "no messages to summarize"
 * 4. /summarize with history → ack ok (dispatched); the result (summary, or the
 *    "/summarize failed" service notice when no LLM provider is available in
 *    the test env) posts back to the channel as an agent message.
 */

import assert from "node:assert";
import { startTestDaemon } from "./helpers/test-daemon.ts";
import { runCyborg } from "./helpers/cyborg-cli.ts";

console.log("=== Cyborg7: Channel slash commands (CLI) ===\n");

const ctx = await startTestDaemon({
  env: { PASEO_NODE_ENV: "development" },
});

try {
  const USER = "slash@test.dev";

  // ─── Test 1: help lists the slash command ─────────────────────────
  {
    console.log("Test 1: cyborg --help lists slash");
    const r = await runCyborg(ctx, ["--help"]);
    assert.strictEqual(r.exitCode, 0, `expected exit 0, got ${r.exitCode}\nstderr: ${r.stderr}`);
    assert(r.stdout.includes("slash"), "help should list the slash command");
    console.log("  ok\n");
  }

  // ─── Setup: workspace + channel ───────────────────────────────────
  let workspaceId: string;
  let channelId: string;
  {
    const ws = await runCyborg(ctx, ["ws:create", "SlashLab", "--email", USER, "--json"]);
    assert.strictEqual(ws.exitCode, 0, `ws:create failed: ${ws.stderr}`);
    workspaceId = JSON.parse(ws.stdout).id;

    const ch = await runCyborg(ctx, ["ch:list", workspaceId, "--email", USER, "--json"]);
    assert.strictEqual(ch.exitCode, 0, `ch:list failed: ${ch.stderr}`);
    const channels = JSON.parse(ch.stdout) as Array<{ id: string; name: string }>;
    const general = channels.find((c) => c.name === "general") ?? channels[0];
    assert(general, "workspace should have a default channel");
    channelId = general.id;
    console.log(`Setup: workspace ${workspaceId}, channel ${channelId}\n`);
  }

  // ─── Test 2: unknown trigger is rejected ──────────────────────────
  {
    console.log("Test 2: unknown trigger rejected");
    const r = await runCyborg(ctx, [
      "slash",
      workspaceId,
      channelId,
      "definitely-not-a-command",
      "--email",
      USER,
      "--json",
    ]);
    assert.notStrictEqual(r.exitCode, 0, "unknown trigger should exit non-zero");
    assert(
      (r.stderr + r.stdout).includes("unknown command"),
      `error should mention 'unknown command', got:\n${r.stderr}\n${r.stdout}`,
    );
    console.log("  ok\n");
  }

  // ─── Test 3: /summarize on an empty channel ───────────────────────
  {
    console.log("Test 3: /summarize on empty channel");
    const r = await runCyborg(ctx, [
      "slash",
      workspaceId,
      channelId,
      "summarize",
      "--email",
      USER,
      "--json",
    ]);
    assert.notStrictEqual(r.exitCode, 0, "empty channel should exit non-zero");
    assert(
      (r.stderr + r.stdout).includes("no messages to summarize"),
      `error should mention empty channel, got:\n${r.stderr}\n${r.stdout}`,
    );
    console.log("  ok\n");
  }

  // ─── Test 4: /summarize with history → dispatch ack (deterministic) ──
  {
    console.log("Test 4: /summarize dispatch ack (--no-wait)");
    for (const text of ["we shipped the relay fix", "next: cut v0.0.80", "demo on friday"]) {
      const s = await runCyborg(ctx, ["send", workspaceId, channelId, text, "--email", USER]);
      assert.strictEqual(s.exitCode, 0, `send failed: ${s.stderr}`);
    }

    const r = await runCyborg(ctx, [
      "slash",
      workspaceId,
      channelId,
      "summarize",
      "5",
      "--no-wait",
      "--email",
      USER,
      "--json",
    ]);
    assert.strictEqual(r.exitCode, 0, `slash summarize failed: ${r.stderr}`);
    const data = JSON.parse(r.stdout) as { status: string; trigger: string };
    assert.strictEqual(data.trigger, "summarize");
    assert.strictEqual(data.status, "dispatched");
    console.log("  ok\n");
  }

  // ─── Test 5: full async loop — wait for the result channel message ──
  // The result is either a real summary (when an LLM provider is available on
  // the machine, this runs an actual completion) or the "/summarize failed"
  // service notice — both prove the RPC → background → channel-post round
  // trip. Latency is provider-dependent (the structured-generation fallback
  // chain can take minutes on a cold spawn), so a timeout SKIPS rather than
  // fails: the deterministic dispatch contract is already covered by test 4.
  {
    console.log("Test 5: /summarize full loop (waits for the async result)");
    const r = await runCyborg(
      ctx,
      [
        "slash",
        workspaceId,
        channelId,
        "summarize",
        "5",
        "--timeout",
        "240",
        "--email",
        USER,
        "--json",
      ],
      { timeout: 300_000 },
    );
    if (r.exitCode !== 0 && (r.stderr + r.stdout).includes("SLASH_TIMEOUT")) {
      console.log("  SKIP: no result within 240s (provider latency) — dispatch already verified\n");
    } else {
      assert.strictEqual(r.exitCode, 0, `slash summarize failed: ${r.stderr}`);
      const data = JSON.parse(r.stdout) as { status: string; result: string };
      assert.strictEqual(data.status, "completed", "should receive the async result message");
      assert(data.result.length > 0, "result text should be non-empty");
      console.log(`  result: ${data.result.slice(0, 100)}\n`);
    }
  }

  console.log("=== All slash-command tests passed ===");
} finally {
  await ctx.stop();
}
