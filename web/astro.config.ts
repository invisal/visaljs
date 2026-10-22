import { satteri } from "@astrojs/markdown-satteri";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { guideCode } from "./src/lib/guide-code.ts";

// A static site: every page is built to HTML (the book from src/book/*.mdx), with code
// highlighted at build time. Kumo's React components render to HTML on the server; none of
// them is hydrated, so pages ship no React.
export default defineConfig({
  output: "static",
  // the book starts at its introduction; /book/ stays a working link to it
  redirects: { "/book": "/book/introduction/" },
  integrations: [react(), mdx({ processor: satteri({ mdastPlugins: [guideCode] }) })],
  vite: { plugins: [tailwindcss()] },
});
