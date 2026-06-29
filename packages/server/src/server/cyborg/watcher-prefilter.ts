// Tasks Phase 2 — channel-watcher pre-filter (internal docs). The watcher
// fires on UN-mentioned human chatter, and every fire spawns an (LLM) ephemeral
// cybo turn. This pure, zero-dep gate runs BEFORE the rate-limit/spawn so the
// vast majority of idle small-talk never costs a spawn: it only lets a message
// through when there's plausibly something to act on.
//
// Two ways through:
//   1. The channel already has OPEN tasks — a "done"/"blocked"/follow-up could be
//      about any of them, so we can't cheaply rule it out from the text alone.
//   2. The message is non-trivial (>= 12 chars) AND reads like a request, a
//      status report, or a to-do — matched against a small EN/ES actionable-verb
//      set (create/assign/update levers).
//
// Bias: when in doubt, return true. The rate-limit + the LLM itself are the real
// cost gates; this only sheds the obviously-nothing cases ("ok", "lol", "👍").
// It must NEVER be the reason a real task signal is dropped, so it errs toward
// letting the cybo look. Pure and dependency-free so it's trivially unit-tested
// and importable by the relay without pulling daemon-side surface.

const MIN_ACTIONABLE_LENGTH = 12;

// Actionable EN + ES verbs/phrases. Lower-cased, matched as substrings against
// the lower-cased message. Word-ish boundaries aren't enforced (a Spanish
// conjugation or a typo'd suffix should still trip it — in-doubt → true), but
// each token is specific enough that ordinary chatter won't accidentally hit it.
const ACTIONABLE_PATTERNS: readonly string[] = [
  // EN — status / completion
  "done",
  "finished",
  "complete",
  "completed",
  "ready",
  "shipped",
  "blocked",
  "stuck",
  "waiting on",
  // EN — requests / asks
  "can you",
  "could you",
  "please",
  "need",
  "needs",
  "should we",
  "let's",
  "lets ",
  // EN — task-ish nouns / actions
  "todo",
  "to-do",
  "task",
  "fix",
  "bug",
  "deploy",
  "review",
  "follow up",
  "follow-up",
  "assign",
  // ES — status / completion
  "ya hice",
  "ya termin",
  "termin", // terminé / terminado / terminamos
  "listo",
  "lista",
  "hecho",
  "completad", // completado / completada
  "bloquead", // bloqueado / bloqueada
  "atascad", // atascado
  "pendiente",
  // ES — requests / asks
  "puedes",
  "podrias",
  "podrías",
  "necesito",
  "necesita",
  "necesitamos",
  "por favor",
  "hay que",
  "tenemos que",
  // ES — task-ish nouns / actions
  "tarea",
  "revisa",
  "revisar",
  "arregla",
  "arreglar",
  "despliega",
  "desplegar",
  "asigna",
  "asignar",
  // EN — scheduling / recurring intent (so a "remind us every Monday" / "schedule
  // a standup" reaches the watcher even with no open tasks — it routes to
  // schedule_create, see buildWatcherPrompt). Substrings: "schedule" also catches
  // scheduled/scheduling; "recurr" → recurring/recurrente; "remind" → reminder.
  "schedule",
  "recurr",
  "remind",
  "daily",
  "weekly",
  "hourly",
  "standup",
  "stand-up",
  "cron",
  "every day",
  "every week",
  "every morning",
  "every hour",
  "every minute",
  "every month",
  // ES — scheduling / recurring intent
  "programa", // programa / programar / programá
  "recordar",
  "recordatorio",
  "recordá",
  "cada día",
  "cada dia",
  "cada semana",
  "cada hora",
  "diariamente",
  "semanal",
];

export interface WatchPrefilterInput {
  text: string;
  hasOpenTasks: boolean;
}

// True if the channel watcher should bother considering this message at all.
// Cheap and conservative — see the module header for the bias rationale.
export function shouldConsiderWatch(input: WatchPrefilterInput): boolean {
  // An open task in the channel means a "done"/"blocked"/short follow-up could be
  // a status update on it — we can't safely shed those on text alone.
  if (input.hasOpenTasks) return true;

  const text = input.text?.trim() ?? "";
  // Trivial chatter ("ok", "lol", "jaja", a lone emoji) carries no actionable
  // signal and there are no open tasks to update — shed it before the spawn.
  if (text.length < MIN_ACTIONABLE_LENGTH) return false;

  const lower = text.toLowerCase();
  return ACTIONABLE_PATTERNS.some((p) => lower.includes(p));
}
