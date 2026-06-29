import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { loadBetterSqlite3 } from "./native-module-path.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type {
  AgentTimelineStore,
  AgentTimelineRow,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
} from "../agent/agent-timeline-store-types.js";

const DEFAULT_FETCH_LIMIT = 200;

interface RawRow {
  agent_id: string;
  seq: number;
  timestamp: string;
  item_json: string;
}

export class SqliteAgentTimelineStore implements AgentTimelineStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Statement;
  private readonly getRowsStmt: Statement;
  private readonly getLatestSeqStmt: Statement;
  private readonly deleteStmt: Statement;
  private readonly fetchTailStmt: Statement;
  private readonly fetchAfterStmt: Statement;
  private readonly fetchBeforeStmt: Statement;
  private readonly minSeqStmt: Statement;
  private readonly maxSeqStmt: Statement;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === "string") {
      const BetterSqlite3 = loadBetterSqlite3();
      this.db = new BetterSqlite3(dbOrPath);
      this.db.pragma("journal_mode = WAL");
    } else {
      this.db = dbOrPath;
    }
    this.migrate();

    this.insertStmt = this.db.prepare(
      `INSERT INTO agent_timeline_rows (agent_id, seq, timestamp, item_json)
       VALUES (?, ?, ?, ?)`,
    );
    this.getRowsStmt = this.db.prepare(
      "SELECT * FROM agent_timeline_rows WHERE agent_id = ? ORDER BY seq ASC",
    );
    this.getLatestSeqStmt = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_timeline_rows WHERE agent_id = ?",
    );
    this.deleteStmt = this.db.prepare("DELETE FROM agent_timeline_rows WHERE agent_id = ?");
    this.fetchTailStmt = this.db.prepare(
      `SELECT * FROM agent_timeline_rows WHERE agent_id = ?
       ORDER BY seq DESC LIMIT ?`,
    );
    this.fetchAfterStmt = this.db.prepare(
      `SELECT * FROM agent_timeline_rows WHERE agent_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    );
    this.fetchBeforeStmt = this.db.prepare(
      `SELECT * FROM agent_timeline_rows WHERE agent_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT ?`,
    );
    this.minSeqStmt = this.db.prepare(
      "SELECT COALESCE(MIN(seq), 0) AS min_seq FROM agent_timeline_rows WHERE agent_id = ?",
    );
    this.maxSeqStmt = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_timeline_rows WHERE agent_id = ?",
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_timeline_rows (
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (agent_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_timeline_agent_seq
        ON agent_timeline_rows(agent_id, seq);
    `);
  }

  private toRow(raw: RawRow): AgentTimelineRow {
    return {
      seq: raw.seq,
      timestamp: raw.timestamp,
      item: JSON.parse(raw.item_json) as AgentTimelineItem,
    };
  }

  private getWindow(agentId: string): { minSeq: number; maxSeq: number; nextSeq: number } {
    const min = (this.minSeqStmt.get(agentId) as { min_seq: number }).min_seq;
    const max = (this.maxSeqStmt.get(agentId) as { max_seq: number }).max_seq;
    return { minSeq: min, maxSeq: max, nextSeq: max + 1 };
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    const seq = (this.getLatestSeqStmt.get(agentId) as { max_seq: number }).max_seq + 1;
    const timestamp = options?.timestamp ?? new Date().toISOString();
    this.insertStmt.run(agentId, seq, timestamp, JSON.stringify(item));
    return { seq, timestamp, item };
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    let limit: number;
    if (requestedLimit === undefined) {
      limit = DEFAULT_FETCH_LIMIT;
    } else if (requestedLimit === 0) {
      limit = 999999;
    } else {
      limit = Math.max(1, Math.floor(requestedLimit));
    }

    const window = this.getWindow(agentId);
    const { minSeq, maxSeq } = window;

    if (maxSeq === 0) {
      return {
        epoch: "committed",
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }

    let rawRows: RawRow[];
    let hasOlder: boolean;
    let hasNewer: boolean;

    if (direction === "tail") {
      rawRows = (this.fetchTailStmt.all(agentId, limit) as RawRow[]).toReversed();
      hasOlder = rawRows.length > 0 && rawRows[0].seq > minSeq;
      hasNewer = false;
    } else if (direction === "after") {
      const afterSeq = options?.cursor?.seq ?? 0;
      rawRows = this.fetchAfterStmt.all(agentId, afterSeq, limit) as RawRow[];
      hasOlder = rawRows.length > 0 && rawRows[0].seq > minSeq;
      hasNewer = rawRows.length > 0 && rawRows[rawRows.length - 1].seq < maxSeq;
    } else {
      const beforeSeq = options?.cursor?.seq ?? maxSeq + 1;
      rawRows = (this.fetchBeforeStmt.all(agentId, beforeSeq, limit) as RawRow[]).toReversed();
      hasOlder = rawRows.length > 0 && rawRows[0].seq > minSeq;
      hasNewer = true;
    }

    return {
      epoch: "committed",
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window,
      hasOlder,
      hasNewer,
      rows: rawRows.map((r) => this.toRow(r)),
    };
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return (this.getLatestSeqStmt.get(agentId) as { max_seq: number }).max_seq;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return (this.getRowsStmt.all(agentId) as RawRow[]).map((r) => this.toRow(r));
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const raw = this.db
      .prepare("SELECT * FROM agent_timeline_rows WHERE agent_id = ? ORDER BY seq DESC LIMIT 1")
      .get(agentId) as RawRow | undefined;
    return raw ? (JSON.parse(raw.item_json) as AgentTimelineItem) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const rows = (this.getRowsStmt.all(agentId) as RawRow[]).map((r) => this.toRow(r));
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const item = rows[i].item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  async hasCommittedUserMessage(
    agentId: string,
    options: { messageId: string; text: string },
  ): Promise<boolean> {
    const rows = (this.getRowsStmt.all(agentId) as RawRow[]).map((r) => this.toRow(r));
    return rows.some((row) => {
      if (row.item.type !== "user_message") return false;
      const mid = row.item.messageId?.trim();
      return mid === options.messageId.trim() && row.item.text === options.text;
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.deleteStmt.run(agentId);
  }

  // Rewrite a local image path to its uploaded S3 URL in any of this agent's
  // persisted rows (agent-image inline render): after the daemon uploads a
  // Codex/skill-generated image, the durable `![alt](/tmp/...)` token must point
  // at the reachable URL so a reload / lazy-load renders it inline (the live
  // broadcast is rewritten separately). We match the JSON-ENCODED form of the
  // path (item_json is `JSON.stringify`'d): a POSIX path is unchanged by JSON
  // encoding, but a Windows path's backslashes are stored escaped (`\\`), so
  // matching the raw path would never hit on Windows. Returns rows touched.
  rewriteImageUrl(agentId: string, fromPath: string, toUrl: string): number {
    // JSON.stringify(x).slice(1,-1) = the value as it appears INSIDE the json
    // string (escapes \, ", control chars) without the surrounding quotes.
    const needle = JSON.stringify(fromPath).slice(1, -1);
    const replacement = JSON.stringify(toUrl).slice(1, -1);
    const res = this.db
      .prepare(
        `UPDATE agent_timeline_rows
         SET item_json = REPLACE(item_json, ?, ?)
         WHERE agent_id = ? AND instr(item_json, ?) > 0`,
      )
      .run(needle, replacement, agentId, needle);
    return res.changes;
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    const insert = this.db.transaction((items: readonly AgentTimelineRow[]) => {
      for (const row of items) {
        this.insertStmt.run(agentId, row.seq, row.timestamp, JSON.stringify(row.item));
      }
    });
    insert(rows);
  }
}
