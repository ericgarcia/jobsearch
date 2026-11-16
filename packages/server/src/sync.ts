import { getSource } from "./sources/index.js";
import { listCompanies, upsertJobs, type CompanyRow } from "./repo.js";
import { buildBar, cannotJudge, clears, type Bar } from "./relevance.js";

export interface SyncReport {
  company: string;
  ats: string;
  /** Postings on the board. */
  seen: number;
  /** Of those, the ones worth the person's attention. */
  kept: number;
  /** Of those, the ones not already stored. */
  inserted: number;
  error?: string;
}

/**
 * Poll one board and write what is worth keeping.
 *
 * A board is the company's list, not the person's. Following one used to
 * mean storing all of it — four figures of postings for a large company,
 * almost none of them anything this person would read. What is stored now
 * is what passes the same bar evaluate_companies reports against.
 *
 * Never throws; failures are reported.
 */
async function syncCompany(company: CompanyRow, bar: Bar): Promise<SyncReport> {
  try {
    const source = getSource(company.ats);
    const jobs = await source.fetchBoard(company.board_token, company.name);
    const wanted = jobs.filter((job) => clears(bar, job));
    const { inserted } = await upsertJobs(wanted);
    return {
      company: company.name,
      ats: company.ats,
      seen: jobs.length,
      kept: wanted.length,
      inserted,
    };
  } catch (error) {
    return {
      company: company.name,
      ats: company.ats,
      seen: 0,
      kept: 0,
      inserted: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Poll every active board, four at a time. One slow or broken board does not
 * stop the rest.
 */
export interface SyncOutcome {
  reports: SyncReport[];
  /** Said when the filter could not be applied, so silence never means "filtered". */
  note?: string;
}

export async function syncBoards(filterNames?: string[]): Promise<SyncOutcome> {
  let companies = (await listCompanies()).filter((c) => c.active === 1);

  if (filterNames && filterNames.length > 0) {
    const wanted = filterNames.map((n) => n.toLowerCase());
    companies = companies.filter((c) =>
      wanted.some((w) => c.name.toLowerCase().includes(w) || c.board_token.toLowerCase() === w),
    );
  }

  // One bar for the whole run, built once, and the same one evaluate uses.
  const bar = await buildBar();

  const reports: SyncReport[] = [];
  const batchSize = 4;
  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    reports.push(...(await Promise.all(batch.map((company) => syncCompany(company, bar)))));
  }

  // Said out loud, because silence would read as "these boards were filtered".
  const note = cannotJudge(bar);
  return note ? { reports, note } : { reports };
}
