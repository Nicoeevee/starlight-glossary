import { visit, SKIP } from "unist-util-visit";
import type { GlossaryData } from "./data.js";

// Optional pass — scan text nodes that survived auto-tagging and suggest
// likely-glossary candidates. Currently two heuristics:
//   1. ALL-CAPS acronyms 2–6 letters, appearing ≥ minOccurrences times
//   2. Capitalized proper nouns of 2+ words, appearing ≥ minOccurrences times

export interface LintOptions {
  enabled: boolean;
  minOccurrences: number;
  data: GlossaryData;
  /** Terms to skip in lint output, even if they'd otherwise pass the
   *  heuristics. Supports:
   *   - exact strings (case-insensitive): `"US"` skips the two-letter
   *     country abbreviation
   *   - RegExp: `/^\d+$/` skips any all-digit "acronym"
   *  Matched against the candidate term (not the surrounding text). */
  ignore?: (string | RegExp)[];
}

export interface LintOccurrence {
  /** Source file path (relative to project root when available). */
  file: string;
  /** ~200-char window centred on the match; used as LLM input for
   *  deciding what the term refers to in this project's domain. */
  excerpt: string;
}

export interface LintFinding {
  term: string;
  occurrences: number;
  kind: "acronym" | "proper-noun";
  /** First-seen excerpt — kept for backwards compat with renderLintReport. */
  sample: string;
  /** Up to N sample occurrences with file + surrounding text, collected
   *  for the LLM context dump. `[]` when no occurrences were captured
   *  (e.g. because the match was in a file with no path info). */
  samples: LintOccurrence[];
}

interface LintCounter {
  count: number;
  sample: string;
  samples: LintOccurrence[];
}

/** How many per-term occurrences to capture (file + excerpt) for the
 *  LLM context dump. Higher values give LLMs more signal but bloat the
 *  context file. 5 feels like a reasonable sweet spot. */
const MAX_SAMPLES_PER_TERM = 5;

/** Width of the excerpt window on each side of a match. Wide enough to
 *  span a full sentence; narrow enough to keep the context file small. */
const EXCERPT_HALF_WIDTH = 120;

