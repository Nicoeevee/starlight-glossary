import { z } from "astro/zod";

/** Schema for a glossary entry markdown file's frontmatter. */
export const glossarySchema = z.object({
  /** Display name shown in the popover and on the `/glossary` page. */
  term: z.string(),
  /** Alternate names listed on the index page. */
  aliases: z.array(z.string()).optional(),
  /** Wikipedia article slug (e.g. `"Ansible_(software)"`). When set, a Wikipedia link appears in the popover and the glossary page. */
  wikipedia: z.string().optional(),
});

export type GlossaryEntryData = z.infer<typeof glossarySchema>;
