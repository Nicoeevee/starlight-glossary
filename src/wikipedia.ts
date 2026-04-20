// Tiny Wikipedia REST API client. Rate-limited and redirect-aware.
// Used by the CLI for `add` / `refresh` commands and (optionally) by the
// build-time auto-discovery pipeline.

export interface WikipediaSummary {
  /** Canonical article title after redirects. */
  title: string;
  /** Wikipedia "description" string — short, one-line summary. */
  description: string;
  /** First paragraph(s) of the article as HTML. */
  extract_html: string;
  /** Full article URL. */
  url: string;
  /** Article slug (title with spaces replaced by underscores). */
  slug: string;
  /** True iff the API returned a disambiguation page. */
  disambiguation: boolean;
  /** True iff no article was found (404). */
  missing: boolean;
}

const API_BASE = "https://en.wikipedia.org/api/rest_v1";

/** Fetch Wikipedia summary for a given article title/slug. Returns null on
 *  network error. Sets `missing:true` on 404 and `disambiguation:true` when
 *  the API indicates a disambiguation page. */
export async function fetchWikipedia(
  title: string,
): Promise<WikipediaSummary | null> {
  const slug = title.replace(/ /g, "_");
  const url = `${API_BASE}/page/summary/${encodeURIComponent(slug)}?redirect=true`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "starlight-glossary (https://github.com/Wave-RF/starlight-glossary)",
        Accept: "application/json",
      },
    });
    if (res.status === 404) {
      return {
        title,
        description: "",
        extract_html: "",
        url: "",
        slug,
        disambiguation: false,
        missing: true,
      };
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title: string;
      description?: string;
      extract_html?: string;
      content_urls?: { desktop?: { page?: string } };
      type?: string;
    };
    return {
      title: data.title,
      description: data.description ?? "",
      extract_html: data.extract_html ?? "",
      url: data.content_urls?.desktop?.page ?? "",
      slug: data.title.replace(/ /g, "_"),
      disambiguation: data.type === "disambiguation",
      missing: false,
    };
  } catch {
    return null;
  }
}

/** Fetch summaries for a list of titles with a concurrency cap. */
export async function fetchManyWikipedia(
  titles: string[],
  concurrency: number = 6,
): Promise<Map<string, WikipediaSummary | null>> {
  const out = new Map<string, WikipediaSummary | null>();
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < titles.length) {
      const idx = i++;
      const title = titles[idx] as string;
      out.set(title, await fetchWikipedia(title));
      await new Promise((r) => setTimeout(r, 80));
    }
  });
  await Promise.all(workers);
  return out;
}
