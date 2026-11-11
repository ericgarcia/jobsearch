export interface Job {
  id: number;
  company: string;
  title: string;
  location: string | null;
  remote: number;
  url: string;
  description: string | null;
  posted_at: string | null;
  first_seen_at: string;
  status: string | null;
  fit_score: number | null;
  reasoning: string | null;
  match_score: number | null;
  model?: string | null;
}

export interface JobDetail extends Job {
  history: { from_status: string | null; to_status: string; note: string | null; at: string }[];
}

export interface Application {
  id: number;
  job_id: number;
  status: string;
  notes: string | null;
  applied_at: string | null;
  updated_at: string;
  title: string;
  company: string;
  url: string;
  location: string | null;
}

export type CredentialKind = "oauth-token" | "api-key";

export interface CredentialStatus {
  set: boolean;
  kind: CredentialKind | null;
  masked: string | null;
  source: "env" | "database" | null;
}

export interface Company {
  id: number;
  name: string;
  ats: string;
  board_token: string;
  active: number;
  jobs?: number;
}

export interface DetectResult {
  added: boolean;
  results: {
    name: string;
    found: { ats: string; board_token: string; jobs: number; sample: string[] } | null;
  }[];
  missing: string[];
}

export interface Health {
  ok: boolean;
  db: string;
  model: string;
  browser: boolean;
  credential: CredentialStatus;
  statuses: string[];
}

export interface Setup {
  /** Split Pilot's extension id, or absent when it is not configured. */
  split_extension_id?: string;
  /** The token Playwright uses, handed to the extension so they agree. */
  browser_token?: string | null;
  credential: CredentialStatus;
  browser: boolean;
  links: Record<CredentialKind, string>;
}

