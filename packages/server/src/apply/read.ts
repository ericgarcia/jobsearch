import { originOf } from "../importing.js";
import * as repo from "../repo.js";
import type { ApplicationForm } from "./form.js";
import { parseAshby, parseGreenhouse, parseLever } from "./parse.js";

/**
 * Fetching a job's application form.
 *
 * The parsers take text and are tested against saved postings; this is the
 * part that goes to the network, kept separate so the testable part stays
 * testable. Each board publishes its form somewhere different:
 *
 *   greenhouse  in the posting page, as JSON
 *   lever       as HTML at <posting>/apply
 *   ashby       from a GraphQL query, already typed
 *
 * None of them needs a browser, which is what makes "what will this ask me?"
 * cheap enough to ask about a whole shortlist.
 */

const AGENT = "jobsearch/0.1";

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: { "user-agent": AGENT, ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  return response.text();
}

const ASHBY_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    title
    applicationForm { sections { title fieldEntries { id isRequired field } } }
  }
}`;

/** Read the form for a posting already stored, by its id. */
export async function formForJob(jobId: number): Promise<ApplicationForm> {
  const job = await repo.getJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);
  return await formForUrl(job.url);
}

export async function formForUrl(url: string): Promise<ApplicationForm> {
  const origin = originOf(url);
  if (!origin) {
    throw new Error(
      `${url} is not a greenhouse, lever or ashby posting, so its form cannot be read. Open it and read the page instead.`,
    );
  }

  if (origin.ats === "greenhouse") {
    return parseGreenhouse(await fetchText(url), url);
  }

  if (origin.ats === "lever") {
    // The posting page is the advert; the form is one level down.
    const apply = url.replace(/\/apply\/?$/, "") + "/apply";
    return parseLever(await fetchText(apply), apply);
  }

  if (!origin.source_job_id) {
    throw new Error(`${url} does not name an ashby posting, so its form cannot be looked up.`);
  }

  const body = await fetchText("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: {
        organizationHostedJobsPageName: origin.board_token,
        jobPostingId: origin.source_job_id,
      },
      query: ASHBY_QUERY,
    }),
  });

  const apply = url.replace(/\/application\/?$/, "") + "/application";
  return parseAshby(body, apply);
}
