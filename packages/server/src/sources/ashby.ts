import { getJson, looksRemote, type JobSource, type SourceJob } from "./types.js";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  publishedAt?: string;
  descriptionPlain?: string;
  isRemote?: boolean;
}

export const ashby: JobSource = {
  id: "ashby",

  async fetchBoard(boardToken, companyName) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}`;
    const body = (await getJson(url)) as { jobs?: AshbyJob[] };
    const jobs = body.jobs ?? [];

    return jobs.map((job): SourceJob => {
      const location = job.location ?? null;
      return {
        source: "ashby",
        sourceJobId: `${boardToken}:${job.id}`,
        company: companyName ?? boardToken,
        title: job.title,
        location,
        remote: job.isRemote === true || looksRemote(location, job.title),
        url: job.jobUrl,
        description: job.descriptionPlain ?? null,
        postedAt: job.publishedAt ?? null,
      };
    });
  },
};
