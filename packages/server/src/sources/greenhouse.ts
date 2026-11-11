import { getJson, looksRemote, stripHtml, type JobSource, type SourceJob } from "./types.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
}

export const greenhouse: JobSource = {
  id: "greenhouse",

  async fetchBoard(boardToken, companyName) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
      boardToken,
    )}/jobs?content=true`;
    const body = (await getJson(url)) as { jobs?: GreenhouseJob[] };
    const jobs = body.jobs ?? [];

    return jobs.map((job): SourceJob => {
      const location = job.location?.name ?? null;
      // Greenhouse escapes the posting body, so it arrives as HTML entities.
      const description = job.content ? stripHtml(decodeEntities(job.content)) : null;
      return {
        source: "greenhouse",
        sourceJobId: `${boardToken}:${job.id}`,
        company: companyName ?? boardToken,
        title: job.title,
        location,
        remote: looksRemote(location, job.title),
        url: job.absolute_url,
        description,
        postedAt: job.updated_at ?? null,
      };
    });
  },
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
