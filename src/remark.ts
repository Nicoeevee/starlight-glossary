import { visit } from "unist-util-visit";

export interface RemarkGlossaryOptions {
  /** Valid slugs in the glossary, used to warn on unknown references. */
  knownSlugs?: Set<string>;
  /** URL path prefix for the glossary index (e.g. "/glossary"). */
  routePrefix?: string;
  /** Legacy protocol to recognise as a glossary link (e.g. "glossary"
   *  matches `[x](glossary:slug)`). */
  legacyProtocol?: string;
}

/** Remark plugin: rewrite both forms of glossary link into a tagged HTML
 *  anchor that the client tooltip script recognises.
 *
 *   - `[label](/glossary#slug)` (canonical, standard markdown)
 *   - `[label](glossary:slug)`  (legacy, still accepted)
 *
 * Output:
 *   <a href="/glossary#slug" data-glossary-term="slug" class="sl-glossary-term">
 *
 * Link label is treated as display text only — it is NEVER promoted to an
 * alias. Aliases must be set explicitly in glossary.json.
 */
export default function remarkGlossary(options: RemarkGlossaryOptions = {}) {
  const routePrefix = options.routePrefix ?? "/glossary";
  const legacyProtocol = options.legacyProtocol ?? "glossary";
  const known = options.knownSlugs;

  return function transformer(tree: unknown) {
    visit(tree as Parameters<typeof visit>[0], "link", (node: unknown) => {
      const n = node as {
        url?: string;
        data?: { hProperties?: Record<string, unknown> };
      };
      const url = n.url ?? "";

      let slug: string | null = null;

      const legacy = legacyProtocol + ":";
      if (url.startsWith(legacy)) {
        slug = url.slice(legacy.length).trim();
      } else if (url.startsWith(routePrefix)) {
        const rest = url.slice(routePrefix.length);
        if (rest === "" || rest === "/") slug = "";
        else if (rest.startsWith("#")) slug = rest.slice(1);
      }

      if (slug === null) return;
      if (slug === "") return; // plain link to /glossary, no tooltip

      if (known && !known.has(slug)) {
        // Unknown slug — leave as a plain link, don't tag.
        n.url = `${routePrefix}#${slug}`;
        return;
      }

      n.url = `${routePrefix}#${slug}`;
      n.data = n.data || {};
      n.data.hProperties = {
        ...(n.data.hProperties || {}),
        "data-glossary-term": slug,
        class: "sl-glossary-term",
      };
    });
  };
}