export interface SyncReport {
  company: string;
  ats: string;
  seen: number;
  inserted: number;
  error?: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export interface JobQuery {
  title?: string;
  text?: string;
  company?: string;
  status?: string;
  /** Empty string means everywhere. Undefined means where the person lives. */
  location?: string;
  includeRemote?: boolean;
  untracked?: boolean;
}

export interface Interests {
  /** Role titles wanted, for example "Staff Machine Learning Engineer". */
  titles: string[];
  /** Subjects and technologies to seek out. */
  include: string[];
  /** Subjects to avoid. A posting whose title matches one is pushed down. */
  exclude: string[];
  note: string | null;
}

/** One posting found on a board that is not followed yet. */
export interface Hit {
  title: string;
  location: string | null;
  remote: boolean;
  url: string;
  score: number;
}

/** What a company's board looks like, read before deciding to follow it. */
export interface Evaluation {
  name: string;
  ats: string | null;
  board_token: string | null;
  total: number;
  in_scope: number;
  matching: number;
  best_score: number;
  top: Hit[];
  already_followed: boolean;
  error?: string;
}

export const api = {
  health: () => json<Health>("/api/health"),

  setup: () => json<Setup>("/api/setup"),

  /** Send a pasted credential. The server verifies it, stores it, and never echoes it. */
  saveCredential: (kind: CredentialKind, token: string) =>
    json<{ credential: CredentialStatus }>("/api/setup/credential", {
      method: "POST",
      body: JSON.stringify({ kind, token }),
    }),

  clearCredential: () =>
    json<{ credential: CredentialStatus }>("/api/setup/credential", { method: "DELETE" }),

  stats: () => json<{ jobs: number; byStatus: { status: string; n: number }[] }>("/api/stats"),

  jobs: (query: JobQuery) => {
    const params = new URLSearchParams();
    if (query.title) params.set("title", query.title);
    if (query.text) params.set("text", query.text);
    if (query.company) params.set("company", query.company);
    if (query.status) params.set("status", query.status);
    if (query.location !== undefined) params.set("location", query.location);
    if (query.includeRemote) params.set("include_remote", "1");
    if (query.untracked) params.set("untracked", "1");
    params.set("limit", "150");
    return json<{ count: number; total: number; jobs: Job[] }>(`/api/jobs?${params}`);
  },

  job: (id: number) => json<JobDetail>(`/api/jobs/${id}`),

  applications: () => json<Application[]>("/api/applications"),

  sync: () => json<SyncReport[]>("/api/sync", { method: "POST", body: "{}" }),

  assess: (limit: number, location: string | undefined, includeRemote: boolean) =>
    json<{
      model: string;
      places: string[];
      assessed: number;
      failed: number;
      cost_usd: number;
      results: { id: number; company: string; title: string; score: number | null }[];
    }>("/api/assess", {
      method: "POST",
      body: JSON.stringify({ limit, location, include_remote: includeRemote }),
    }),

  rank: () =>
    json<{ scored: number; top: { id: number; company: string; title: string; score: number }[] }>(
      "/api/rank",
      { method: "POST", body: "{}" },
    ),

  track: (id: number) => json<Application>(`/api/jobs/${id}/track`, { method: "POST", body: "{}" }),

  setStatus: (id: number, status: string) =>
    json<Application>(`/api/jobs/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  companies: () => json<Company[]>("/api/companies"),

  /** Find each company's board by name. `add` stores the ones it finds. */
  detectCompanies: (names: string[], add: boolean) =>
    json<DetectResult>("/api/companies/detect", {
      method: "POST",
      body: JSON.stringify({ names, add }),
    }),

  interests: () => json<Interests>("/api/interests"),

  saveInterests: (patch: Partial<Interests>) =>
    json<Interests>("/api/interests", { method: "PUT", body: JSON.stringify(patch) }),

  /**
   * Read companies' boards without following them, and report how many of
   * their postings match. Nothing is stored, so a company can be looked at
   * and then left alone.
   */
  evaluateCompanies: (names: string[], location: string | undefined, includeRemote: boolean) =>
    json<Evaluation[]>("/api/companies/evaluate", {
      method: "POST",
      body: JSON.stringify({ names, location, include_remote: includeRemote }),
    }),

  /** What un-following this board would leave behind. */
  companyPostings: (id: number) =>
    json<{ total: number; tracked: number }>(`/api/companies/${id}/postings`),

  /**
   * Stop following a board. Deleting its postings is a choice because keeping
   * them means keeping rows nothing will ever refresh. Tracked postings are
   * kept either way.
   */
  deleteCompany: (id: number, withPostings: boolean) =>
    json<{ removed: boolean; deleted: number; kept: number }>(
      `/api/companies/${id}?postings=${withPostings ? "delete" : "keep"}`,
      { method: "DELETE" },
    ),

  prefs: () => json<{ home_location: string | null }>("/api/prefs"),

  /**
   * Ask the server to arrange the split view. Safe to call on every load: it
   * returns what is already there rather than opening a second pane.
   */
  openSplitView: () =>
    json<{ arranged?: boolean; state?: string }>("/api/split/open", {
      method: "POST",
      body: "{}",
    }),


  setHomeLocation: (place: string) =>
    json<{ home_location: string | null }>("/api/prefs", {
      method: "PUT",
      body: JSON.stringify({ home_location: place }),
    }),

  profile: () => json<Profile>("/api/profile"),

  patchProfile: (patch: Record<string, unknown>) =>
    json<unknown>("/api/profile", { method: "PATCH", body: JSON.stringify(patch) }),

  addRole: (role: Record<string, unknown>) =>
    json<Role>("/api/profile/roles", { method: "POST", body: JSON.stringify(role) }),

  patchRole: (id: number, patch: Record<string, unknown>) =>
    json<Role>(`/api/profile/roles/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteRole: (id: number) => json<unknown>(`/api/profile/roles/${id}`, { method: "DELETE" }),

  addBullet: (roleId: number | null, text: string) =>
    json<Bullet>("/api/profile/bullets", {
      method: "POST",
      body: JSON.stringify({ role_id: roleId, text }),
    }),

  patchBullet: (id: number, text: string) =>
    json<Bullet>(`/api/profile/bullets/${id}`, { method: "PATCH", body: JSON.stringify({ text }) }),

  deleteBullet: (id: number) => json<unknown>(`/api/profile/bullets/${id}`, { method: "DELETE" }),

  addSkill: (name: string) =>
    json<unknown>("/api/profile/skills", { method: "POST", body: JSON.stringify({ name }) }),

  deleteSkill: (id: number) => json<unknown>(`/api/profile/skills/${id}`, { method: "DELETE" }),

  resumes: (jobId?: number) =>
    json<ResumeSummary[]>(`/api/resumes${jobId ? `?job_id=${jobId}` : ""}`),

  resume: (id: number) => json<Resume>(`/api/resumes/${id}`),

  resumeMarkdown: (id: number) => json<{ markdown: string }>(`/api/resumes/${id}/markdown`),

  deleteResume: (id: number) => json<unknown>(`/api/resumes/${id}`, { method: "DELETE" }),

  coverLetters: () => json<CoverLetter[]>("/api/cover-letters"),

  coverLetter: (id: number) => json<CoverLetter>(`/api/cover-letters/${id}`),

  deleteCoverLetter: (id: number) =>
    json<unknown>(`/api/cover-letters/${id}`, { method: "DELETE" }),
};

export interface Bullet {
  id: number;
  role_id: number | null;
  text: string;
  skills: string;
  sort_order: number;
}

export interface Role {
  id: number;
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  sort_order: number;
  bullets: Bullet[];
}

export interface Profile {
  profile: {
    id: number;
    name: string | null;
    headline: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    links: string;
    summary: string | null;
  };
  roles: Role[];
  unassigned_bullets: Bullet[];
  education: { id: number; school: string; degree: string | null; field: string | null; end_date: string | null }[];
  skills: { id: number; name: string; category: string | null; years: number | null }[];
  empty: boolean;
}

export interface ResumeSummary {
  id: number;
  job_id: number | null;
  label: string | null;
  created_at: string;
  company: string | null;
  title: string | null;
  lines: number;
}

export interface ResumeLine {
  id: number;
  source_bullet_id: number;
  source_text: string;
  rendered_text: string | null;
  text: string;
  warnings: string[];
  role_id: number | null;
}

export interface Resume {
  id: number;
  job_id: number | null;
  label: string | null;
  summary: string | null;
  created_at: string;
  job?: { id: number; company: string; title: string; url: string };
  lines: ResumeLine[];
  summary_warnings: string[];
  warnings: string[];
}

export interface CoverLetter {
  id: number;
  job_id: number;
  body: string;
  warnings: string[];
  created_at: string;
  company: string | null;
  title: string | null;
  url: string | null;
}

export type ChatEvent =
  | { type: "conversation"; conversationId: number }
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "refresh" }
  | { type: "done"; result: string; costUsd: number | null; turns: number | null }
  | { type: "error"; message: string }
  | { type: "end" };

/** Stream one agent turn. The endpoint is POST, so this reads the body itself. */
export async function* chat(
  message: string,
  conversationId: number | null,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6)) as ChatEvent;
    }
  }
}
