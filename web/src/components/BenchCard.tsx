// A framework's card on the front page, from Kumo's LayerCard: its name on the secondary layer, and
// on the primary one each metric's rows (visaljs, Bun, Node), a bar and a value each, with a line
// between the metrics. Rendered to HTML at build time, never hydrated.
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { HardDriveIcon, MemoryIcon } from "@phosphor-icons/react";

/** A metric's `icon` names one of these. */
const ICONS = { size: HardDriveIcon, memory: MemoryIcon } as const;

export interface BenchMetric {
  title: string;
  icon: keyof typeof ICONS;
  rows: {
    label: string;
    /** formatted, or null when not measured */
    value: string | null;
    /** the bar's CSS width, a share of the largest */
    width: string | null;
  }[];
}

interface Props {
  title: string;
  href: string;
  metrics: BenchMetric[];
}

export default function BenchCard({ title, metrics }: Props) {
  return (
    <LayerCard className="p-1">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="gap-0">
        {metrics.map((m, n) => {
          const Icon = ICONS[m.icon];
          return (
            <div
              key={m.title}
              className={
                n > 0
                  ? "-mr-3 -ml-4 mt-4 border-t border-kumo-hairline pt-4 pr-3 pl-4"
                  : ""
              }
            >
              <h3 className="flex items-center gap-1.5 text-sm text-kumo-subtle">
                <Icon size={16} aria-hidden="true" />
                {m.title}
              </h3>
              <ul className="mt-3 space-y-2.5">
                {m.rows.map((r, i) => (
                  <li
                    key={r.label}
                    className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 text-sm"
                  >
                    <span
                      className={
                        i === 0
                          ? "font-semibold text-kumo-strong"
                          : "text-neutral-600"
                      }
                    >
                      {r.label}
                    </span>
                    <div className="h-2.5" aria-hidden="true">
                      {r.width && (
                        <div
                          className={`h-full min-w-1 ${i === 0 ? "bg-neutral-600" : "bg-neutral-200"}`}
                          style={{ width: r.width }}
                        />
                      )}
                    </div>
                    <span
                      className={`text-right tabular-nums ${i === 0 ? "font-semibold text-kumo-strong" : "text-kumo-default"}`}
                    >
                      {r.value ?? (
                        <span className="text-kumo-inactive italic">—</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </LayerCard.Primary>
    </LayerCard>
  );
}
