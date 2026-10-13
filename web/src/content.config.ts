// The guide: one MDX file per chapter in src/guide/, ordered by `order`.
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const strings = z.array(z.string());

export const collections = {
  guide: defineCollection({
    loader: glob({ pattern: "*.mdx", base: "./src/guide" }),
    schema: z.object({
      title: z.string(),
      order: z.number(),
      /** Its icon in the sidebar, a key of ICONS in GuideSidebar.tsx. */
      icon: z.string(),
      /** Not written yet: the sidebar and the front page mark it "Soon". */
      soon: z.boolean().default(false),
      /** What the chapter's choice costs and buys; a chapter without a choice leaves them out. */
      good: strings.default([]),
      bad: strings.default([]),
      /** Where to read more: source files in the repository. */
      files: strings.default([]),
    }),
  }),
};
