// Helpers for constructing and prettifying Wikipedia URLs + titles.
// Wikipedia articles look like `Transport_Layer_Security` or
// `Ansible_(software)`. Sub-sections add a fragment: `Slug#Section_Name`.
// We want URLs that match the canonical form, and display text that reads
// like natural English (underscores → spaces, fragments → chevron).

/**
 * Build a Wikipedia URL from an article slug that may contain a fragment.
 *
 *   buildWikipediaUrl("https://en.wikipedia.org/wiki/", "Transport_Layer_Security")
 *     → "https://en.wikipedia.org/wiki/Transport_Layer_Security"
 *   buildWikipediaUrl("https://en.wikipedia.org/wiki/", "Transport_Layer_Security#TLS_1.3")
 *     → "https://en.wikipedia.org/wiki/Transport_Layer_Security#TLS_1.3"
 *
 * Spaces in either the article or fragment become underscores (Wikipedia's
 * canonical form). Parentheses and other "reserved" URL chars are kept as
 * literal bytes — Wikipedia accepts them unencoded and URLs read better.
 */
export function buildWikipediaUrl(base: string, slug: string): string {
  if (!slug) return "";
  const hashIdx = slug.indexOf("#");
  let article: string;
  let fragment: string | null = null;
  if (hashIdx >= 0) {
    article = slug.slice(0, hashIdx);
    fragment = slug.slice(hashIdx + 1);
  } else {
    article = slug;
  }
  article = article.replace(/ /g, "_");
  let url = `${base}${article}`;
  if (fragment) url += `#${fragment.replace(/ /g, "_")}`;
  return url;
}

/**
 * Convert a Wikipedia slug (article with optional fragment) into a
 * human-readable string for display in tooltips and index pages.
 *
 *   prettifyWikipediaTitle("Transport_Layer_Security")            → "Transport Layer Security"
 *   prettifyWikipediaTitle("Transport_Layer_Security#TLS_1.3")    → "Transport Layer Security › TLS 1.3"
 *   prettifyWikipediaTitle("Ansible_(software)")                  → "Ansible (software)"
 *   prettifyWikipediaTitle("GitHub%20Pages")                      → "GitHub Pages"
 */
export function prettifyWikipediaTitle(slug: string): string {
  if (!slug) return "";
  return slug
    .replace(/_/g, " ")
    .replace(/#/g, " › ")
    .replace(/%20/g, " ")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%27/g, "'");
}
