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
  /** What has been written for this application. */
  drafts: {
    resumes: { id: number; label: string | null }[];
    cover_letters: { id: number }[];
  };
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

export interface FormField {
  label: string;
  type: string;
  required: boolean;
  kind: "identity" | "document" | "link" | "standing" | "eeo" | "consent" | "custom";
  options?: string[];
  ref?: string;
}

export interface ApplicationForm {
  ats: string;
  url: string;
  fields: FormField[];
  summary: string;
}

export interface SyncReport {
  company: string;
  ats: string;
  /** On the board. */
  seen: number;
  /** Of those, the ones that passed the relevance bar and were stored. */
  kept: number;
  /** Of those, the ones that were not already here. */
  inserted: number;
  error?: string;
}

export interface SyncOutcome {
  reports: SyncReport[];
  /** Present when the filter could not be applied, and why. */
  note?: string;
}



export interface Project {
  id: number;
  role_id: number | null;
  name: string;
  blurb: string | null;
  narrative: string | null;
  start_date: string | null;
  end_date: string | null;
  narrative_public: number;
  sort_order: number;
}

export interface ProseSection {
  id: number;
  kind: string;
  heading: string;
  body: string;
  is_public: number;
  sort_order: number;
}


export interface Thread {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
  preview: string | null;
}

/* ------------------------------------------------------------- layouts */

export interface TokenDef {
  type: "color" | "length" | "number" | "enum";
  surfaces: ("profile" | "resume")[];
  values?: string[];
  min?: number;
  max?: number;
  note: string;
}

export interface Vocabulary {
  tokens: Record<string, TokenDef>;
  defaults: Record<"profile" | "resume", Record<string, string>>;
  sections: { kind: string; note: string }[];
  page: { width: string; height: string };
}

export interface LayoutSection {
  kind: string;
  visible: boolean;
  heading: string | null;
  options: {
    showProjects?: boolean;
    maxBullets?: number;
    hideDates?: boolean;
    grouped?: boolean;
    contact?: string[];
  };
}

export interface Layout {
  id: number;
  surface: "profile" | "resume";
  name: string;
  spec: { sections: LayoutSection[] };
  tokens: Record<string, string>;
  is_default: number;
  updated_at: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      /*
        The header only when there is a body to describe.

        It used to go on every request, including the bodyless DELETEs, and
        Fastify answers that with a 400: "Body cannot be empty when
        content-type is set to 'application/json'". Every delete button in
        the app threw, the throw went nowhere visible, and the row stayed on
        the screen — the same request by hand, without the header, deleted
        the row. Found by clicking one rather than by reading this.
      */
      ...(init?.body == null ? {} : { "content-type": "application/json" }),
      ...(init?.headers ?? {}),
    },
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

  sync: () => json<SyncOutcome>("/api/sync", { method: "POST", body: "{}" }),

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

  projects: () => json<Project[]>("/api/projects"),
  addProject: (project: Partial<Project> & { name: string }) =>
    json<Project>("/api/projects", { method: "POST", body: JSON.stringify(project) }),
  saveProject: (id: number, patch: Partial<Project>) =>
    json<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteProject: (id: number) =>
    json<{ deleted: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),

  sections: () => json<ProseSection[]>("/api/sections"),
  addSection: (section: { heading: string; body: string }) =>
    json<ProseSection>("/api/sections", { method: "POST", body: JSON.stringify(section) }),
  saveSection: (id: number, patch: Partial<ProseSection>) =>
    json<ProseSection>(`/api/sections/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteSection: (id: number) =>
    json<{ deleted: boolean }>(`/api/sections/${id}`, { method: "DELETE" }),

  threads: () => json<Thread[]>("/api/conversations"),
  newThread: () => json<{ id: number }>("/api/conversations", { method: "POST", body: "{}" }),
  renameThread: (id: number, title: string) =>
    json<{ ok: true }>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteThread: (id: number) =>
    json<{ deleted: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  workspace: (id: number) =>
    json<{ workspace: unknown | null }>(`/api/conversations/${id}/workspace`),
  saveWorkspace: (id: number, workspace: unknown) =>
    json<{ ok: true }>(`/api/conversations/${id}/workspace`, {
      method: "PUT",
      body: JSON.stringify(workspace),
    }),

  threadMessages: (id: number) =>
    json<{ role: "user" | "assistant"; content: string; at: string }[]>(`/api/conversations/${id}/messages`),

  vocabulary: () => json<Vocabulary>("/api/layout/vocabulary"),

  layouts: (surface?: "profile" | "resume") =>
    json<Layout[]>(`/api/layouts${surface ? `?surface=${surface}` : ""}`),

  /*
    One call for both halves of an edit, because they are one edit. Moving a
    section and recolouring a heading are the same gesture to the person
    doing it, and two requests would mean two renders and a visible flicker
    between them.
  */
  saveLayout: (id: number, patch: { spec?: unknown; tokens?: Record<string, string>; name?: string }) =>
    json<Layout>(`/api/layouts/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  standingAnswers: () =>
    json<{ answers: { topic: string; question: string; answer: string }[]; topics: Record<string, string> }>(
      "/api/standing-answers",
    ),
  setStandingAnswer: (topic: string, answer: string) =>
    json<unknown>(`/api/standing-answers/${encodeURIComponent(topic)}`, {
      method: "PUT",
      body: JSON.stringify({ answer }),
    }),

  /*
    Self-identification. Read and written by this page alone: no agent tool
    returns these values, and the server never puts them in a prompt.
  */
  selfIdentification: () =>
    json<{ values: Record<string, string>; keys: readonly string[] }>("/api/self-identification"),
  setSelfIdentification: (key: string, value: string) =>
    json<unknown>(`/api/self-identification/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  applicationForm: (jobId: number) =>
    json<ApplicationForm>(`/api/jobs/${jobId}/application-form`),

  prefs: () => json<{ home_location: string | null }>("/api/prefs"),

  /**
   * Have the server open an empty pane for this tab to adopt.
   *
   * Playwright opens it rather than the browser or the extension, so the
   * assistant can drive what it shows. The page adopts it and then points
   * it at the URL — opening it at the page meant the split did not appear
   * until that page had finished loading.
   */
  openStage: () => json<{ opened: boolean }>("/api/split/open", { method: "POST", body: "{}" }),


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
