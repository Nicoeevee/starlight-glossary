import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export interface GlossaryReference {
  /** Slug the link resolved to (may be freshly-coined from the link label). */
  slug: string;
  /** Displayed text of the link, used as an alias candidate. */
  label: string;
  /** True when the slug came from the link body (no explicit slug). */
  slugFromLabel: boolean;
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
  const onReference = options.onReference;
  const slugify = options.slugify ?? defaultSlugify;

  return function transformer(tree: unknown) {
    visit(tree as Parameters<typeof visit>[0], "link", (node: unknown) => {
      const n = node as {
        url?: string;
        data?: { hProperties?: Record<string, unknown> };
      };
      const url = n.url ?? "";

      // Parse the link target. Accept three spellings.
      let explicitSlug: string | null = null;
      if (url === "glossary" || url === "glossary:") {
        explicitSlug = null; // derive from label
      } else if (url.startsWith("glossary:")) {
        const after = url.slice("glossary:".length).trim();
        explicitSlug = after.length > 0 ? after : null;
      } else {
        return; // not a glossary link, leave alone
      }

      const label = toString(n as Parameters<typeof toString>[0]).trim();
      if (!label) return;

      const slug = explicitSlug ?? slugify(label);
      if (!slug) return;

      if (onReference) {
        onReference({ slug, label, slugFromLabel: explicitSlug === null });
      }

      n.url = `${routePrefix}#${slug}`;
      n.data = n.data || {};
      n.data.hProperties = {
        ...(n.data.hProperties || {}),
        "data-glossary-term": slug,
        class:
          known && !known.has(slug)
            ? "sl-glossary-term sl-glossary-term--pending"
            : "sl-glossary-term",
      };
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
