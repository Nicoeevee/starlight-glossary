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
}

export interface LintFinding {
  term: string;
  occurrences: number;
  kind: "acronym" | "proper-noun";
  sample: string;
}

interface LintCounter {
  count: number;
  sample: string;
}

export function createLintCollector(opts: LintOptions) {
  const acronymCounts = new Map<string, LintCounter>();
  const nounCounts = new Map<string, LintCounter>();
  const { data } = opts;

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

  return {
    remarkPlugin() {
      return function transformer(tree: unknown) {
        if (!opts.enabled) return;
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
            for (const m of text.matchAll(/\b[A-Z0-9]{2,6}\b/g)) {
              const term = m[0];
              if (isKnownExact(term)) continue;
              const prev = acronymCounts.get(term);
              if (prev) prev.count++;
              else acronymCounts.set(term, { count: 1, sample: text.slice(0, 100) });
            }
            for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}\b/g)) {
              const term = m[0];
              if (isKnownCi(term)) continue;
              const prev = nounCounts.get(term);
              if (prev) prev.count++;
              else nounCounts.set(term, { count: 1, sample: text.slice(0, 100) });
            }
          },
        );
      };
    },
    findings(): LintFinding[] {
      const out: LintFinding[] = [];
      for (const [term, { count, sample }] of acronymCounts) {
        if (count >= opts.minOccurrences) {
          out.push({ term, occurrences: count, kind: "acronym", sample });
        }
      }
      for (const [term, { count, sample }] of nounCounts) {
        if (count >= opts.minOccurrences) {
          out.push({ term, occurrences: count, kind: "proper-noun", sample });
        }
      }
      out.sort((a, b) => b.occurrences - a.occurrences);
      return out;
    },
  };
}

export function renderLintReport(findings: LintFinding[]): string {
  if (findings.length === 0) {
    return "# Glossary lint\n\nNo suggestions — every candidate term is already tagged.\n";
  }
  const lines = [
    "# Glossary lint — untagged candidates",
    "",
    "Terms that appear frequently but aren't in the glossary. Consider adding",
    "them to `glossary.json`, or wrapping first mentions in `[x](glossary:)`.",
    "",
    "| Term | Occurrences | Kind |",
    "|---|---|---|",
  ];
  for (const f of findings) {
    lines.push(`| \`${f.term}\` | ${f.occurrences} | ${f.kind} |`);
  }
  lines.push("");
  return lines.join("\n");
}
