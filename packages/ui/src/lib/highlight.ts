// Lightweight, tree-shaken syntax highlighting for fenced code blocks.
//
// We import highlight.js CORE (not the full bundle) and register only a curated
// set of common languages, so the shipped bundle stays small. highlight.js
// escapes the source text itself and emits ONLY <span class="hljs-*"> wrappers
// around tokens — there is no raw HTML passthrough — so its output is safe to
// place inside the renderer's HTML string (the DOMPurify sanitize step in
// MessageRenderer keeps "class" + the hljs spans, see ALLOWED_ATTR/ALLOWED_TAGS).
//
// Token colors are themed via --hljs-* CSS variables in app.css (never hardcoded
// here), matching the existing --code-* token system.
import hljs from "highlight.js/lib/core";

import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import java from "highlight.js/lib/languages/java";
import shell from "highlight.js/lib/languages/shell";
import diff from "highlight.js/lib/languages/diff";

let registered = false;

// Common aliases → canonical language name registered above. highlight.js also
// recognizes many of these natively, but we normalize up front so the language
// class on the <code> is stable and so getLanguage() lookups are reliable.
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  py3: "python",
  sh: "bash",
  zsh: "bash",
  shell: "shell",
  console: "shell",
  html: "xml",
  svg: "xml",
  xml: "xml",
  yml: "yaml",
  md: "markdown",
  golang: "go",
  rs: "rust",
  jsonc: "json",
};

function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("shell", shell);
  hljs.registerLanguage("diff", diff);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export interface HighlightResult {
  /** HTML for the code body — hljs spans when highlighted, escaped text otherwise. */
  html: string;
  /** Canonical language name when highlighting succeeded, else null (plain fallback). */
  language: string | null;
}

// Highlight `code` for the given fenced-block language tag. Gracefully degrades
// to plain escaped text when the tag is empty/unknown or highlighting throws.
export function highlightCode(code: string, langTag: string): HighlightResult {
  const tag = (langTag || "").trim().toLowerCase();
  if (!tag) return { html: escapeHtml(code), language: null };

  ensureRegistered();

  const lang = ALIASES[tag] ?? tag;
  if (!hljs.getLanguage(lang)) {
    return { html: escapeHtml(code), language: null };
  }

  try {
    const result = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return { html: result.value, language: lang };
  } catch {
    return { html: escapeHtml(code), language: null };
  }
}
