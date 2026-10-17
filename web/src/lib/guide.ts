// The guide's chapters, in order: those outside any group first, then by group, then by `order`.
import { getCollection } from "astro:content";
import { GROUPS } from "./guide-groups.ts";

export async function chapters() {
  const rank = (c: Chapter) => (c.data.group ? GROUPS.indexOf(c.data.group) : -1);
  return (await getCollection("guide")).sort((a, b) => rank(a) - rank(b) || a.data.order - b.data.order);
}

export type Chapter = Awaited<ReturnType<typeof getCollection<"guide">>>[number];
