import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

export interface RemarkGlossaryOptions {
  /** Valid slugs in the glossary, used to warn on unknown references. */
  knownSlugs?: Set<string>;
  /** URL path prefix for the glossary index (e.g. "/glossary"). */
  routePrefix?: string;
  /** Legacy protocol to recognise as a glossary link (e.g. "glossary"
   *  matches `[x](glossary:slug)`). */
  legacyProtocol?: string;
  /** If provided, called once per (slug, label) pair seen in the source.
   *  The plugin uses this to collect alias candidates from link labels.
   *  Labels that match the slug exactly, or exceed the max length, are
   *  filtered by the caller (not here). */
  recordAliasCandidate?: (slug: string, label: string) => void;
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
 * Labels are fed back to the caller via `recordAliasCandidate` so the plugin
 * can offer to promote them as aliases. The decision to actually promote is
 * made downstream (with length/duplicate filters).
 */
export default function remarkGlossary(options: RemarkGlossaryOptions = {}) {
  const routePrefix = options.routePrefix ?? "/glossary";
  const legacyProtocol = options.legacyProtocol ?? "glossary";
  const known = options.knownSlugs;
  const record = options.recordAliasCandidate;

  return function transformer(tree: unknown) {
    visit(tree as Parameters<typeof visit>[0], "link", (node: unknown) => {
      const n = node as {
        url?: string;
        data?: { hProperties?: Record<string, unknown> };
        children?: unknown[];
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

      if (record) {
        const label = toString(n as Parameters<typeof toString>[0]).trim();
        if (label) record(slug, label);
      }

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
