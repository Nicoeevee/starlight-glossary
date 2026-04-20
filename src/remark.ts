import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export interface GlossaryReference {
  /** Slug the link resolved to (may be freshly-coined from the link label). */
  slug: string;
  /** Displayed text of the link, used as an alias candidate. */
  label: string;
  /** True when the slug came from the link body (no explicit slug). */
  slugFromLabel: boolean;
  /** Wikipedia article name as it appeared in the URL (pre-slugify), so
   *  the discovery pipeline can query Wikipedia for the correct page.
   *  Empty when the reference had no explicit article part. */
  article?: string;
  /** Wikipedia-section fragment from the URL, if present
   *  (`glossary:Article#Section`). Attached to the anchor's
   *  `data-glossary-fragment` attribute and later used as an override on
   *  the tooltip's Wikipedia link. */
  fragment?: string;
}

export interface RemarkGlossaryOptions {
  /** URL path prefix for the glossary index page (e.g. "/glossary").
   *  Controls what URL the tagged `<a>` points at; does NOT affect the
   *  source syntax, which is always the `glossary:` protocol. */
  routePrefix?: string;
  /** Slugs already known to exist in the glossary. Used to distinguish
   *  references that can be rendered immediately from ones that need to
   *  go through discovery. */
  knownSlugs?: Set<string>;
  /** Map of old-slug → canonical-slug for entries that have been merged
   *  into another entry (Wikipedia redirects). Forwarding happens at
   *  render time so doc links to the old slug still resolve correctly. */
  redirects?: Map<string, string>;
  /** Called for every glossary reference found in the source. The caller
   *  collects these to (a) record alias candidates, (b) kick off Wikipedia
   *  discovery for unknown slugs. */
  onReference?: (ref: GlossaryReference) => void;
  /** Function to turn free-form text into a canonical slug (lowercase,
   *  spaces→hyphens, strip special chars). Default: simple kebab-case. */
  slugify?: (input: string) => string;
}

/** Remark plugin: handle the `glossary:` link protocol and tag each
 *  reference for the tooltip runtime.
 *
 * Recognised forms:
 *   [word](glossary:slug)    explicit slug, "word" is display text
 *   [word](glossary:)        "word" is both display and slug source
 *   [word](glossary)         same as `glossary:`
 *
 * Output (for every form):
 *   <a href="<routePrefix>#<slug>"
 *      data-glossary-term="<slug>"
 *      class="sl-glossary-term">word</a>
 *
 * Every reference is forwarded via `onReference`. Downstream pipeline
 * decides whether to auto-promote the label as an alias and/or discover
 * the slug via Wikipedia.
 */
export default function remarkGlossary(options: RemarkGlossaryOptions = {}) {
  const routePrefix = options.routePrefix ?? "/glossary";
  const known = options.knownSlugs;
  const redirects = options.redirects;
  const onReference = options.onReference;
  const slugify = options.slugify ?? defaultSlugify;

  const resolve = (slug: string): string => {
    if (!redirects) return slug;
    const seen = new Set<string>([slug]);
    let current = slug;
    while (redirects.has(current)) {
      const next = redirects.get(current) as string;
      if (seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current;
  };

  return function transformer(tree: unknown) {
    visit(tree as Parameters<typeof visit>[0], "link", (node: unknown) => {
      const n = node as {
        url?: string;
        data?: { hProperties?: Record<string, unknown> };
      };
      const url = n.url ?? "";

      // Parse the link target. Accept:
      //   glossary               — derive slug from label, no article hint
      //   glossary:              — same
      //   glossary:known-slug    — use existing glossary entry
      //   glossary:new-slug      — create new entry with this slug, query
      //                            Wikipedia using the label
      //   glossary:Article_Name  — Wikipedia article reference (slugified
      //                            for the entry slug)
      //   glossary:X#Section     — same as above with a sub-section
      //                            fragment
      //
      // Resolution order: match against known glossary slugs first; fall
      // back to the Wikipedia-article interpretation only when the slug
      // doesn't exist.  A fragment in the URL is per-reference metadata
      // either way.
      let explicitSlug: string | null = null;
      let article: string | null = null;
      let fragment: string | null = null;
      if (url === "glossary" || url === "glossary:") {
        // label-only reference
      } else if (url.startsWith("glossary:")) {
        const after = url.slice("glossary:".length).trim();
        if (after.length === 0) {
          // label-only reference
        } else {
          const hashIdx = after.indexOf("#");
          const head = hashIdx >= 0 ? after.slice(0, hashIdx) : after;
          const tail = hashIdx >= 0 ? after.slice(hashIdx + 1) : "";
          if (tail) fragment = tail;

          if (known && known.has(head)) {
            // Known glossary slug — use directly. Fragment (if any) is
            // per-reference metadata on top of the existing entry.
            explicitSlug = head;
          } else {
            // Unknown slug: treat the URL tail as the author's
            // Wikipedia-article hint for discovery. Slugify when it's in
            // PascalCase/underscore form so the stored entry still has
            // a clean kebab-case slug; otherwise use the tail as-is as
            // both slug and Wikipedia query.
            article = head;
            explicitSlug = looksLikeWikipediaArticle(head)
              ? slugify(head)
              : head;
          }
        }
      } else {
        return; // not a glossary link
      }

      const label = toString(n as Parameters<typeof toString>[0]).trim();
      if (!label) return;

      const rawSlug = explicitSlug ?? slugify(label);
      if (!rawSlug) return;
      const slug = resolve(rawSlug);

      if (onReference) {
        onReference({
          slug,
          label,
          slugFromLabel: explicitSlug === null,
          article: article ?? undefined,
          fragment: fragment ?? undefined,
        });
      }

      n.url = `${routePrefix}#${slug}`;
      n.data = n.data || {};
      const hProps: Record<string, unknown> = {
        ...(n.data.hProperties || {}),
        "data-glossary-term": slug,
        class:
          known && !known.has(slug)
            ? "sl-glossary-term sl-glossary-term--pending"
            : "sl-glossary-term",
      };
      if (fragment) hProps["data-glossary-fragment"] = fragment;
      n.data.hProperties = hProps;
    });
  };
}

/** Canonical slug: lowercase, punctuation → hyphens, collapse, trim. */
export function defaultSlugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Heuristic: a URL tail looks like a Wikipedia article title when it
 *  contains an uppercase letter (Wikipedia's PascalCase convention) or
 *  an underscore (their space-replacement), or a parenthesis. Pure
 *  lowercase-with-hyphens strings are treated as glossary slugs. */
function looksLikeWikipediaArticle(s: string): boolean {
  return /[A-Z_()]/.test(s);
}
