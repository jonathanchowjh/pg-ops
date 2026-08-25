import { useState, type ReactElement } from 'react';
import { TabStrip } from '../../ui/TabStrip.js';
import { nextTab } from '../../ui/tabs.js';
import { useGlobalNav } from '../../ui/useGlobalNav.js';
import { useTerminalSize } from '../../ui/useTerminalSize.js';
import type { DrillTarget } from '../home/Home.js';
import { HomeApp } from '../home/index.js';
import { LocksApp } from '../locks/index.js';
import { SessionsApp } from '../sessions/index.js';
import type { SessionSort } from '../sessions/model.js';
import { TopApp } from '../top/index.js';
import { Placeholder } from './Placeholder.js';

/**
 * `pgops` as ONE app: one mounted view at a time, every other view one
 * keystroke away (spec §5.3–§5.6).
 *
 * This is what `HubApp` was trying to be (RULING R-P4/R-P5). `HubApp` mounted
 * one of four views and handed each an `onBack`; Task 6 deleted it. The
 * difference is ownership: the shell owns navigation *and* the chrome that
 * shows where you are, so the tab strip is built once here and passed DOWN to
 * the view as an element. Nothing flows up except one boolean.
 *
 * **The strip flows down, not up.** Each view keeps its own `StatusBar` —
 * cadence, freshness and its transient message change on every poll and are
 * per-view facts. Lifting them would mean a child firing a callback from an
 * effect into parent state that re-renders the child. So the shell hands the
 * strip down as `strip` and there is no upward path to loop through.
 *
 * `runShell` does NOT live here. All four runners live in
 * `src/commands/shell/run.tsx`, because `Shell` imports all four views and a
 * view importing `Shell` back would close an import cycle.
 */

export interface ShellProps {
  /** Credential-free target label, passed through to whichever view is mounted. */
  target?: string;
  /**
   * The view to open on. A tab name (`pgops locks` → `locks`), or nothing for
   * the cockpit. A plain string, not a `Tab` — see the state comment below.
   */
  initialTab?: string;
}

