import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { PORT, DB_PATH, MODEL } from "./config.js";
import { migrate } from "./db/client.js";
import { seedIfEmpty } from "./seed.js";
import * as repo from "./repo.js";
import { syncBoards } from "./sync.js";
import { STATUSES } from "./status.js";
import * as profile from "./profile.js";
import * as resume from "./resume.js";
import { rankAllJobs } from "./matching.js";
import { expandPlace } from "./location.js";
import { detectBoard, detectMany } from "./sources/detect.js";
import { evaluateCompanies } from "./discover.js";
import { getInterests, setInterests } from "./interests.js";
import { assessTopJobs, ASSESS_MODEL } from "./assess.js";
import { browserEnabled, runAgent, verifyCredential } from "./agent/session.js";
import { APP_URL, SPLIT_EXTENSION_ID } from "./config.js";
import { openStageFor } from "./agent/split.js";
import { pdfFilename, renderPdf } from "./layout/pdf.js";
import { changed, onChange } from "./notify.js";
import { clearState, reportState } from "./appState.js";
import { PAGE, TOKENS, DEFAULTS, SECTION_KINDS, SECTION_NOTES, renderDocument } from "@jobsearch/layout";
import {
  createLayout,
  defaultLayout,
  gatherContent,
  getLayout,
  listLayouts,
  seedLayouts,
  updateLayout,
} from "./layout/store.js";
import {
  clearCredential,
  credentialStatus,
  homeLocation,
  saveCredential,
  setHomeLocation,
  type CredentialKind,
} from "./settings.js";

/*
  Explicitly, and before anything else touches the database.

  better-sqlite3 was synchronous, so this file could run the migration as an
  import side effect and every module below it found its tables already there.
  An async migration cannot work that way: the import would return a promise
  nobody awaited, and the first query would race it. So it is a statement, at
  the top, where the order is visible.
*/
await migrate();
await seedIfEmpty();
await seedLayouts();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

/* ------------------------------------------------------------------- queries */

app.get("/api/health", async () => ({
  ok: true,
  db: DB_PATH,
  model: MODEL,
  assess_model: ASSESS_MODEL,
  browser: browserEnabled,
  credential: await credentialStatus(),
  statuses: STATUSES,
}));

/* --------------------------------------------------------------------- setup */

app.get("/api/setup", async () => ({
  credential: await credentialStatus(),
  browser: browserEnabled,
  /*
    Split Pilot's id, so the page can talk to it. An unpacked extension's id
    comes from the path it was loaded from, so it differs per machine and
    cannot be compiled into the web app.
  */
  split_extension_id: SPLIT_EXTENSION_ID,
  /*
    The token Playwright presents when it connects. The app hands it to the
    extension so the two agree without anyone copying a string. It is only
    served to localhost, which is the same boundary the extension's own
    control surface uses.
  */
  browser_token: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN ?? null,
  /** The page each credential kind is created on, for the browser pane. */
  links: {
    "oauth-token": "https://claude.ai/login",
    "api-key": "https://console.anthropic.com/settings/keys",
  },
}));

/**
 * Store a credential the user pasted. The value is checked with one real call
 * before it is written, and is never echoed back in any response.
 */
app.post("/api/setup/credential", async (request, reply) => {
  const body = (request.body ?? {}) as { kind?: string; token?: string };
  const kind = body.kind as CredentialKind | undefined;
  const token = body.token?.trim();

  if (kind !== "oauth-token" && kind !== "api-key") {
    return reply.code(400).send({ error: "kind must be oauth-token or api-key" });
  }
  if (!token) {
    return reply.code(400).send({ error: "token is required" });
  }

  const verdict = await verifyCredential({ kind, token });
  if (!verdict.ok) {
    return reply.code(400).send({ error: verdict.error });
  }

  await saveCredential(kind, token);
  return { credential: await credentialStatus() };
});

app.delete("/api/setup/credential", async () => {
  await clearCredential();
  return { credential: await credentialStatus() };
});

app.get("/api/stats", async () => await repo.stats());

app.get("/api/companies", async () => await repo.listCompanies());

