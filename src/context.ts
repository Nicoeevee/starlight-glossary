// Build a JSON context dump for LLM-assisted glossary curation.
//
// Shape (see README "LLM workflow" section):
//   {
//     "version": 1,
//     "generatedAt": "…",
//     "corpus": { entries: [{ slug, term, aliases }] },
//     "findings": [{ term, kind, occurrences, contexts, wikipedia? }],
//     "autoDiscoverFailed": [{ term, reason, ... }]
//   }
//
// An LLM reads this, proposes a `resolutions.json` (one action per
// finding), and the user runs the shipped `apply.mjs` script to apply
// the resolutions to their `glossary.json`.

import type { GlossaryIndex } from "./data.js";
import type { LintFinding } from "./lint.js";

export interface LintContextFinding {
  /** The candidate term as lint saw it (e.g. "TLS", "Wave Clip"). */
  term: string;
  /** `"acronym"` (ALL-CAPS 2-6 chars) or `"proper-noun"` (capitalised
   *  multi-word phrase). Helps LLMs choose between "probably an acronym
   *  to expand" vs "probably a name to Wikipedia-search". */
  kind: "acronym" | "proper-noun";
  /** Total occurrences across all processed markdown files. */
  occurrences: number;
  /** Proposed slug (kebab-case of the term). LLMs can override this in
   *  their resolution if a different slug makes more sense. */
  proposedSlug: string;
  /** Up to ~5 sample occurrences, each with file path + ~240-char
   *  excerpt centred on the match. Use these to ground domain context. */
  contexts: Array<{ file: string; excerpt: string }>;
  /** When auto-discover tried this term and failed, describes why
   *  (disambiguation, missing article, fetch error). Absent when
   *  auto-discover wasn't run or hadn't attempted this term. */
  wikipediaOutcome?: {
    reason: "disambiguation" | "missing" | "errored";
    queryTried: string;
    expansionTried?: string;
  };
}

export interface LintContextCorpusEntry {
  slug: string;
  term: string;
  aliases: string[];
  /** Truthy when this entry has a `groupWith` or `mergedInto` — signals
   *  the LLM that it's a child/alias-of-another, so suggesting to
   *  "add_alias" here may be inappropriate. */
  relation?: "groupWith" | "mergedInto";
  relationTarget?: string;
}

export interface LintContextFile {
  version: 1;
  generatedAt: string;
  description: string;
  corpus: {
    count: number;
    entries: LintContextCorpusEntry[];
  };
  findings: LintContextFinding[];
}

export interface BuildContextInput {
  findings: LintFinding[];
  index: GlossaryIndex;
  autoDiscoverFailed?: Array<{
    term: string;
    reason: string;
    queryTried?: string;
    expansionTried?: string;
  }>;
  slugify: (input: string) => string;
}

const DESCRIPTION = [
  "Context dump for LLM-assisted glossary curation.",
  "",
  "Feed this file (or the relevant slice of it) to an LLM and ask it to",
  "produce a resolutions.json. The expected shape of that file is:",
  "",
  "  {",
  '    "version": 1,',
  '    "resolutions": [',
  "      // Add an alias to an existing entry:",
  '      { "term": "TLS", "action": "add_alias",',
  '        "targetSlug": "transport-layer-security",',
  '        "alias": "TLS" },',
  "      // Create a new entry pointing at a specific Wikipedia article:",
  '      { "term": "OSI", "action": "create",',
  '        "slug": "osi-model",',
  '        "entry": {',
  '          "term": "OSI model", "aliases": ["OSI", "OSI model"],',
  '          "wikipedia": "OSI_model", "caseSensitive": false,',
  '          "definition": null, "groupWith": null',
  "        } },",
  "      // Create a custom-definition entry with no Wikipedia:",
  '      { "term": "SOPS", "action": "create",',
  '        "slug": "sops",',
  '        "entry": {',
  '          "term": "Secrets OPerationS",',
  '          "aliases": ["SOPS", "Secrets OPerationS"],',
  '          "wikipedia": null, "caseSensitive": true,',
  '          "definition": "Mozilla secrets-management tool.",',
  '          "groupWith": null',
  "        } },",
  "      // Tell the human to suppress this one via lint.ignore:",
  '      { "term": "End Reliability", "action": "ignore",',
  '        "note": "project-internal, not a glossary term" },',
  "      // Keep as lint finding (do nothing):",
  '      { "term": "Something", "action": "skip" }',
  "    ]",
  "  }",
  "",
  "Then run: pnpm exec starlight-glossary-apply <resolutions.json>",
].join("\n");

export function buildLintContext(input: BuildContextInput): LintContextFile {
  const corpus = summariseCorpus(input.index);
  const failedByTerm = new Map(
    (input.autoDiscoverFailed ?? []).map((f) => [f.term, f]),
  );
  const findings: LintContextFinding[] = input.findings.map((f) => {
    const failure = failedByTerm.get(f.term);
    const out: LintContextFinding = {
      term: f.term,
      kind: f.kind,
      occurrences: f.occurrences,
      proposedSlug: input.slugify(f.term),
      contexts: f.samples.map((s) => ({ file: s.file, excerpt: s.excerpt })),
    };
    if (failure) {
      const r = failure.reason.toLowerCase();
      const reason: "disambiguation" | "missing" | "errored" =
        r.includes("disambig")
          ? "disambiguation"
          : r.includes("no matching") || r.includes("missing")
          ? "missing"
          : "errored";
      out.wikipediaOutcome = {
        reason,
        queryTried: failure.queryTried ?? f.term,
        ...(failure.expansionTried
          ? { expansionTried: failure.expansionTried }
          : {}),
      };
    }
    return out;
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    description: DESCRIPTION,
    corpus,
    findings,
  };
}

function summariseCorpus(index: GlossaryIndex): LintContextFile["corpus"] {
  const entries: LintContextCorpusEntry[] = [];
  for (const [slug, e] of Object.entries(index.terms)) {
    const entry: LintContextCorpusEntry = {
      slug,
      term: e.term,
      aliases: e.aliases,
    };
    if (e.mergedInto) {
      entry.relation = "mergedInto";
      entry.relationTarget = e.mergedInto;
    } else if (e.groupWith) {
      entry.relation = "groupWith";
      entry.relationTarget = e.groupWith;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  return { count: entries.length, entries };
}
