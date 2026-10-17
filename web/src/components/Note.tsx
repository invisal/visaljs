// An aside in the guide, set off from the prose: something the chapter leaves for later.
import { Banner } from "@cloudflare/kumo/components/banner";
import { InfoIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export default function Note({ children }: { children: ReactNode }) {
  return (
    <Banner
      className="max-w-3xl text-base"
      icon={<InfoIcon weight="fill" size={16} />}
      // Banner sets its description in text-sm; the wrapper keeps the prose's size.
      description={<div className="text-base leading-normal">{children}</div>}
    />
  );
}
