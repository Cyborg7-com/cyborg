import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ResolvedCybo } from "./manifest.js";
import { resolvePi, describePi, type PiExec } from "./pi-path.js";

export interface RunnerOptions {
  model?: string;
  piCommand?: string;
  continue?: boolean;
  resume?: boolean;
  session?: string;
  noSession?: boolean;
  thinking?: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventCallback = (event: Record<string, unknown>) => void;

export class CyboRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cybo: ResolvedCybo;
  private model: string;
  private pi: PiExec;
  private sessionFlags: string[];
  private pending = new Map<string, PendingRequest>();
  private eventSubs = new Set<EventCallback>();
  private nextId = 1;
  private buf = "";
  private disposed = false;
  private stderrBuf = "";

  constructor(cybo: ResolvedCybo, options?: RunnerOptions) {
    this.cybo = cybo;
    this.pi = resolvePi(options?.piCommand);

    if (options?.model) {
      this.model = options.model;
    } else {
      const p = cybo.manifest.provider;
      const m = cybo.manifest.model;
      if (!m) this.model = p;
      else this.model = m.includes("/") ? m : `${p}/${m}`;
    }

    this.sessionFlags = [];
    if (options?.continue) this.sessionFlags.push("--continue");
    if (options?.resume) this.sessionFlags.push("--resume");
    if (options?.session) this.sessionFlags.push("--session", options.session);
    if (options?.noSession) this.sessionFlags.push("--no-session");
    if (options?.thinking) this.sessionFlags.push("--thinking", options.thinking);
  }

  getModel(): string {
    return this.model;
  }

  getSessionFlags(): string[] {
    return this.sessionFlags;
  }

  private spawn(): ChildProcessWithoutNullStreams {
    if (this.child && !this.disposed) return this.child;

    const args = [...this.pi.pre, "--mode", "rpc"];
    if (this.model) args.push("--model", this.model);
    args.push("--append-system-prompt", this.cybo.systemPrompt);
    args.push(...this.sessionFlags);

    const child = spawn(this.pi.cmd, args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString();
      if (this.stderrBuf.length > 4096) this.stderrBuf = this.stderrBuf.slice(-4096);
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || err.message?.includes("ENOENT")) {
        this.failAll(
          new Error(
            `PI not found ("${describePi(this.pi)}"). Reinstall cybo, or set PI_COMMAND.\n` +
              "  npm i -g @earendil-works/pi-coding-agent",
          ),
        );
      } else {
        this.failAll(err);
      }
    });

    child.on("exit", (code, signal) => {
      const msg = `PI exited (code=${code}, signal=${signal})`;
      const detail = this.stderrBuf.trim();
      this.failAll(new Error(detail ? `${msg}\n${detail}` : msg));
    });

    this.child = child;
    this.disposed = false;
    return child;
  }

  async *stream(prompt: string): AsyncGenerator<string> {
    this.spawn();

    const queue: string[] = [];
    let done = false;
    let turnError: Error | null = null;
    let waiting: ((v: void) => void) | null = null;

    const unsub = this.onEvent((event) => {
      if (event.type === "message_update") {
        const ame = (event as Record<string, Record<string, unknown>>).assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          queue.push(ame.delta);
          waiting?.();
        }
      } else if (event.type === "agent_end") {
        done = true;
        waiting?.();
      } else if (event.type === "process_exit") {
        turnError = new Error((event.error as string) ?? "PI process exited");
        done = true;
        waiting?.();
      }
    });

    const id = `req_${this.nextId++}`;
    this.write({ type: "prompt", message: prompt, id });

    try {
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `done` is set inside the event listener callback
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => {
            waiting = r;
          });
          waiting = null;
        }
      }
      if (turnError) throw turnError;
    } finally {
      unsub();
    }
  }

  async prompt(prompt: string): Promise<string> {
    let result = "";
    for await (const chunk of this.stream(prompt)) {
      result += chunk;
    }
    return result;
  }

  async clearHistory(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.disposed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    this.child.kill("SIGTERM");
    this.child = null;
    this.pending.clear();
  }

  private onEvent(cb: EventCallback): () => void {
    this.eventSubs.add(cb);
    return () => this.eventSubs.delete(cb);
  }

  private write(value: unknown): void {
    if (this.disposed || !this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i === -1) break;
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const msg = parsed as Record<string, unknown>;
    if (msg.type === "response") {
      const r = msg as unknown as RpcResponse;
      const p = r.id ? this.pending.get(r.id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(r.id!);
        if (!r.success) p.reject(new Error(r.error ?? `PI RPC ${r.command} failed`));
        else p.resolve(r.data);
      }
      return;
    }
    for (const sub of this.eventSubs) sub(msg);
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const sub of this.eventSubs) {
      sub({ type: "process_exit", error: error.message });
    }
  }
}
