/**
 * What the person is looking at.
 *
 * The agent can read every row in the database and still not know which one
 * is on the screen. Without that, "make this one warmer" or "why is this
 * posting ranked so low" can only be answered by taking a screenshot and
 * reading it — slow, and it needs the browser for something the page
 * already knows.
 *
 * So the page says. It reports on every change and whenever it becomes
 * visible, and the report is held here in memory. Deliberately not in the
 * database: it describes a browser tab that may already be closed, and
 * stale facts that look stored are worse than no facts.
 */

export interface AppState {
  /** The open tab: jobs, applications, drafts, profile, projects, design, boards. */
  tab: string;
  /** Whatever that tab has open, by id. */
  selected: {
    job?: number | null;
    resume?: number | null;
    coverLetter?: number | null;
    /** The Design tab is editing one surface at a time. */
    surface?: string | null;
  };
}

interface Report extends AppState {
  at: number;
}

let latest: Report | null = null;

/*
  How long a report is worth repeating.

  A visible page beats every 20 seconds, so this is two missed beats and a
  little slack. Silence that long means the tab is closed, hidden, or the
  laptop is shut — and in all three the honest answer is that nobody is
  looking. The page also says goodbye when it can, which makes this the
  backstop rather than the usual path; a crashed tab or a closed lid never
  says anything.
*/
const FRESH_MS = 50_000;

export function reportState(state: AppState): void {
  latest = { ...state, at: Date.now() };
}

export interface StateAnswer {
  looking: boolean;
  tab?: string;
  selected?: AppState["selected"];
  seconds_ago?: number;
  note: string;
}

/**
 * What the agent is told. Says plainly when it does not know.
 *
 * `now` is injectable so the staleness rule can be tested without waiting a
 * minute for it.
 */
export function currentState(now: number = Date.now()): StateAnswer {
  if (!latest) {
    return {
      looking: false,
      note: "The app is not open, or has not reported yet. Ask the person rather than guessing which thing they mean.",
    };
  }

  const age = now - latest.at;
  if (age > FRESH_MS) {
    return {
      looking: false,
      seconds_ago: Math.round(age / 1000),
      note: "The last report is old, so the tab is probably closed or in the background. Treat this as nobody looking.",
    };
  }

  const chosen = Object.entries(latest.selected).filter(([, value]) => value != null);

  return {
    looking: true,
    tab: latest.tab,
    selected: latest.selected,
    seconds_ago: Math.round(age / 1000),
    note:
      chosen.length > 0
        ? `They are on the ${latest.tab} tab with ${chosen.map(([k, v]) => `${k} ${v}`).join(", ")} open. "This one" means that.`
        : `They are on the ${latest.tab} tab with nothing open in particular.`,
  };
}

/** Forget the report. Used when the page says it is going away. */
export function clearState(): void {
  latest = null;
}