app.post("/api/companies", async (request, reply) => {
  const body = request.body as { name?: string; ats?: string; board_token?: string };
  if (!body?.name || !body?.ats || !body?.board_token) {
    return reply.code(400).send({ error: "name, ats and board_token are required" });
  }
  return await repo.addCompany(body.name, body.ats, body.board_token);
});

/**
 * Work out which job board a company uses, from its name alone.
 * `add` writes the board it finds; without it this only reports.
 */
app.post("/api/companies/detect", async (request, reply) => {
  const body = (request.body ?? {}) as { names?: string[]; name?: string; add?: boolean };
  const names = body.names ?? (body.name ? [body.name] : []);
  if (names.length === 0) {
    return reply.code(400).send({ error: "name or names is required" });
  }

  const found = await detectMany(names);

  if (body.add) {
    for (const row of found) {
      if (row.found) await repo.addCompany(row.name, row.found.ats, row.found.board_token);
    }
  }

  return {
    added: body.add === true,
    results: found,
    missing: found.filter((row) => !row.found).map((row) => row.name),
  };
});

/* --------------------------------------------------------------- interests */

/** What the person wants next, which matching weights above their history. */
app.get("/api/interests", async () => await getInterests());

app.put("/api/interests", async (request) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  return await setInterests(body as never);
});

/**
 * Look at companies' boards without following them. Reports how many of their
 * postings match, so the decision to follow is made on evidence.
 */
