// The book: one MDX file per chapter in src/book/, in its group, ordered by `order`.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { GROUPS } from "./lib/guide-groups.ts";

const strings = z.array(z.string());

export const collections = {
  guide: defineCollection({
    loader: glob({ pattern: "*.mdx", base: "./src/book" }),
    schema: z.object({
      title: z.string(),
      /** Its group in the sidebar, one of GROUPS in lib/guide-groups.ts; none puts it at the top. */
      group: z.enum(GROUPS).optional(),
      /** Its icon in the sidebar, a key of ICONS in GuideSidebar.tsx. */
      icon: z.string(),
      /** Its place within the group. */
      order: z.number(),
      /** Not written yet: the sidebar and the front page mark it "Soon". */
      soon: z.boolean().default(false),
      /** Where to read more: source files in the repository. */
      files: strings.default([]),
    }),
  }),
};
