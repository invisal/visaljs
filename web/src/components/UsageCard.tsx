// A "How to use" card on the front page, from Kumo's LayerCard: the title on the secondary layer,
// the commands and what they do on the primary one. Rendered to HTML at build time, never hydrated.
import { LayerCard } from "@cloudflare/kumo/components/layer-card";

interface Props {
  title: string;
  /** shell commands, one per line */
  command: string;
  text: string;
}

export default function UsageCard({ title, command, text }: Props) {
  return (
    <LayerCard className="p-1">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1">
        <pre className="overflow-x-auto rounded-md border border-kumo-fill bg-kumo-elevated px-3 py-2.5 font-mono text-base text-kumo-strong">
          {command}
        </pre>
        <p className="mt-1 text-sm leading-normal text-kumo-default">{text}</p>
      </LayerCard.Primary>
    </LayerCard>
  );
}