function captureOccurrence(
  counter: LintCounter,
  file: string | undefined,
  text: string,
  matchIndex: number,
  matchLength: number,
): void {
  counter.count++;
  if (counter.samples.length >= MAX_SAMPLES_PER_TERM) return;
  const start = Math.max(0, matchIndex - EXCERPT_HALF_WIDTH);
  const end = Math.min(
    text.length,
    matchIndex + matchLength + EXCERPT_HALF_WIDTH,
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  counter.samples.push({
    file: file ?? "(unknown)",
    excerpt: prefix + text.slice(start, end) + suffix,
  });
}

// Baseline list of ALL-CAPS words that look like acronyms but almost
// never are — short function words, annotations, and common
// two-letter emphasis words. Users can extend or replace the effective
// suppression list via `lint.ignore`.
const COMMON_CAPS_WORDS = new Set([
  // conjunctions / articles / prepositions shouted for emphasis
  "NOT", "OK", "YES", "NO", "ONLY", "ETC", "AND", "OR", "BUT", "FOR",
  "THE", "A", "AN", "IS", "ARE", "WAS", "WERE", "BE", "TO", "IN", "ON",
  "AT", "BY", "OF", "IF", "IT", "AS", "ALL", "NEW", "OLD", "GOOD", "BAD",
  "SO", "THAN", "THEN", "VS",
  // inline markers
  "TODO", "FIXME", "NOTE", "NOTES", "WARNING", "WIP", "HACK", "XXX",
  // generic two/three-letter abbreviations too common to be domain terms
  // — keep as a minimum baseline; users can still opt them back IN via
  // glossary.json if they're actually relevant to their corpus.
  "US", "UK", "EU",
]);

export function createLintCollector(opts: LintOptions) {
  const acronymCounts = new Map<string, LintCounter>();
  const nounCounts = new Map<string, LintCounter>();
  const { data } = opts;
  const ignorePatterns = opts.ignore ?? [];

  const isIgnored = (term: string): boolean => {
    const lower = term.toLowerCase();
    for (const p of ignorePatterns) {
      if (typeof p === "string") {
        if (p.toLowerCase() === lower) return true;
      } else {
        if (p.test(term)) return true;
      }
    }
    return false;
  };

  const isKnownExact = (term: string): boolean => {
    for (const entry of Object.values(data.terms)) {
      for (const alias of entry.aliases) {
        if (alias === term) return true;
      }
    }
    return false;
  };
  const isKnownCi = (term: string): boolean => {
    const lower = term.toLowerCase();
    for (const entry of Object.values(data.terms)) {
      for (const alias of entry.aliases) {
        if (alias.toLowerCase() === lower) return true;
      }
    }
    return false;
  };

  // Plugin factory — unified calls this with options; returns the
  // transformer. The closure captures the shared counters so state
  // accumulates across all files in the build.
  function remarkPlugin() {
    return function transformer(tree: unknown, file?: unknown) {
      if (!opts.enabled) return;
      // Pull the source file path from the vfile (Astro sets this on the
      // VFile it hands to each remark pass). We normalise to a path
      // relative to cwd so excerpts in the context file are portable.
      const filePath = extractFilePath(file);
      visit(
        tree as Parameters<typeof visit>[0],
        (node: unknown) => {
          const n = node as { type: string; value?: string };
          if (
            n.type === "code" ||
            n.type === "inlineCode" ||
            n.type === "heading" ||
            n.type === "link" ||
            n.type === "html"
          ) {
            return SKIP;
          }
          if (n.type !== "text" || !n.value) return;
          const text = n.value;
          // Acronyms: 2–6 chars, must start with a letter (exclude "21", "256").
          for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}\b/g)) {
            const term = m[0];
            if (isKnownExact(term)) continue;
            // Skip common English words that happen to be ALL CAPS for
            // emphasis: NOT, OK, YES, NO, ONLY, ETC, etc.
            if (COMMON_CAPS_WORDS.has(term)) continue;
            if (isIgnored(term)) continue;
            let counter = acronymCounts.get(term);
            if (!counter) {
              counter = {
                count: 0,
                sample: text.slice(0, 100),
                samples: [],
              };
              acronymCounts.set(term, counter);
            }
            captureOccurrence(counter, filePath, text, m.index ?? 0, term.length);
          }
          for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}\b/g)) {
            // Strip leading capitalized "stop words" (sentence starters
            // and demonstratives) so "The Widget Factory" is counted as
            // "Widget Factory" — otherwise we'd see N variants like
            // "The Widget Factory", "Each Widget Factory", "A Widget Factory" each at
            // count 1 and never reach minOccurrences.
            const term = stripLeadingStopWords(m[0]);
            if (!term) continue;
            // After stripping the lead, require ≥ 2 words. A bare
            // capitalized word like "Wikipedia" alone gets ignored
            // (too noisy in prose); two-word minimum aligns with the
            // original heuristic intent.
            if (!term.includes(" ")) continue;
            if (isKnownCi(term)) continue;
            if (isIgnored(term)) continue;
            let counter = nounCounts.get(term);
            if (!counter) {
              counter = {
                count: 0,
                sample: text.slice(0, 100),
                samples: [],
              };
              nounCounts.set(term, counter);
            }
            // Recompute the match offset in the original text (we may
            // have stripped leading stop-words so m[0] is longer than
            // `term`). Find the stripped form inside the match.
            const offsetInMatch = m[0].length - term.length;
            const absIndex = (m.index ?? 0) + offsetInMatch;
            captureOccurrence(counter, filePath, text, absIndex, term.length);
          }
        },
      );
    };
  }

  function extractFilePath(file: unknown): string | undefined {
    if (!file || typeof file !== "object") return undefined;
    const f = file as { path?: string; history?: string[] };
    const raw = f.path ?? f.history?.[f.history.length - 1];
    if (!raw) return undefined;
    // Normalise to a cwd-relative path when possible; fall back to the
    // raw absolute path if we can't compute one cleanly.
    try {
      const cwd = process.cwd();
      if (raw.startsWith(cwd + "/")) return raw.slice(cwd.length + 1);
    } catch {
      /* no cwd available (edge cases in sandboxes) — fall through */
    }
    return raw;
  }

  return {
    remarkPlugin,
    findings(): LintFinding[] {
      const out: LintFinding[] = [];
      for (const [term, { count, sample, samples }] of acronymCounts) {
        if (count >= opts.minOccurrences) {
          out.push({
            term,
            occurrences: count,
            kind: "acronym",
            sample,
            samples,
          });
        }
      }
      for (const [term, { count, sample, samples }] of nounCounts) {
        if (count >= opts.minOccurrences) {
          out.push({
            term,
            occurrences: count,
            kind: "proper-noun",
            sample,
            samples,
          });
        }
      }
      out.sort((a, b) => b.occurrences - a.occurrences);
      return out;
    },
  };
}

