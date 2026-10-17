// The guide's groups. Their own file, so content.config.ts can import them without astro:content.

/** The sidebar's groups, in order. A chapter's `group` in its frontmatter names one of these. */
export const GROUPS = ["Values", "Memory", "Objects", "Functions", "Errors", "Async", "Dynamic code", "Making it fast", "Other"] as const;
