import { getJson, looksRemote, stripHtml, type JobSource, type SourceJob } from "./types.js";

interface LeverList {
  text: string;
  content: string;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: LeverList[];
  categories?: { location?: string; team?: string; commitment?: string };
  workplaceType?: string;
}

/**
 * Lever splits a posting across several fields. `descriptionPlain` holds only
 * the opening paragraphs, and is empty on some postings. The parts that matter
 * for matching — what you will do, who you are — live in `lists`, and the
 * closing sections in `additionalPlain`. Reading only the description loses
 * most of the posting, so assemble all three.
 */
function assembleDescription(posting: LeverPosting): string | null {
  const parts: string[] = [];

  if (posting.descriptionPlain?.trim()) {
    parts.push(posting.descriptionPlain.trim());
  }

  for (const list of posting.lists ?? []) {
    const body = stripHtml(list.content)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join("\n");
    if (body) parts.push(`${list.text}\n${body}`);
  }

  if (posting.additionalPlain?.trim()) {
    parts.push(posting.additionalPlain.trim());
  }

  const text = parts.join("\n\n").trim();
  return text.length > 0 ? text : null;
}

export const lever: JobSource = {
  id: "lever",

  async fetchBoard(boardToken, companyName) {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`;
    const postings = (await getJson(url)) as LeverPosting[];

    return postings.map((posting): SourceJob => {
      const location = posting.categories?.location ?? null;
      return {
        source: "lever",
        sourceJobId: `${boardToken}:${posting.id}`,
        company: companyName ?? boardToken,
        title: posting.text,
        location,
        remote: posting.workplaceType === "remote" || looksRemote(location, posting.text),
        url: posting.hostedUrl,
        description: assembleDescription(posting),
        postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
      };
    });
  },
};
