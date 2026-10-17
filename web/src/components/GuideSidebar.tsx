// The guide's sidebar, from Kumo: the ungrouped chapters, then every other chapter under its group.
// Rendered to HTML at build time and never hydrated, so it ships no JavaScript; the links are plain
// links. Below lg the page's own drawer shows it, so Kumo's mobile sheet is off (mobileBreakpoint 0).
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import {
  BinaryIcon,
  BracketsSquareIcon,
  ClockIcon,
  CubeIcon,
  DotsThreeIcon,
  FunctionIcon,
  HourglassIcon,
  LightbulbIcon,
  LightningIcon,
  MemoryIcon,
  PackageIcon,
  PauseIcon,
  PlusMinusIcon,
  PuzzlePieceIcon,
  ScissorsIcon,
  ShapesIcon,
  TextAaIcon,
  TreeStructureIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { GROUPS } from "../lib/guide-groups.ts";

/** A chapter's `icon` in its frontmatter names one of these. */
const ICONS = {
  binary: BinaryIcon,
  "brackets-square": BracketsSquareIcon,
  clock: ClockIcon,
  cube: CubeIcon,
  "dots-three": DotsThreeIcon,
  function: FunctionIcon,
  hourglass: HourglassIcon,
  lightbulb: LightbulbIcon,
  lightning: LightningIcon,
  memory: MemoryIcon,
  package: PackageIcon,
  pause: PauseIcon,
  "plus-minus": PlusMinusIcon,
  "puzzle-piece": PuzzlePieceIcon,
  scissors: ScissorsIcon,
  shapes: ShapesIcon,
  "text-aa": TextAaIcon,
  "tree-structure": TreeStructureIcon,
  warning: WarningIcon,
} as const;

type Chapter = { id: string; title: string; group?: string | undefined; icon: string; soon: boolean };

interface Props {
  chapters: Chapter[];
  /** The chapter being read. */
  current?: string | undefined;
}

export default function GuideSidebar({ chapters, current }: Props) {
  const menu = (items: Chapter[]) => (
    <Sidebar.Menu>
      {items.map((c) => (
        <Sidebar.MenuItem key={c.id}>
          <Sidebar.MenuButton href={`/guide/${c.id}/`} active={c.id === current} icon={ICONS[c.icon as keyof typeof ICONS]} className="font-normal">
            {c.title}
            {c.soon && <span className="ml-auto text-xs text-kumo-inactive">Soon</span>}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      ))}
    </Sidebar.Menu>
  );
  const groups = GROUPS.map((group) => [group, chapters.filter((c) => c.group === group)] as const).filter(([, items]) => items.length > 0);
  return (
    <Sidebar.Provider collapsible="none" mobileBreakpoint={0} className="h-full min-h-0!">
      <Sidebar>
        <Sidebar.Content>
          <Sidebar.Group>{menu(chapters.filter((c) => !c.group))}</Sidebar.Group>
          {groups.map(([group, items]) => (
            <Sidebar.Group key={group}>
              <Sidebar.GroupLabel>{group}</Sidebar.GroupLabel>
              {menu(items)}
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
      </Sidebar>
    </Sidebar.Provider>
  );
}
