import type { Command } from "commander";
import type { ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface CyboRow {
  id: string;
  slug: string;
  name: string;
  provider: string;
  model: string | null;
  role: string | null;
  isDefault: boolean;
  createdAt?: number;
}

const cyboSchema: OutputSchema<CyboRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 20 },
    { header: "SLUG", field: "slug", width: 16 },
    { header: "NAME", field: "name", width: 20 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "MODEL", field: (c) => c.model ?? "-", width: 20 },
    { header: "ROLE", field: (c) => c.role ?? "-", width: 20 },
    {
      header: "DEFAULT",
      field: (c) => (c.isDefault ? "yes" : "no"),
      width: 8,
    },
  ],
};

interface CyboCreateOptions extends CyborgCommandOptions {
  provider?: string;
  model?: string;
  description?: string;
  avatar?: string;
  role?: string;
  soul?: string;
  soulFile?: string;
  toolGrants?: string;
}

// Parse the --tool-grants value: an inline JSON string, or `@<path>` to read
// the JSON from a file. Returns undefined when the flag is absent so the
// create request stays byte-identical (the server treats an absent grant set as
// "no Composio tools"). Throws a typed CLI error on unreadable/invalid JSON so a
// typo never silently drops a cybo's tool grants.
async function parseToolGrants(raw: string | undefined): Promise<unknown | undefined> {
  if (raw === undefined) return undefined;
  let text = raw;
  if (raw.startsWith("@")) {
    const { readFileSync } = await import("node:fs");
    text = readFileSync(raw.slice(1), "utf-8");
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw toCyborgError("CYBO_CREATE_FAILED", "parse --tool-grants", err);
  }
}

export async function runCyboCreateCommand(
  workspaceId: string,
  slug: string,
  name: string,
  options: CyboCreateOptions,
  _command: Command,
): Promise<SingleResult<CyboRow>> {
  let soul = options.soul ?? "";
  if (options.soulFile) {
    const { readFileSync } = await import("node:fs");
    soul = readFileSync(options.soulFile, "utf-8");
  }
  if (!soul) {
    throw toCyborgError(
      "CYBO_CREATE_FAILED",
      "create cybo",
      new Error("Soul is required (--soul or --soul-file)"),
    );
  }

  const toolGrants = await parseToolGrants(options.toolGrants);

  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ cybo: CyboRow }>("cyborg:create_cybo", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
      slug,
      name,
      soul,
      provider: options.provider ?? "claude",
      model: options.model,
      description: options.description,
      avatar: options.avatar,
      role: options.role,
      ...(toolGrants !== undefined ? { toolGrants } : {}),
    });
    return {
      type: "single",
      data: resp.cybo,
      schema: cyboSchema,
    };
  } catch (err) {
    throw toCyborgError("CYBO_CREATE_FAILED", "create cybo", err);
  } finally {
    client.close();
  }
}

export async function runCyboListCommand(
  workspaceId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<ListResult<CyboRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ cybos: CyboRow[] }>("cyborg:fetch_cybos", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
    });
    return {
      type: "list",
      data: resp.cybos,
      schema: cyboSchema,
    };
  } catch (err) {
    throw toCyborgError("CYBO_LIST_FAILED", "list cybos", err);
  } finally {
    client.close();
  }
}

interface CyboSpawnOptions extends CyborgCommandOptions {
  channel?: string;
  cwd?: string;
}

interface SpawnResult {
  agentId: string;
  cyboId: string;
  cyboSlug: string;
  provider: string;
  model: string | null;
}

const spawnSchema: OutputSchema<SpawnResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 24 },
    { header: "CYBO", field: "cyboSlug", width: 16 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "MODEL", field: (s) => s.model ?? "-", width: 20 },
  ],
};

export async function runCyboSpawnCommand(
  workspaceId: string,
  cyboIdOrSlug: string,
  options: CyboSpawnOptions,
  _command: Command,
): Promise<SingleResult<SpawnResult>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<SpawnResult>("cyborg:spawn_cybo", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
      cyboIdOrSlug,
      channelId: options.channel,
      cwd: options.cwd ?? process.cwd(),
    });
    return {
      type: "single",
      data: resp,
      schema: spawnSchema,
    };
  } catch (err) {
    throw toCyborgError("CYBO_SPAWN_FAILED", "spawn cybo", err);
  } finally {
    client.close();
  }
}
