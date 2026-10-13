// The guide's sidebar, from Kumo: every chapter. Rendered to HTML at build time and never
// hydrated, so it ships no JavaScript; the links are plain links. Below lg the page's own drawer
// shows it, so Kumo's mobile sheet is off (mobileBreakpoint 0).
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import {
  BinaryIcon,
  LightbulbIcon,
  MemoryIcon,
  PlusMinusIcon,
} from "@phosphor-icons/react";

/** A chapter's `icon` in its frontmatter names one of these. */
const ICONS = {
  binary: BinaryIcon,
  lightbulb: LightbulbIcon,
  memory: MemoryIcon,
  "plus-minus": PlusMinusIcon,
} as const;

interface Props {
  chapters: { id: string; title: string; icon: string; soon: boolean }[];
  /** The chapter being read. */
  current?: string | undefined;
}

export default function GuideSidebar({ chapters, current }: Props) {
  return (
    <Sidebar.Provider collapsible="none" mobileBreakpoint={0} className="h-full min-h-0!">
      <Sidebar>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>JavaScript to C</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {chapters.map((c) => (
                <Sidebar.MenuItem key={c.id}>
                  <Sidebar.MenuButton href={`/guide/${c.id}/`} active={c.id === current} icon={ICONS[c.icon as keyof typeof ICONS]}>
                    {c.title}
                    {c.soon && <span className="ml-auto text-xs text-kumo-inactive">Soon</span>}
                  </Sidebar.MenuButton>
                </Sidebar.MenuItem>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
      </Sidebar>
    </Sidebar.Provider>
  );
}
