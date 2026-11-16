import { detectBoard } from "./sources/detect.js";
import { getSource, SOURCES, type SourceJob } from "./sources/index.js";
import { buildBar, scoreOf } from "./relevance.js";
import * as repo from "./repo.js";

/**
 * Bringing in a posting the person is already looking at.
 *
 * Job boards are not where people find jobs. A posting arrives through
 * LinkedIn, a newsletter, a friend — somewhere that is not the company's own
 * board — and until now the only way to get it into the list was to follow
 * the whole company and hope it came down in the sync. Hope, because the
 * relevance bar may well drop it: the bar exists to keep a board's bulk out,
 * and it cannot tell the difference between bulk and the one posting that
 * was asked for.
 *
 * So an import is explicit, and an explicit interest beats the bar. A
 * posting named by the person is stored whatever it scores. The bar is for
 * what arrives unasked.
 */

/** Where a URL points, when we can tell. */
export interface Origin {
  ats: string;
  board_token: string;
  /** The board's own id for the posting, when the URL carries one. */
  source_job_id: string | null;
}

/*
  The shapes of the boards we read. Deliberately narrow: a URL that does not
  match is reported as unknown rather than guessed at, because guessing a
  board token means following the wrong company.
*/
const SHAPES: { ats: string; pattern: RegExp }[] = [
  { ats: "greenhouse", pattern: /(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)(?:\/jobs\/(\d+))?/i },
  { ats: "greenhouse", pattern: /([^/?#.]+)\.greenhouse\.io(?:\/jobs\/(\d+))?/i },
  { ats: "lever", pattern: /jobs\.lever\.co\/([^/?#]+)(?:\/([0-9a-f-]+))?/i },
  { ats: "ashby", pattern: /jobs\.ashbyhq\.com\/([^/?#]+)(?:\/([0-9a-f-]+))?/i },
];

/** Read a posting URL. Null when it is not a board this app can poll. */
export function originOf(url: string): Origin | null {
  for (const { ats, pattern } of SHAPES) {
    const found = pattern.exec(url);
    if (found && found[1] && SOURCES[ats]) {
      return { ats, board_token: found[1], source_job_id: found[2] ?? null };
    }
  }
  return null;
}

/** Everything but the words that say nothing about which job this is. */
function normalise(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(remote|hybrid|onsite|on-site|full[- ]time|contract|us|usa|emea)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How much two titles have in common, 0 to 1.
 *
 * Dice rather than shared-over-longest. A board writes "Senior/Staff
 * Machine Learning Research Engineer, General Agents, Enterprise GenAI"
 * where LinkedIn writes "Senior Machine Learning Research Engineer, General
 * Agents" — every word of the shorter title is in the longer one, and
 * dividing by the longer one scored that 0.70 and called it unsure. Dice
 * scores it 0.82, which is what it is: the same job, described at more
 * length.
 */
function titleOverlap(a: string, b: string): number {
  const left = new Set(normalise(a).split(" ").filter(Boolean));
  const right = new Set(normalise(b).split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export interface Candidate {
  title: string;
  location: string | null;
  url: string;
  source_job_id: string;
  /** How well the title matches what was asked for, 0 to 1. */
  confidence: number;
  /** What the relevance bar makes of it, for the person's information. */
  score: number;
}

export interface ImportResult {
  /** Set when the posting was found and stored. */
  job_id?: number;
  title?: string;
  company?: string;
  url?: string;
  /** Set when the board was found but the posting was not, or not certainly. */
  candidates?: Candidate[];
  /** Whether the company's board is now followed. */
  following?: boolean;
  /**
   * The card to put in the conversation, written out so it cannot be
   * mistyped. It is an ordinary markdown link with a jobsearch: target,
   * which the app draws as a card that opens the posting.
   */
  card?: string;
  ats?: string;
  board_token?: string;
  note: string;
}

/** Confident enough to act on without asking. */
const SURE = 0.75;

export interface ImportRequest {
  /** The posting's URL, from the board or from anywhere else. */
  url?: string;
  /** The company, when the URL is not a board we read (a LinkedIn page, say). */
  company?: string;
  /** The role, as the other site titles it. */
  title?: string;
  /** Follow the company's board as well, so its other roles arrive by sync. */
  follow?: boolean;
}

/**
 * Find a posting on its company's own board and store it.
 *
 * The URL does the work when it is a board we read. When it is not — a
 * LinkedIn listing, an email, a careers page — the company name and the role
 * title are enough to find the board and look for the posting on it, which
 * is the whole point: the canonical posting is the one that can be applied
 * to, kept up to date, and matched against everything else.
 */
export async function importPosting(request: ImportRequest): Promise<ImportResult> {
  const direct = request.url ? originOf(request.url) : null;

  const origin =
    direct ??
    (request.company
      ? await detectBoard(request.company).then((found) =>
          found ? { ...found, source_job_id: null } : null,
        )
      : null);

  if (!origin) {
    return {
      note: request.company
        ? `No board found for ${request.company} on greenhouse, lever or ashby. It may post somewhere this app cannot read, in which case the posting cannot be imported — say so rather than storing a link that will never update.`
        : "That URL is not a board this app can read, and no company name was given to look one up with.",
    };
  }

  /*
    The company's name, not its board token.

    Jobs store the company as text and are tied to a followed board by that
    text, so a posting stored as "scaleai" while the company row says "Scale
    AI" is a posting that belongs to nothing — it would not be removed with
    the company and reads wrongly in the list. A board already followed
    knows its own name; otherwise the caller's name is used, and only then
    the token.
  */
  const followed = (await repo.listCompanies()).find(
    (company) => company.ats === origin.ats && company.board_token === origin.board_token,
  );
  const named = request.company ?? followed?.name;

  let board: SourceJob[];
  try {
    board = await getSource(origin.ats).fetchBoard(origin.board_token, named);
  } catch (error) {
    return {
      ats: origin.ats,
      board_token: origin.board_token,
      note: `The ${origin.ats} board "${origin.board_token}" could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const bar = await buildBar();
  const wanted = request.title ?? "";

  /*
    The board's own id first, because it is an identity rather than a
    resemblance. Only when the URL did not carry one does the title decide.
  */
  const byId =
    request.url || origin.source_job_id
      ? board.find(
          (job) =>
            job.url === request.url ||
            /*
              An adapter namespaces its ids — greenhouse stores
              "scaleai:4658162005" where the URL says "4658162005" — so the
              id from a URL is a suffix of the stored one, not equal to it.
              Matching on equality found nothing and fell through to the
              title, for a URL that named the posting outright.
            */
            (origin.source_job_id !== null &&
              (job.sourceJobId === origin.source_job_id ||
                job.sourceJobId.endsWith(`:${origin.source_job_id}`))),
        )
      : undefined;

  const ranked: Candidate[] = board
    .map((job) => ({
      title: job.title,
      location: job.location,
      url: job.url,
      source_job_id: job.sourceJobId,
      confidence: byId && job.sourceJobId === byId.sourceJobId ? 1 : titleOverlap(wanted, job.title),
      score: scoreOf(bar, job),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  /*
    Sure means two things: a good enough match, and a clear winner. Two
    postings a hair apart are two plausible jobs — "Senior" and "Staff" of
    the same role, say — and picking between them is the person's call.
  */
  const best = ranked[0];
  const clearWinner = best && best.confidence - (ranked[1]?.confidence ?? 0) >= 0.05;
  const chosen =
    byId ??
    (best && best.confidence >= SURE && clearWinner
      ? board.find((job) => job.sourceJobId === best.source_job_id)
      : undefined);

  if (!chosen) {
    /*
      Not sure, so nothing is stored. Tracking the wrong posting is worse
      than asking: it puts a role the person never looked at into their
      applications, under a company they do intend to apply to.
    */
    return {
      ats: origin.ats,
      board_token: origin.board_token,
      candidates: ranked.slice(0, 5),
      note: wanted
        ? `The board was found but no posting on it clearly matches "${wanted}". Show these candidates and ask which one, or say none of them fit.`
        : "The board was found. No title was given to match against, so ask which of these postings is meant.",
    };
  }

  // Stored whatever it scores: it was asked for by name.
  await repo.upsertJobs([chosen]);
  const stored = await repo.findJob(chosen.source, chosen.sourceJobId);

  let following = false;
  if (request.follow) {
    await repo.addCompany(chosen.company, origin.ats, origin.board_token);
    following = true;
  }

  const score = scoreOf(bar, chosen);
  const card = stored ? `[${chosen.title} — ${chosen.company}](jobsearch:job/${stored.id})` : undefined;

  return {
    card,
    job_id: stored?.id,
    title: chosen.title,
    company: chosen.company,
    url: chosen.url,
    ats: origin.ats,
    board_token: origin.board_token,
    following,
    note:
      `Stored "${chosen.title}" at ${chosen.company}. It scores ${score} against the profile` +
      (score < bar.threshold
        ? `, below the bar of ${bar.threshold} — it was kept because it was asked for, and a sync would not have brought it in.`
        : ".") +
      (following
        ? ` Now following the ${origin.ats} board "${origin.board_token}"; run sync_boards to bring in its other matching roles.`
        : ` The board is not followed. Offer to follow it: ${origin.ats}/${origin.board_token}.`) +
      " End your reply with the card above, copied exactly, so they can open it.",
  };
}
