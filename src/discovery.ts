import type { GlossaryCache, GlossaryIndex } from "./data.js";
import {
  fetchManyWikipedia,
  fetchWikipedia,
  type FetchOptions,
} from "./wikipedia.js";

export interface WikipediaConfig {
  /** When false, no Wikipedia network calls are made. Build proceeds with
   *  whatever is in `glossary-cache.json`; missing extracts remain blank.
   *  Useful for offline / air-gapped builds. Default: true. */
  enabled?: boolean;
  /** When true, any Wikipedia error that prevented filling a known cache
   *  hole or discovering a new term throws and fails the build. Use this
   *  in CI to catch network problems early. Default: false (warnings only). */
  strict?: boolean;
  /** Per-request timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
}

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
  /** If any reference explicitly specified the Wikipedia article
   *  (`glossary:Article#Section` syntax), use it for the Wikipedia query
   *  instead of the label — gives much better discovery results for
   *  ambiguous labels like "SPF" or "A record". */
  article?: string;
  /** Locations (file:line) where the reference was seen, for logs. */
  locations: string[];
  /** Fragments seen on references to this slug, keyed by label that
   *  carried them. These become `aliasFragments` on the new entry. */
  fragmentsByLabel?: Record<string, string>;
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
  wikipedia: WikipediaConfig = {},
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    added: [],
    ambiguous: [],
    missing: [],
    errored: [],
  };

  if (wikipedia.enabled === false) {
    if (unresolved.length > 0) {
      logger.warn(
        `wikipedia.enabled=false — ${unresolved.length} unknown reference(s) will remain unresolved`,
      );
    }
    return report;
  }
  const fetchOpts: FetchOptions = { timeoutMs: wikipedia.timeoutMs };

  for (const ref of unresolved) {
    // Prefer the explicit Wikipedia article from the reference URL when
    // provided (glossary:Article#Section syntax). Fall back to the label.
    const query = ref.article || ref.label;
    const { summary, errorReason } = await fetchWikipedia(query, fetchOpts);
    if (!summary) {
      report.errored.push(ref.slug);
      logger.warn(
        `glossary discovery: ${errorReason ?? "unknown error"} fetching "${ref.label}" (slug ${ref.slug})`,
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
      ...(ref.fragmentsByLabel && Object.keys(ref.fragmentsByLabel).length > 0
        ? { aliasFragments: { ...ref.fragmentsByLabel } }
        : {}),
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

  if (wikipedia.strict && (report.errored.length > 0 || report.missing.length > 0 || report.ambiguous.length > 0)) {
    const summary = [
      report.errored.length > 0 ? `${report.errored.length} error(s)` : null,
      report.missing.length > 0 ? `${report.missing.length} missing` : null,
      report.ambiguous.length > 0
        ? `${report.ambiguous.length} ambiguous`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `wikipedia.strict: discovery had problems (${summary}). See warnings above.`,
    );
  }

  return report;
}

/** Acronym heuristic: if the term is all-caps and has 2-6 letters,
 *  treat as case-sensitive to avoid bad auto-tag matches ("IP" vs "ip"). */
function looksCaseSensitive(label: string): boolean {
  return /^[A-Z0-9]{2,6}$/.test(label);
}

/**
 * Fill cache holes — fetch Wikipedia summaries for any index entry that
 * has a `wikipedia` slug but no cached data yet (e.g. after the cache file
 * was deleted, or a new entry was hand-added to glossary.json).
 *
 * Fragments (`Article#Section`) are fetched at the article level since
 * Wikipedia's summary API doesn't surface sub-sections; the URL and title
 * displayed to users still honour the fragment via the URL helpers.
 */
export async function fillCacheHoles(
  index: GlossaryIndex,
  cache: GlossaryCache,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  wikipedia: WikipediaConfig = {},
): Promise<number> {
  const articleTitles: string[] = [];
  const slugsByArticle = new Map<string, string[]>();

  for (const [slug, entry] of Object.entries(index.terms)) {
    if (!entry.wikipedia) continue;
    if (cache.terms[slug]) continue;
    const article = entry.wikipedia.split("#")[0] as string;
    articleTitles.push(article);
    const bucket = slugsByArticle.get(article) ?? [];
    bucket.push(slug);
    slugsByArticle.set(article, bucket);
  }

  if (articleTitles.length === 0) return 0;

  if (wikipedia.enabled === false) {
    logger.warn(
      `wikipedia.enabled=false — skipping fetch for ${articleTitles.length} term(s) without cached data; tooltips will show empty bodies until you re-enable.`,
    );
    return 0;
  }

  logger.info(
    `fetching Wikipedia summaries for ${articleTitles.length} known term(s) without cached data…`,
  );

  const uniqueTitles = Array.from(new Set(articleTitles));
  const results = await fetchManyWikipedia(uniqueTitles, 3, {
    timeoutMs: wikipedia.timeoutMs,
  });

  let filled = 0;
  let errored = 0;
  let missing = 0;
  for (const [article, { summary, errorReason }] of results) {
    const slugs = slugsByArticle.get(article) ?? [];
    if (!summary) {
      errored++;
      logger.warn(
        `  fetch failed for "${article}": ${errorReason ?? "unknown error"} (slugs: ${slugs.join(", ")})`,
      );
      continue;
    }
    if (summary.missing) {
      missing++;
      logger.warn(
        `  no Wikipedia article for "${article}" (slugs: ${slugs.join(", ")})`,
      );
      continue;
    }
    for (const slug of slugs) {
      cache.terms[slug] = {
        title: summary.title,
        description: summary.description,
        extract_html: summary.extract_html,
        url: summary.url,
      };
      filled++;
    }
  }
  if (errored > 0 || missing > 0) {
    logger.info(
      `  cached ${filled} / ${results.size}; ${errored} error(s), ${missing} missing — site will build with whatever cache exists.`,
    );
    if (wikipedia.strict && errored > 0) {
      throw new Error(
        `wikipedia.strict: ${errored} fetch error(s) while filling cache holes. Set wikipedia.strict=false (or fix connectivity) to allow partial results.`,
      );
    }
  }
  return filled;
}
