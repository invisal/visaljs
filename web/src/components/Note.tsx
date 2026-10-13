// An aside in the guide, set off from the prose: something the chapter leaves for later.
import { Banner } from "@cloudflare/kumo/components/banner";
import { InfoIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export default function Note({ children }: { children: ReactNode }) {
  return <Banner className="max-w-3xl" icon={<InfoIcon weight="fill" size={20} />} description={children} />;
}