export function Shell({ target, initialTab }: ShellProps) {
  /*
   * The mounted view's NAME — a plain string, deliberately not `Tab`
   * (RULING R-P9). `D` mounts `doctor`, which is not one of the nine tabs and
   * never will be: under spec §5.2 it is a report *over* the areas rather than
   * one beside them, so it holds no digit. Modelling this as `Tab | undefined`
   * would make "no view" and "a view with no tab" the same value; forcing
   * `doctor` into the registry would give it a key it must not have.
   * `TabStrip` already renders a name that matches no tab by highlighting
   * nothing.
   */
  const [view, setView] = useState<string>(initialTab ?? 'triage');
  /*
   * The sessions sort, held HERE rather than in `SessionsApp` because it is
   * part of what a drill carries (RULING R-P5): `PANEL_DRILLS` maps the
   * cockpit's LONG-RUNNING panel to `{ view: 'sessions', sort: 'active' }`, and
   * that sort is the difference between landing on the query that has been
   * running for 41 minutes and landing on triage order. It is the shell's
   * state because only the shell knows which door you came through.
   *
   * **Only a drill writes it** (review F5). `SessionsApp` reads `initialSort`
   * once, in a `useState` initialiser, so a shell that reset the sort on every
   * view change would set `'triage'` while the mounted `SessionsApp` — which
   * does not remount when you press `2` from `sessions` — kept rendering
   * `'active'`, and the shell's state would no longer describe the screen. The
   * alternative fix, a `key` that forces the remount, would also throw away the
   * filter and the selection; keeping the screen and making the state honest is
   * the better trade.
   */
  const [sort, setSort] = useState<SessionSort>('triage');
  /*
   * "The mounted view currently owns the keyboard." Reported up by the three
   * views that can capture it (a `ConfirmModal`, or filter mode) and never
   * passed back down (RULING R-P11), so it cannot loop. `HomeApp` does not
   * report at all — it has no modal and no filter, so it could only ever say
   * `false`.
   */
  const [captured, setCaptured] = useState(false);

  /*
   * The ONE way the mounted view changes — every nav handler and the cockpit's
   * drill go through here, which is what makes the capture release below
   * impossible to forget.
   *
   * **Releasing `captured` on every view change (RULING R6-1).** The views'
   * capture effect has no unmount cleanup and `Placeholder` reports nothing, so
   * a `captured` that outlived the view that reported it would leave global nav
   * dead with no key left to revive it — every digit, `Tab`, `D` and `Esc`
   * inert, which reads as a hung app.
   *
   * That state is unreachable today, and deliberately so: the only inputs that
   * change the view are the nav keys, and capture is exactly what makes those
   * keys inert (the cockpit's drill is the one other door, and the cockpit
   * never captures). So this line cannot be observed failing — it is the
   * defence for the next view that gains a way out of itself, not for a live
   * path. A latch whose only protection is "unreachable today" is not
   * protected.
   */
  const show = (name: string) => {
    setView(name);
    setCaptured(false);
  };

  useGlobalNav({
    // The suppression rule (spec §5.5), and the highest-risk line in this file.
    // Ink fires EVERY registered `useInput` handler for a keypress, and
    // `ConfirmModal` treats any key that is not `y` as cancel — so with a kill
    // armed and this left `true`, pressing `4` would cancel the kill AND jump
    // to `top`, and the operator would not know which.
    enabled: !captured,
    onJump: (tab) => show(tab.name),
    // `view`, not a stored tab: cycling has to step from wherever you actually
    // are, including from `doctor` (which `nextTab` resolves to `triage`).
    onCycle: (dir) => show(nextTab(view, dir).name),
    onDoctor: () => show('doctor'),
    // Spec §5.6: Esc ALWAYS returns to triage. It only reaches this handler
    // when nothing is captured, so an open modal or filter dismisses first —
    // the specified ordering, for free, rather than by sequencing logic here.
    onEscape: () => show('triage'),
  });

  const terminal = useTerminalSize();
  // Built once, per render, and handed to whichever view is mounted — including
  // the placeholder, which needs it most: it is the only screen with nothing
  // else on it to tell you where you are.
  const strip = <TabStrip active={view} width={terminal.columns} />;

  const onDrill = (d: DrillTarget) => {
    // The ONLY writer of `sort` (review F5). Only the sessions drill carries
    // one — `?? 'triage'` because it is optional on that variant, and the
    // SESSIONS and CONNECTIONS panels use it to point back at triage order
    // after a LONG-RUNNING drill has left `active` behind.
    if (d.view === 'sessions') setSort(d.sort ?? 'triage');
    show(d.view);
  };

  return mount(view, {
    target,
    sort,
    strip,
    onDrill,
    // `setCaptured` is passed straight down: a `useState` setter is stable, so
    // it never re-fires the child's capture effect, and React bails out when
    // the value is unchanged.
    onCapture: setCaptured,
  });
}

interface MountProps {
  target?: string;
  sort: SessionSort;
  strip: ReactElement;
  onDrill: (d: DrillTarget) => void;
  onCapture: (captured: boolean) => void;
}

/**
 * Name → view. A bare function, not a lookup table of components: each view
 * takes a different set of props (only `sessions` takes a sort, only the
 * cockpit takes a drill), and a table would have to erase those differences to
 * hold them.
 */
function mount(view: string, p: MountProps): ReactElement {
  switch (view) {
    case 'triage':
      return <HomeApp target={p.target} strip={p.strip} onDrill={p.onDrill} />;
    case 'sessions':
      return (
        <SessionsApp target={p.target} initialSort={p.sort} strip={p.strip} onCapture={p.onCapture} />
      );
    case 'locks':
      return <LocksApp target={p.target} strip={p.strip} onCapture={p.onCapture} />;
    case 'top':
      return <TopApp target={p.target} strip={p.strip} onCapture={p.onCapture} />;
    default:
      // Every unbuilt tab, plus `doctor`. The placeholder names the phase that
      // delivers it and renders no verdict — spec §5.3.
      return <Placeholder name={view} strip={p.strip} />;
  }
}