app.post("/api/companies/evaluate", async (request, reply) => {
  const body = (request.body ?? {}) as {
    names?: string[];
    location?: string;
    include_remote?: boolean;
    threshold?: number;
  };
  if (!body.names || body.names.length === 0) {
    return reply.code(400).send({ error: "names is required" });
  }
  try {
    return await evaluateCompanies(body.names, {
      location: body.location,
      includeRemote: body.include_remote ?? false,
      threshold: body.threshold,
    });
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

/** What un-following this board would leave behind, asked before doing it. */
app.get("/api/companies/:id/postings", async (request) =>
  await repo.companyPostings(Number((request.params as { id: string }).id)),
);

/**
 * Stop following a board. `postings=delete` removes the postings it fetched,
 * except any being pursued or drafted for, which are always kept.
 */
app.delete("/api/companies/:id", async (request) => {
  const query = request.query as { postings?: string };
  return await repo.removeCompany(
    Number((request.params as { id: string }).id),
    query.postings === "delete",
  );
});

/** Re-score every posting against the profile. Cheap; run after a sync. */
app.post("/api/rank", async (_request, reply) => {
  try {
    return await rankAllJobs();
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

/**
 * Judge the best-matching unassessed postings on a cheap model.
 * Slow (seconds per posting), so the client should expect to wait.
 */
app.post("/api/assess", async (request, reply) => {
  const body = (request.body ?? {}) as {
    limit?: number;
    location?: string;
    include_remote?: boolean;
  };
  try {
    return await assessTopJobs({
      limit: body.limit ?? 20,
      location: body.location,
      includeRemote: body.include_remote ?? false,
    });
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.post("/api/sync", async (request) => {
  const body = (request.body ?? {}) as { companies?: string[] };
  return await syncBoards(body.companies);
});

/* ------------------------------------------------------------------- prefs */

/** Where the person works, and so what the job list shows by default. */
/**
 * Open the stage pane for the tab that is asking, when it needs one.
 *
 * The app calls this as it loads and then adopts the tab itself, through the
 * extension, which is the only party that knows which tab asked. Doing the
 * whole arrangement here meant guessing at that, and the guess was wrong the
 * moment a second app tab existed.
 *
 * There is no switch for it. The two panes are how the app is meant to be
 * used, and a setting whose only job is to turn the arrangement off is a
 * setting that leaves the assistant unable to reach half of it.
 */
app.post("/api/split/stage", async (request, reply) => {
  if (!browserEnabled) return reply.code(409).send({ error: "The browser is switched off." });
  const body = (request.body ?? {}) as { role?: string | null };
  try {
    return await openStageFor(body.role ?? null);
  } catch (error) {
    // Never let this stop the app loading: it is an arrangement, not the work.
    return reply.code(503).send({ error: (error as Error).message });
  }
});

/* --------------------------------------------------------------- app state */

/**
 * The page saying what it is showing.
 *
 * Only a visible tab reports. Several tabs of this app can be open, and a
 * background one asserting what the person is looking at is how the split
 * view ended up with three tabs trading the pair between them.
 */
app.post("/api/app-state", async (request, reply) => {
  const body = (request.body ?? {}) as { tab?: string; selected?: Record<string, number | null>; gone?: boolean };
  if (body.gone) {
    clearState();
    return reply.code(204).send();
  }
  if (typeof body.tab !== "string") return reply.code(400).send({ error: "tab is required" });

  reportState({ tab: body.tab, selected: (body.selected ?? {}) as never });
  return reply.code(204).send();
});

/* ------------------------------------------------------------------ events */

/**
 * A stream of "this changed".
 *
 * Open for the life of the page. Every write raises its topic, whoever made
 * it — the agent through a tool, this person in the page, another tab, or
 * anything calling the API — so a change reaches the screen without the page
 * having to guess when to ask.
 *
 * It carries the topic and nothing else. Sending the new data would mean
 * every writer knowing the shape every reader wants, and a reader that then
 * fetches for itself can decide whether it is ready to take the update.
 */
app.get("/api/events", async (request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  reply.raw.write(`: connected\n\n`);

  const send = (change: { topic: string; at: string }) => {
    reply.raw.write(`data: ${JSON.stringify(change)}\n\n`);
  };
  const stop = onChange(send);

  // A comment line every 25 seconds. The browser gives up on a silent
  // EventSource, and this stream is silent whenever nobody is editing —
  // which is most of the time.
  const beat = setInterval(() => reply.raw.write(`: beat\n\n`), 25_000);

  request.raw.on("close", () => {
    clearInterval(beat);
    stop();
  });

  // Never resolves: the response ends when the client disconnects.
  await new Promise<void>(() => {});
});

/* ---------------------------------------------------------------- projects */

app.get("/api/projects", async () => profile.listProjects());

app.post("/api/projects", async (request, reply) => {
  const body = (request.body ?? {}) as { name?: string; role_id?: number | null };
  if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
  try {
    return await profile.addProject(body as Parameters<typeof profile.addProject>[0]);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.put("/api/projects/:id", async (request, reply) => {
  try {
    return await profile.updateProject(
      Number((request.params as { id: string }).id),
      request.body as Record<string, never>,
    );
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/projects/:id", async (request) => ({
  deleted: await profile.deleteProject(Number((request.params as { id: string }).id)),
}));

/* ---------------------------------------------------------------- sections */

app.get("/api/sections", async () => profile.listSections());

app.post("/api/sections", async (request, reply) => {
  const body = (request.body ?? {}) as { heading?: string; body?: string };
  if (!body.heading?.trim() || !body.body?.trim()) {
    return reply.code(400).send({ error: "heading and body are required" });
  }
  return profile.addSection(body as Parameters<typeof profile.addSection>[0]);
});

app.put("/api/sections/:id", async (request, reply) => {
  try {
    return await profile.updateSection(
      Number((request.params as { id: string }).id),
      request.body as Record<string, never>,
    );
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/sections/:id", async (request) => ({
  deleted: await profile.deleteSection(Number((request.params as { id: string }).id)),
}));

/* ----------------------------------------------------------------- layouts */

/**
 * What can be customised, and what each control does.
 *
 * Served rather than documented twice: the styling skill and the UI both
 * read this, so neither can drift from what the renderer will accept.
 */
app.get("/api/layout/vocabulary", async () => ({
  tokens: Object.fromEntries(
    Object.entries(TOKENS).map(([name, def]) => [
      name,
      { type: def.type, surfaces: def.surfaces, values: def.values, min: def.min, max: def.max, note: def.note },
    ]),
  ),
  defaults: DEFAULTS,
  sections: SECTION_KINDS.map((kind) => ({ kind, note: SECTION_NOTES[kind] })),
  page: PAGE,
}));

app.get("/api/layouts", async (request) => {
  const surface = (request.query as { surface?: string }).surface;
  return listLayouts(surface === "profile" || surface === "resume" ? surface : undefined);
});

app.post("/api/layouts", async (request, reply) => {
  const body = (request.body ?? {}) as { surface?: string; name?: string; from?: number };
  if (body.surface !== "profile" && body.surface !== "resume") {
    return reply.code(400).send({ error: "surface must be profile or resume" });
  }
  return createLayout(body.surface, body.name ?? "Untitled", body.from);
});

app.put("/api/layouts/:id", async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  try {
    return await updateLayout(id, (request.body ?? {}) as Record<string, never>);
  } catch (error) {
    // The message names the token or the section that was refused, so the
    // caller — usually the agent — can correct it rather than guess.
    return reply.code(400).send({ error: (error as Error).message });
  }
});

/**
 * Render a surface as a whole HTML document.
 *
 * `?resume=<id>` swaps the content for a tailored draft, leaving the template
 * alone — style once, export anything. `?paged=1` draws the page edges, which
 * printing never shows.
 */
app.get("/api/layouts/:id/render", async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const query = request.query as { resume?: string; paged?: string };

  try {
    const layout = await getLayout(id);
    const content = await gatherContent(query.resume ? Number(query.resume) : null);
    const html = renderDocument({
      spec: layout.spec,
      tokens: layout.tokens,
      content,
      surface: layout.surface,
      paged: query.paged === "1",
    });
    return reply.type("text/html; charset=utf-8").send(html);
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

/**
 * The resume as a PDF.
 *
 * Chrome typesets it, so the file matches the preview rather than
 * approximating it, and it holds real text — an applicant tracking system
 * reads a resume before any person does.
 */
app.get("/api/resume.pdf", async (request, reply) => {
  const query = request.query as { resume?: string; layout?: string };
  try {
    const [pdf, me] = await Promise.all([
      renderPdf({
        resumeId: query.resume ? Number(query.resume) : null,
        layoutId: query.layout ? Number(query.layout) : undefined,
      }),
      profile.getProfile(),
    ]);

    const label = query.resume
      ? ((await resume.getResume(Number(query.resume))).job?.company ?? null)
      : null;

    return reply
      .type("application/pdf")
      .header("content-disposition", `attachment; filename="${pdfFilename(me.name, label)}"`)
      .send(pdf);
  } catch (error) {
    // 503, not 500: the usual cause is Chrome missing or busy, which is a
    // condition of this machine rather than a fault in the request.
    return reply.code(503).send({ error: (error as Error).message });
  }
});

/** The same, through whichever layout a surface uses by default. */
app.get("/api/render/:surface", async (request, reply) => {
  const surface = (request.params as { surface: string }).surface;
  if (surface !== "profile" && surface !== "resume") {
    return reply.code(404).send({ error: "surface must be profile or resume" });
  }
  const query = request.query as { resume?: string; paged?: string };
  const layout = await defaultLayout(surface);
  const content = await gatherContent(query.resume ? Number(query.resume) : null);
  return reply.type("text/html; charset=utf-8").send(
    renderDocument({
      spec: layout.spec,
      tokens: layout.tokens,
      content,
      surface,
      paged: query.paged === "1",
    }),
  );
});

app.get("/api/prefs", async () => ({ home_location: await homeLocation() }));

app.put("/api/prefs", async (request) => {
  const body = (request.body ?? {}) as { home_location?: string };
  if (body.home_location !== undefined) await setHomeLocation(body.home_location);
  return { home_location: await homeLocation() };
});

app.get("/api/jobs", async (request) => {
  const q = request.query as Record<string, string | undefined>;
  const list = (value: string | undefined) =>
    value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  // An empty `location` means everywhere, which is different from the
  // parameter being absent — absent falls back to where the person lives.
  const places =
    q.location === undefined ? (await homeLocation() ?? "") : q.location;
  const locationAny = places
    .split(",")
    .map((place) => place.trim())
    .filter(Boolean)
    .flatMap(expandPlace);

  const criteria = {
    titleAny: list(q.title),
    textAny: list(q.text),
    companyAny: list(q.company),
    locationAny: locationAny.length > 0 ? locationAny : undefined,
    includeRemote: q.include_remote === "1",
    statusAny: list(q.status),
    remoteOnly: q.remote === "1",
    untrackedOnly: q.untracked === "1",
    minMatchScore: q.min_match ? Number(q.min_match) : undefined,
    limit: q.limit ? Number(q.limit) : 100,
  };

  const jobs = await repo.searchJobs(criteria);
  // The total ignores the limit, so the UI can say how much it is not showing.
  return { count: jobs.length, total: await repo.countJobs(criteria), jobs };
});

app.get("/api/jobs/:id", async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const job = await repo.getJob(id);
  if (!job) return reply.code(404).send({ error: `No job with id ${id}` });
  return { ...job, history: repo.applicationHistory(id) };
});

app.get("/api/applications", async (request) => {
  const q = request.query as { status?: string };
  const statuses = q.status ? q.status.split(",") : undefined;
  return await repo.listApplications(statuses);
});

app.post("/api/jobs/:id/track", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { note?: string };
    return await repo.trackJob(Number((request.params as { id: string }).id), body.note);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.post("/api/jobs/:id/status", async (request, reply) => {
  const body = (request.body ?? {}) as { status?: string; note?: string };
  if (!body.status) return reply.code(400).send({ error: "status is required" });
  try {
    return await repo.setStatus(Number((request.params as { id: string }).id), body.status, body.note);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});


/* ------------------------------------------------------------------ profile */

const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) =>
  reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });

app.get("/api/profile", async () => {
  // Spreading a promise is legal and yields {}, so this has to be awaited
  // first rather than inline. The route returned `{"empty": false}` and
  // nothing else for as long as it was written the short way.
  const [full, empty] = await Promise.all([profile.fullProfile(), profile.isEmpty()]);
  return { ...full, empty };
});

app.patch("/api/profile", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const links = Array.isArray(body.links) ? JSON.stringify(body.links) : undefined;
    return await profile.updateProfile({ ...(body as object), links } as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.post("/api/profile/roles", async (request, reply) => {
  try {
    return profile.addRole(request.body as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.patch("/api/profile/roles/:id", async (request, reply) => {
  try {
    return await profile.updateRole(Number((request.params as { id: string }).id), request.body as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/roles/:id", async (request) => ({
  removed: await profile.deleteRole(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/bullets", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { role_id?: number | null; text?: string; skills?: string[] };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text is required" });
    return await profile.addBullet(body.role_id ?? null, body.text, body.skills ?? []);
  } catch (error) {
    return bad(reply, error);
  }
});

app.patch("/api/profile/bullets/:id", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { text?: string; skills?: string[] };
    return await profile.updateBullet(Number((request.params as { id: string }).id), body.text, body.skills);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/bullets/:id", async (request) => ({
  removed: await profile.deleteBullet(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/education", async (request, reply) => {
  try {
    return await profile.addEducation(request.body as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/education/:id", async (request) => ({
  removed: await profile.deleteEducation(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/skills", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { name?: string; category?: string; years?: number };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
    return await profile.addSkill(body.name, body.category, body.years);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/skills/:id", async (request) => ({
  removed: await profile.deleteSkill(Number((request.params as { id: string }).id)),
}));

/* ------------------------------------------------------------------ resumes */

app.get("/api/resumes", async (request) => {
  const q = request.query as { job_id?: string };
  return await resume.listResumes(q.job_id ? Number(q.job_id) : undefined);
});

app.get("/api/resumes/:id", async (request, reply) => {
  try {
    return await resume.getResume(Number((request.params as { id: string }).id));
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.get("/api/resumes/:id/markdown", async (request, reply) => {
  try {
    return { markdown: await resume.renderMarkdown(Number((request.params as { id: string }).id)) };
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/resumes/:id", async (request) => ({
  removed: await resume.deleteResume(Number((request.params as { id: string }).id)),
}));

app.get("/api/jobs/:id/cover-letters", async (request) =>
  await resume.listCoverLetters(Number((request.params as { id: string }).id)),
);

app.get("/api/cover-letters", async () => await resume.listAllCoverLetters());

app.get("/api/cover-letters/:id", async (request, reply) => {
  try {
    return await resume.getCoverLetter(Number((request.params as { id: string }).id));
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/cover-letters/:id", async (request) => ({
  removed: await resume.deleteCoverLetter(Number((request.params as { id: string }).id)),
}));

/* ---------------------------------------------------------------------- chat */


app.get("/api/conversations", async () => repo.listConversations());

app.patch("/api/conversations/:id", async (request, reply) => {
  const title = ((request.body ?? {}) as { title?: string }).title;
  if (typeof title !== "string" || !title.trim()) {
    return reply.code(400).send({ error: "title is required" });
  }
  await repo.renameConversation(Number((request.params as { id: string }).id), title.trim());
  changed("threads");
  return { ok: true };
});

app.delete("/api/conversations/:id", async (request) => {
  const deleted = await repo.deleteConversation(Number((request.params as { id: string }).id));
  if (deleted) changed("threads");
  return { deleted };
});

app.post("/api/conversations", async (request) => {
  const body = (request.body ?? {}) as { title?: string };
  return { id: await repo.createConversation(body.title) };
});

app.get("/api/conversations/:id/messages", async (request) =>
  await repo.listMessages(Number((request.params as { id: string }).id)),
);

/**
 * Run one agent turn and stream its events back as Server-Sent Events.
 * POST, so the browser reads it with fetch() rather than EventSource.
 */
app.post("/api/chat", async (request, reply) => {
  const body = (request.body ?? {}) as { message?: string; conversationId?: number };
  if (!body.message?.trim()) {
    return reply.code(400).send({ error: "message is required" });
  }

  const conversationId = body.conversationId ?? await repo.createConversation(body.message.slice(0, 80));
  await repo.addMessage(conversationId, "user", body.message);

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const controller = new AbortController();

  // Watch the RESPONSE, not the request. Node emits "close" on the request
  // stream as soon as the body has been read, which is long before the client
  // goes away — listening there aborts the agent on every single turn.
  let finished = false;
  reply.raw.on("close", () => {
    if (!finished) {
      app.log.info("client disconnected, interrupting the agent");
      controller.abort();
    }
  });

  send({ type: "conversation", conversationId });

  const replyText: string[] = [];
  try {
    for await (const event of runAgent({
      prompt: body.message,
      resume: await repo.getSdkSessionId(conversationId),
      signal: controller.signal,
    })) {
      if (event.type === "session") await repo.setSdkSessionId(conversationId, event.sessionId);
      if (event.type === "text") replyText.push(event.text);
      send(event);
    }
  } catch (error) {
    send({ type: "error", message: (error as Error).message });
  }

  if (replyText.length > 0) {
    await repo.addMessage(conversationId, "assistant", replyText.join("\n\n"));
  }
  finished = true;
  send({ type: "end" });
  reply.raw.end();
});

/*
  Serve the built web app from the same origin as the API.

  In development that is Vite's job, on its own port, and this does nothing
  because packages/web/dist does not exist. Installed, there is no Vite: one
  process has to answer both, or `npx jobsearch` would mean starting two
  servers and telling the person which one to open.

  One origin also removes the CORS exception above from the installed path,
  and keeps the app on a port Split Pilot already accepts — its manifest
  matches any localhost port, not a particular one.
*/
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (fs.existsSync(path.join(webRoot, "index.html"))) {
  await app.register(fastifyStatic, { root: webRoot });

  // A single-page app owns its own routing, so anything that is not a file
  // and not an API call is a route inside it, not a 404.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "No such route." });
    return reply.sendFile("index.html");
  });
  app.log.info(`serving the web app from ${webRoot}`);
} else {
  app.log.info("no built web app; run the Vite dev server for the interface");
}

await app.listen({ port: PORT, host: "127.0.0.1" });
app.log.info(`jobsearch server on http://127.0.0.1:${PORT} — database ${DB_PATH}`);
if (!(await credentialStatus()).set) {
  app.log.warn("No Claude credential yet. Open the app and finish Setup.");
}
