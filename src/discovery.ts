import type { GlossaryCache, GlossaryIndex } from "./data.js";
import { fetchWikipedia } from "./wikipedia.js";

// Discovery pipeline — turns unknown slug references into glossary entries.
// For each unknown slug, ask Wikipedia with the label (or slug turned back
// into a title). Confidence gate:
//
//   exact title match        → high   → accept
//   single redirect          → medium → accept, log
//   disambiguation page      → low    → skip, warn
//   404                      → none   → skip, warn
//
// Results are merged into the index and cache; caller is responsible for
// persisting.

export interface UnresolvedReference {
  slug: string;
  /** Best label we saw for this slug across all references. */
  label: string;
  /** Locations (file:line) where the reference was seen, for logs. */
  locations: string[];
}

export interface DiscoveryReport {
  added: string[];
  ambiguous: string[];
  missing: string[];
  errored: string[];
}

export async function discoverMissingTerms(
  unresolved: UnresolvedReference[],
  index: GlossaryIndex,
  cache: GlossaryCache,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    added: [],
    ambiguous: [],
    missing: [],
    errored: [],
  };

  for (const ref of unresolved) {
    // Use the label as the Wikipedia query — it's the author's natural form.
    const summary = await fetchWikipedia(ref.label);
    if (!summary) {
      report.errored.push(ref.slug);
      logger.warn(
        `glossary discovery: network error fetching "${ref.label}" (slug ${ref.slug})`,
      );
      continue;
    }
    if (summary.missing) {
      report.missing.push(ref.slug);
      logger.warn(
        `glossary discovery: no Wikipedia article for "${ref.label}" (slug ${ref.slug})`,
      );
      continue;
    }
    if (summary.disambiguation) {
      report.ambiguous.push(ref.slug);
      logger.warn(
        `glossary discovery: "${ref.label}" hits a Wikipedia disambiguation page. ` +
          `Edit glossary.json to pick a specific article.`,
      );
      continue;
    }

    // Accept: add to index + cache. Seed aliases with the observed label,
    // the canonical Wikipedia title, and the slug itself.
    const aliases = new Set<string>();
    if (ref.label) aliases.add(ref.label);
    if (summary.title) aliases.add(summary.title);
    aliases.add(ref.slug);

    index.terms[ref.slug] = {
      term: summary.title || ref.label || ref.slug,
      aliases: Array.from(aliases),
      wikipedia: summary.slug,
      caseSensitive: looksCaseSensitive(ref.label || ref.slug),
      definition: null,
      groupWith: null,
    };
    cache.terms[ref.slug] = {
      title: summary.title,
      description: summary.description,
      extract_html: summary.extract_html,
      url: summary.url,
    };
    report.added.push(ref.slug);
    logger.info(
      `glossary discovery: added "${summary.title}" (slug ${ref.slug}) from Wikipedia`,
    );
  }

  return report;
}

/** Acronym heuristic: if the term is all-caps and has 2-6 letters,
 *  treat as case-sensitive to avoid bad auto-tag matches ("IP" vs "ip"). */
function looksCaseSensitive(label: string): boolean {
  return /^[A-Z0-9]{2,6}$/.test(label);
}
