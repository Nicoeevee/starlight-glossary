import { visit } from "unist-util-visit";

export interface RemarkGlossaryOptions {
  collection?: string;
  /** URL protocol that identifies glossary links. Default: `"glossary"`. */
  linkProtocol?: string;
  /** Route prefix for the glossary index. Default: `"/glossary"`. */
  routePrefix?: string;
}

/**
 * Remark plugin: rewrite `[label](glossary:slug)` into a link that
 *   - navigates to `<routePrefix>#slug` on click (works without JS),
 *   - is tagged `data-glossary-term="slug"` + class `sl-glossary-term`
 *     so the client tooltip can show a rich popover on hover/tap.
 */
export default function remarkGlossary(options: RemarkGlossaryOptions = {}) {
  const linkProtocol = options.linkProtocol ?? "glossary";
  const routePrefix = options.routePrefix ?? "/glossary";
  const prefix = `${linkProtocol}:`;

  return function transformer(tree: unknown) {
    visit(tree as Parameters<typeof visit>[0], "link", (node: unknown) => {
      const n = node as {
        url?: string;
        data?: { hProperties?: Record<string, unknown> };
      };
      const url = n.url ?? "";
      if (!url.startsWith(prefix)) return;
      const slug = url.slice(prefix.length).trim();
      if (!slug) return;

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
