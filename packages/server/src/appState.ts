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

/**
 * The part of a document the person has hold of on the Design tab.
 *
 * `bullet` is the stored fact; `line` is one draft's wording of it. Both
 * travel because they are edited differently, and the difference is not
 * recoverable afterwards: rewriting the fact changes every resume that
 * cites it.
 */
export interface SelectionState {
  section: string;
  field?: string;
  role?: number;
  bullet?: number;
  line?: number;
  project?: number;
  education?: number;
  skill?: number;
  prose?: number;
  /** What it says now, so "this" can be quoted back rather than guessed. */
  text?: string;
}

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
    /** The draft shown on the Design tab, when it is not the profile. */
    draft?: number | null;
    selection?: SelectionState | null;
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

  const { selection } = latest.selected;
  const chosen = Object.entries(latest.selected).filter(
    ([key, value]) => value != null && key !== "selection",
  );

  const where =
    chosen.length > 0
      ? `They are on the ${latest.tab} tab with ${chosen.map(([k, v]) => `${k} ${v}`).join(", ")} open.`
      : `They are on the ${latest.tab} tab with nothing open in particular.`;

  return {
    looking: true,
    tab: latest.tab,
    selected: latest.selected,
    seconds_ago: Math.round(age / 1000),
    note: selection ? `${where} ${describe(selection)}` : `${where} "This one" means that.`,
  };
}

/**
 * The selection, in a sentence, with the instruction that goes with it.
 *
 * Saying which ids are selected is not enough: a bullet selected on a
 * tailored draft has two of them, and editing the wrong one rewrites the
 * person's stored history instead of this draft's wording. So the note says
 * which tool to reach for, at the moment the choice arises.
 */
function describe(selection: SelectionState): string {
  const part = selection.field ? `${selection.field} of the ${selection.section}` : selection.section;
  const words = selection.text ? ` It reads: "${selection.text}".` : "";

  const ids = (
    [
      ["role", selection.role],
      ["bullet", selection.bullet],
      ["line", selection.line],
      ["project", selection.project],
      ["education", selection.education],
      ["skill", selection.skill],
      ["prose section", selection.prose],
    ] as const
  )
    .filter(([, id]) => id != null)
    .map(([name, id]) => `${name} ${id}`);

  const named = ids.length > 0 ? ` (${ids.join(", ")})` : "";

  const how =
    selection.line != null
      ? ' Change the wording with the resume line, not the stored bullet: the line is this draft only, and the bullet is the fact on every resume that cites it. Say which you are changing if they have not.'
      : selection.bullet != null
        ? " This is the stored fact itself, so changing it changes every resume that cites it."
        : "";

  return `They have selected the ${part}${named}.${words} "This" means that.${how}`;
}

/** Forget the report. Used when the page says it is going away. */
export function clearState(): void {
  latest = null;
}
