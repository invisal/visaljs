// The guide's chapters, in order.
import { getCollection } from "astro:content";

export async function chapters() {
  return (await getCollection("guide")).sort((a, b) => a.data.order - b.data.order);
}

export type Chapter = Awaited<ReturnType<typeof chapters>>[number];
