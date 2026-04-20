import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Walk a docs directory and rewrite `[label](glossary:old-slug)` links
// to `[label](glossary:new-slug)` wherever the slug matches an entry in
// the rewrites map. Non-destructive on everything else: leaves alternate
// spellings and protocol variants intact, only touches exact matches on
// `glossary:<slug>` boundaries.

export async function rewriteDocRefs(
  docsRoot: string,
  rewrites: Map<string, string>,
  logger: { warn: (m: string) => void },
): Promise<{ filesChanged: number; refsChanged: number }> {
  if (rewrites.size === 0) return { filesChanged: 0, refsChanged: 0 };

  let files: string[];
  try {
    files = await walkMdFiles(docsRoot);
  } catch (err) {
    logger.warn(`could not scan docs dir ${docsRoot}: ${(err as Error).message}`);
    return { filesChanged: 0, refsChanged: 0 };
  }

  // Pre-build a single regex matching any of the old slugs in a glossary:
  // link context. Grouping on the old slug + trailing char lets us pick
  // the new slug per match via a function.
  const escaped = Array.from(rewrites.keys()).map(escapeRegex);
  const re = new RegExp(
    `(\\]\\(glossary:)(${escaped.join("|")})(?=[#\\s)])`,
    "g",
  );

  let filesChanged = 0;
  let refsChanged = 0;
  for (const file of files) {
    let src: string;
    try {
      src = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let localChanges = 0;
    const out = src.replace(re, (_, prefix, oldSlug) => {
      const newSlug = rewrites.get(oldSlug);
      if (!newSlug) return _;
      localChanges++;
      return `${prefix}${newSlug}`;
    });
    if (localChanges > 0) {
      await writeFile(file, out, "utf8");
      filesChanged++;
      refsChanged += localChanges;
    }
  }
  return { filesChanged, refsChanged };
}

async function walkMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...(await walkMdFiles(full)));
    else if (/\.(md|mdx)$/.test(name)) out.push(full);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
