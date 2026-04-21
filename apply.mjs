#!/usr/bin/env node
// starlight-glossary-apply — applies an LLM-produced resolutions file to
// glossary.json.
//
// Usage:
//   pnpm exec starlight-glossary-apply <resolutions.json> [--glossary glossary.json] [--dry-run]
//
// The resolutions file shape is documented in
// .astro/glossary-lint-context.json under `description`. Each entry
// chooses one action:
//   add_alias   — push alias onto an existing entry's `aliases` list
//   create      — add a brand new entry at `slug` with a full entry object
//   ignore      — prints a "consider adding to lint.ignore in astro.config"
//                 reminder; does not mutate glossary.json or your config
//   skip        — no-op; keeps the term in future lint runs
//
// Writes are atomic (tmp file + rename) so a crashed invocation can't
// corrupt the source glossary.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { resolutions: null, glossary: "glossary.json", dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--glossary") args.glossary = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else rest.push(a);
  }
  if (rest.length > 0) args.resolutions = rest[0];
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "starlight-glossary-apply — apply LLM-produced resolutions to glossary.json",
      "",
      "Usage:",
      "  starlight-glossary-apply <resolutions.json> [options]",
      "",
      "Options:",
      "  --glossary <path>   Path to glossary.json (default: ./glossary.json)",
      "  --dry-run, -n       Print planned actions without writing",
      "  --help, -h          Show this help",
      "",
      "Resolutions file shape: see .astro/glossary-lint-context.json",
      "(the `description` field documents the expected JSON shape).",
      "",
    ].join("\n"),
  );
}

async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

function validateIndex(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${source}: root must be a JSON object`);
  if (!raw.terms || typeof raw.terms !== "object" || Array.isArray(raw.terms))
    throw new Error(`${source}: missing or invalid "terms" object`);
}

function validateResolutions(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${source}: root must be a JSON object`);
  if (!Array.isArray(raw.resolutions))
    throw new Error(`${source}: "resolutions" must be an array`);
}

function applyResolution(index, r, result) {
  const term = r.term ?? "?";
  switch (r.action) {
    case "add_alias": {
      const target = index.terms[r.targetSlug];
      if (!target) {
        result.warnings.push(
          `[${term}] add_alias: targetSlug "${r.targetSlug}" does not exist`,
        );
        return;
      }
      if (target.mergedInto) {
        result.warnings.push(
          `[${term}] add_alias: "${r.targetSlug}" is a merged stub — adding alias to the canonical target "${target.mergedInto}" instead`,
        );
        const canonical = index.terms[target.mergedInto];
        if (!canonical) {
          result.warnings.push(
            `[${term}] add_alias: canonical "${target.mergedInto}" also missing; skipped`,
          );
          return;
        }
        if (!canonical.aliases.includes(r.alias)) {
          canonical.aliases.push(r.alias);
          result.aliased.push({
            term,
            slug: target.mergedInto,
            alias: r.alias,
          });
        }
        return;
      }
      if (!Array.isArray(target.aliases))
        throw new Error(`[${term}] add_alias: target has no aliases array`);
      if (target.aliases.includes(r.alias)) {
        result.warnings.push(
          `[${term}] add_alias: "${r.alias}" already an alias of "${r.targetSlug}" — no change`,
        );
        return;
      }
      target.aliases.push(r.alias);
      result.aliased.push({ term, slug: r.targetSlug, alias: r.alias });
      return;
    }
    case "create": {
      if (!r.slug || typeof r.slug !== "string")
        throw new Error(`[${term}] create: missing or invalid "slug"`);
      if (!r.entry || typeof r.entry !== "object")
        throw new Error(`[${term}] create: missing "entry" object`);
      if (index.terms[r.slug]) {
        result.warnings.push(
          `[${term}] create: slug "${r.slug}" already exists — skipped`,
        );
        return;
      }
      // Fill in defaults so the entry is schema-complete without asking
      // the LLM to spell out every optional field.
      const entry = {
        term: r.entry.term ?? term,
        aliases: Array.isArray(r.entry.aliases) ? r.entry.aliases : [term],
        wikipedia:
          r.entry.wikipedia === undefined ? null : r.entry.wikipedia,
        caseSensitive: r.entry.caseSensitive ?? false,
        definition:
          r.entry.definition === undefined ? null : r.entry.definition,
        groupWith: r.entry.groupWith ?? null,
      };
      if (r.entry.aliasFragments) entry.aliasFragments = r.entry.aliasFragments;
      if (r.entry.wikipediaRedirectAcknowledged)
        entry.wikipediaRedirectAcknowledged =
          r.entry.wikipediaRedirectAcknowledged;
      index.terms[r.slug] = entry;
      result.created.push({ term, slug: r.slug, entry });
      return;
    }
    case "ignore": {
      result.toIgnore.push({ term, note: r.note ?? "" });
      return;
    }
    case "skip": {
      result.skipped.push({ term });
      return;
    }
    default:
      throw new Error(
        `[${term}] unknown action "${r.action}" (expected add_alias | create | ignore | skip)`,
      );
  }
}

