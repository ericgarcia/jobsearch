import { getSource } from "./sources/index.js";
import { listCompanies, upsertJobs, type CompanyRow } from "./repo.js";

export interface SyncReport {
  company: string;
  ats: string;
  seen: number;
  inserted: number;
  error?: string;
}

/** Poll one board and write what it returns. Never throws; failures are reported. */
async function syncCompany(company: CompanyRow): Promise<SyncReport> {
  try {
    const source = getSource(company.ats);
    const jobs = await source.fetchBoard(company.board_token, company.name);
    const { seen, inserted } = upsertJobs(jobs);
    return { company: company.name, ats: company.ats, seen, inserted };
  } catch (error) {
    return {
      company: company.name,
      ats: company.ats,
      seen: 0,
      inserted: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Poll every active board, four at a time. One slow or broken board does not
 * stop the rest.
 */
export async function syncBoards(filterNames?: string[]): Promise<SyncReport[]> {
  let companies = listCompanies().filter((c) => c.active === 1);

  if (filterNames && filterNames.length > 0) {
    const wanted = filterNames.map((n) => n.toLowerCase());
    companies = companies.filter((c) =>
      wanted.some((w) => c.name.toLowerCase().includes(w) || c.board_token.toLowerCase() === w),
    );
  }

  const reports: SyncReport[] = [];
  const batchSize = 4;
  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    reports.push(...(await Promise.all(batch.map(syncCompany))));
  }
  return reports;
}