// Capitalized words that look like proper nouns at sentence starts but
// are functionally articles/demonstratives/quantifiers. Strip them from
// the leading edge of multi-word matches so we count the real noun.
const LEADING_STOP_WORDS = new Set([
  "The",
  "A",
  "An",
  "This",
  "That",
  "These",
  "Those",
  "Each",
  "Every",
  "Some",
  "Many",
  "Most",
  "Any",
  "Our",
  "Their",
  "Its",
  "His",
  "Her",
  "Another",
  "Both",
  "Either",
  "Neither",
  "All",
  "Few",
  "Several",
]);

function stripLeadingStopWords(phrase: string): string {
  const parts = phrase.split(/\s+/);
  let i = 0;
  while (i < parts.length && LEADING_STOP_WORDS.has(parts[i]!)) i++;
  return parts.slice(i).join(" ");
}

export interface AutoDiscoveredTerm {
  slug: string;
  title: string;
  description: string;
  url: string;
}

export interface RenderLintReportExtras {
  /** Terms auto-added via Wikipedia in this build (when lint.autoDiscover
   *  is enabled). Rendered as a separate section so the user can audit
   *  what the plugin committed on their behalf. */
  autoDiscovered?: AutoDiscoveredTerm[];
  /** Stub entries created from `lint.acronymExpansions` when no
   *  Wikipedia article was found. Each has the expanded form as the
   *  term and a null `definition` waiting for the user to fill in. */
  autoStubbed?: Array<{ slug: string; term: string; acronym: string }>;
  /** Terms submitted to auto-discover but rejected (disambiguation,
   *  404, or fetch error). Kept separately so the user can either add
   *  them manually with a disambiguated article hint or suppress them
   *  via `lint.ignore`. */
  autoDiscoverFailed?: Array<{ term: string; reason: string }>;
}

export function renderLintReport(
  findings: LintFinding[],
  extras: RenderLintReportExtras = {},
): string {
  const sections: string[] = [];

  if (extras.autoDiscovered && extras.autoDiscovered.length > 0) {
    sections.push(
      "# Auto-added this build",
      "",
      "These terms were detected by lint and resolved to an unambiguous",
      "Wikipedia article, so they were added to `glossary.json` + cache.",
      "Review each one to confirm the match is what you intended — if not,",
      "edit the entry in `glossary.json` or revert the commit.",
      "",
      "| Term | One-liner | Wikipedia |",
      "|---|---|---|",
    );
    for (const t of extras.autoDiscovered) {
      const link = t.url ? `[${t.title}](${t.url})` : t.title;
      const desc = t.description.replace(/\|/g, "\\|");
      sections.push(`| \`${t.slug}\` | ${desc || "—"} | ${link} |`);
    }
    sections.push("");
  }

  if (extras.autoStubbed && extras.autoStubbed.length > 0) {
    sections.push(
      "# Auto-stubbed (no Wikipedia article)",
      "",
      "These acronyms had a configured expansion in `lint.acronymExpansions`",
      "but no matching Wikipedia article. A stub entry was created with the",
      "expansion as the `term` and the acronym as an alias. Fill in",
      "`definition` in `glossary.json` to complete each stub.",
      "",
      "| Acronym | Stub term | Slug |",
      "|---|---|---|",
    );
    for (const s of extras.autoStubbed) {
      sections.push(`| \`${s.acronym}\` | ${s.term} | \`${s.slug}\` |`);
    }
    sections.push("");
  }

  if (extras.autoDiscoverFailed && extras.autoDiscoverFailed.length > 0) {
    sections.push(
      "# Auto-discover failed",
      "",
      "These terms were detected by lint but Wikipedia couldn't resolve",
      "them cleanly. Add them manually (with an explicit article hint via",
      "`glossary:Article_Name` in your docs), or add them to `lint.ignore`",
      "if they aren't glossary candidates.",
      "",
      "| Term | Reason |",
      "|---|---|",
    );
    for (const f of extras.autoDiscoverFailed) {
      sections.push(`| \`${f.term}\` | ${f.reason} |`);
    }
    sections.push("");
  }

  if (findings.length === 0) {
    if (sections.length === 0) {
      return "# Glossary lint\n\nNo suggestions — every candidate term is already tagged.\n";
    }
    sections.push(
      "# Still untagged",
      "",
      "No remaining untagged candidates.",
      "",
    );
    return sections.join("\n");
  }

  sections.push(
    "# Still untagged candidates",
    "",
    "Terms that appear frequently but aren't in the glossary. Consider adding",
    "them to `glossary.json`, or wrapping first mentions in `[x](glossary:)`.",
    "",
    "| Term | Occurrences | Kind |",
    "|---|---|---|",
  );
  for (const f of findings) {
    sections.push(`| \`${f.term}\` | ${f.occurrences} | ${f.kind} |`);
  }
  sections.push("");
  return sections.join("\n");
}