function printSummary(result, { dryRun }) {
  const tag = dryRun ? "[dry-run] would " : "";
  if (result.created.length > 0) {
    process.stdout.write(
      `${tag}create ${result.created.length} new entry/entries:\n`,
    );
    for (const c of result.created) {
      process.stdout.write(
        `  · ${c.slug}: "${c.entry.term}"${c.entry.wikipedia ? ` → ${c.entry.wikipedia}` : ""}\n`,
      );
    }
  }
  if (result.aliased.length > 0) {
    process.stdout.write(
      `${tag}add ${result.aliased.length} alias(es):\n`,
    );
    for (const a of result.aliased) {
      process.stdout.write(`  · ${a.slug} ← "${a.alias}"\n`);
    }
  }
  if (result.skipped.length > 0) {
    process.stdout.write(
      `skip ${result.skipped.length} term(s) (will resurface in next lint):\n`,
    );
    for (const s of result.skipped) process.stdout.write(`  · ${s.term}\n`);
  }
  if (result.toIgnore.length > 0) {
    process.stdout.write(
      `lint.ignore reminder — add these to your astro.config.mjs:\n`,
    );
    for (const i of result.toIgnore) {
      const note = i.note ? ` // ${i.note}` : "";
      process.stdout.write(`  "${i.term}",${note}\n`);
    }
  }
  if (result.warnings.length > 0) {
    process.stdout.write(`\nwarnings:\n`);
    for (const w of result.warnings) process.stdout.write(`  · ${w}\n`);
  }
  const total =
    result.created.length + result.aliased.length + result.skipped.length;
  process.stdout.write(
    `\n${tag}summary: ${result.created.length} created, ${result.aliased.length} aliased, ${result.skipped.length} skipped, ${result.toIgnore.length} flagged for lint.ignore, ${result.warnings.length} warning(s) (${total} total actions).\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.resolutions) {
    process.stderr.write(
      "error: missing <resolutions.json> argument\n\n",
    );
    printHelp();
    process.exit(2);
  }

  const resolutionsPath = resolve(process.cwd(), args.resolutions);
  const glossaryPath = resolve(process.cwd(), args.glossary);

  const [resolutionsRaw, glossaryRaw] = await Promise.all([
    readFile(resolutionsPath, "utf8"),
    readFile(glossaryPath, "utf8"),
  ]);
  const resolutions = JSON.parse(resolutionsRaw);
  const index = JSON.parse(glossaryRaw);
  validateResolutions(resolutions, resolutionsPath);
  validateIndex(index, glossaryPath);

  const result = {
    created: [],
    aliased: [],
    skipped: [],
    toIgnore: [],
    warnings: [],
  };
  for (const r of resolutions.resolutions) {
    try {
      applyResolution(index, r, result);
    } catch (err) {
      result.warnings.push(err.message ?? String(err));
    }
  }

  if (!args.dryRun) {
    await writeJsonAtomic(glossaryPath, index);
  }
  printSummary(result, { dryRun: args.dryRun });
}

main().catch((err) => {
  process.stderr.write(`starlight-glossary-apply: ${err.message ?? err}\n`);
  process.exit(1);
});
