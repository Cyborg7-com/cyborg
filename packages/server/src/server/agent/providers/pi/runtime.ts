import type {
  PiAgentMessage,
  PiModel,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

export interface PiRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  model?: string;
  thinkingOptionId?: string;
  session?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  ephemeral?: boolean;
  noExtensions?: boolean;
}

export interface PiStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  thinkingOptionId?: string;
  session?: string;
  systemPrompt?: string;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  // Start a throwaway session that Pi never persists (the `--no-session` flag).
  // Ignored when `session` is set (resuming an explicit session file).
  ephemeral?: boolean;
  // Disable auto-discovery of the user's GLOBAL/project Pi extensions (the
  // `--no-extensions` flag). Explicitly-passed `extensionPaths` (-e) still load.
  noExtensions?: boolean;
}

export interface PiRuntimeSession {
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<PiAgentMessage[]>;
  getAvailableModels(): Promise<PiModel[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: string): Promise<void>;
  getSessionStats(): Promise<PiSessionStats>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface PiRuntime {
  startSession(input: PiStartSessionInput): Promise<PiRuntimeSession>;
}

export function buildPiLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: PiStartSessionInput;
}): PiRuntimeLaunch {
  const command =
    input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]
      ? input.runtimeSettings.command.argv
      : input.command;
  const argv = [...command];

  if (!hasModeRpc(argv)) {
    argv.push("--mode", "rpc");
  }
  if (input.session.model) {
    argv.push("--model", input.session.model);
  }
  if (input.session.thinkingOptionId) {
    argv.push("--thinking", input.session.thinkingOptionId);
  }
  if (input.session.session) {
    argv.push("--session", input.session.session);
  } else if (input.session.ephemeral) {
    // No explicit session to resume + ephemeral → standalone, unsaved Pi session.
    argv.push("--no-session");
  }
  const systemPrompt = input.session.systemPrompt?.trim();
  if (systemPrompt) {
    argv.push("--append-system-prompt", systemPrompt);
  }
  if (input.session.mcpConfigPath) {
    argv.push("--mcp-config", input.session.mcpConfigPath);
  }
  if (input.session.noExtensions) {
    // Turn OFF auto-discovery of global/project extensions; the explicit
    // `--extension` paths below still load.
    argv.push("--no-extensions");
  }
  for (const extensionPath of input.session.extensionPaths ?? []) {
    argv.push("--extension", extensionPath);
  }

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    session: input.session.session,
    systemPrompt,
    mcpConfigPath: input.session.mcpConfigPath,
    extensionPaths: input.session.extensionPaths,
    ephemeral: input.session.ephemeral,
    noExtensions: input.session.noExtensions,
  };
}

function hasModeRpc(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode" && argv[i + 1] === "rpc") {
      return true;
    }
    if (argv[i] === "--mode=rpc") {
      return true;
    }
  }
  return false;
}
