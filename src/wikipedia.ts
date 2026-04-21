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

export interface FetchResult {
  summary: WikipediaSummary | null;
  /** Raw diagnostic when the fetch failed (network error, non-2xx, etc). */
  errorReason?: string;
}

export interface FetchOptions {
  /** Per-request timeout in milliseconds. Default: 10_000. Hitting this
   *  produces an `AbortError` which the retry layer treats as transient. */
  timeoutMs?: number;
}

/** Fetch Wikipedia summary for a given article title/slug. Returns a
 *  structured result — `{summary}` on success (including 404 as
 *  `summary.missing=true`), or `{summary: null, errorReason}` on network
 *  failure or unexpected status. */
export async function fetchWikipedia(
  title: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const slug = title.replace(/ /g, "_");
  const url = `${API_BASE}/page/summary/${encodeURIComponent(slug)}?redirect=true`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "starlight-glossary (https://github.com/Wave-RF/starlight-glossary)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return {
        summary: {
          title,
          description: "",
          extract_html: "",
          url: "",
          slug,
          disambiguation: false,
          missing: true,
        },
      };
    }
    if (!res.ok) {
      return {
        summary: null,
        errorReason: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    const data = (await res.json()) as {
      title: string;
      description?: string;
      extract_html?: string;
      content_urls?: { desktop?: { page?: string } };
      type?: string;
    };
    return {
      summary: {
        title: data.title,
        description: data.description ?? "",
        extract_html: data.extract_html ?? "",
        url: data.content_urls?.desktop?.page ?? "",
        slug: data.title.replace(/ /g, "_"),
        disambiguation: data.type === "disambiguation",
        missing: false,
      },
    };
  } catch (err) {
    const e = err as Error & { name?: string };
    const reason =
      e.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : e.message ?? "unknown fetch error";
    return { summary: null, errorReason: reason };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Fetch summaries for a list of titles with a concurrency cap.
 *  Serialises per-worker so the total concurrent in-flight requests never
 *  exceeds `concurrency`. Retries transient failures (network errors, 5xx,
 *  429, timeouts) up to twice with exponential backoff. */
export async function fetchManyWikipedia(
  titles: string[],
  concurrency: number = 3,
  options: FetchOptions = {},
): Promise<Map<string, FetchResult>> {
  const out = new Map<string, FetchResult>();
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < titles.length) {
      const idx = i++;
      const title = titles[idx] as string;
      let result = await fetchWikipedia(title, options);
      let attempt = 1;
      while (
        result.summary === null &&
        result.errorReason &&
        attempt <= 2 &&
        shouldRetry(result.errorReason)
      ) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        result = await fetchWikipedia(title, options);
        attempt++;
      }
      out.set(title, result);
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  await Promise.all(workers);
  return out;
}

function shouldRetry(reason: string): boolean {
  return (
    reason.includes("fetch failed") ||
    reason.includes("ECONNRESET") ||
    reason.includes("ETIMEDOUT") ||
    reason.includes("timeout") ||
    reason.includes("429") ||
    reason.includes("500") ||
    reason.includes("502") ||
    reason.includes("503") ||
    reason.includes("504")
  );
}
