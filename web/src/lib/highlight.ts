// Syntax highlighting at build time (Shiki, VS Code's grammars): a code block becomes lines of
// colored tokens, so the page ships HTML and no highlighter. The site is light mode only.
import { createHighlighter } from "shiki";

export type Lang = "c" | "javascript" | "text";

export interface Token {
  content: string;
  color?: string | undefined;
}

const THEME = "github-light-default";
const highlighter = await createHighlighter({ themes: [THEME], langs: ["c", "javascript"] });

/** One array of tokens per line. */
export function highlight(code: string, lang: Lang): Token[][] {
  if (lang === "text") return code.split("\n").map((content) => [{ content }]);
  return highlighter.codeToTokens(code, { lang, theme: THEME }).tokens.map((line) => line.map(({ content, color }) => ({ content, color })));
}

/** A code block's label says what it holds. */
export function langOf(label: string): Lang {
  if (label.startsWith("JavaScript")) return "javascript";
  return "c";
}
