-- Custom SQL migration file, put your code below! --
-- Full-text message search (Postgres-native, no Elasticsearch/extensions).
--
-- This is a CUSTOM migration: a GENERATED tsvector column + GIN index can't be
-- expressed in Drizzle's `schema.ts`, so `db:generate` never emits it. Without
-- this migration a fresh DB built from 0000_init would LACK `messages.tsv`, and
-- `PgSync.searchMessages` (`tsv @@ websearch_to_tsquery` + `ts_rank_cd(tsv, …)`)
-- would throw "column tsv does not exist" — message search broken on every new
-- install. Prod already has these (old hand-applied 0006_message_search); the
-- IF NOT EXISTS guards make this a safe no-op there.
--
-- 'simple' text-search config = no stemming → safe for mixed ES/EN content (the
-- english/spanish stemmers would mangle the other language). The STORED generated
-- column keeps index maintenance automatic; the query side uses
-- websearch_to_tsquery so user syntax ("quoted", -exclude, or) works.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", ''))) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_tsv" ON "messages" USING gin ("tsv");