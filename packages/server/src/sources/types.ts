/** A posting normalised across every board. Adapters return these and nothing else. */
export interface SourceJob {
  source: string;
  sourceJobId: string;
  company: string;
  title: string;
  location: string | null;
  remote: boolean;
  url: string;
  description: string | null;
  postedAt: string | null;
}

/** A board we can poll. LinkedIn becomes one of these later. */
export interface JobSource {
  /** Stable identifier, stored on every job row. */
  readonly id: string;
  /** Fetch every open posting for one board. */
  fetchBoard(boardToken: string, companyName?: string): Promise<SourceJob[]>;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksRemote(...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => f != null && /\bremote\b|\bdistributed\b|work from home/i.test(f));
}

export async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "jobsearch/0.1" },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}
