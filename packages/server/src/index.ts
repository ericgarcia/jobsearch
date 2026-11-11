import Fastify from "fastify";
import cors from "@fastify/cors";
import { PORT, DB_PATH, MODEL } from "./config.js";
import "./db/client.js";
import { seedIfEmpty } from "./seed.js";
import * as repo from "./repo.js";
import { syncBoards } from "./sync.js";
import { STATUSES } from "./status.js";
import * as profile from "./profile.js";
import * as resume from "./resume.js";
import { rankAllJobs } from "./matching.js";
import { expandPlace } from "./location.js";
import { detectBoard, detectMany } from "./sources/detect.js";
import { assessTopJobs, ASSESS_MODEL } from "./assess.js";
import { browserEnabled, runAgent, verifyCredential } from "./agent/session.js";
import {
  clearCredential,
  credentialStatus,
  homeLocation,
  saveCredential,
  setHomeLocation,
  type CredentialKind,
} from "./settings.js";

seedIfEmpty();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

/* ------------------------------------------------------------------- queries */

app.get("/api/health", async () => ({
  ok: true,
  db: DB_PATH,
  model: MODEL,
  assess_model: ASSESS_MODEL,
  browser: browserEnabled,
  credential: credentialStatus(),
  statuses: STATUSES,
}));

/* --------------------------------------------------------------------- setup */

app.get("/api/setup", async () => ({
  credential: credentialStatus(),
  browser: browserEnabled,
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

  saveCredential(kind, token);
  return { credential: credentialStatus() };
});

app.delete("/api/setup/credential", async () => {
  clearCredential();
  return { credential: credentialStatus() };
});

app.get("/api/stats", async () => repo.stats());

app.get("/api/companies", async () => repo.listCompanies());

app.post("/api/companies", async (request, reply) => {
  const body = request.body as { name?: string; ats?: string; board_token?: string };
  if (!body?.name || !body?.ats || !body?.board_token) {
    return reply.code(400).send({ error: "name, ats and board_token are required" });
  }
  return repo.addCompany(body.name, body.ats, body.board_token);
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
      if (row.found) repo.addCompany(row.name, row.found.ats, row.found.board_token);
    }
  }

  return {
    added: body.add === true,
    results: found,
    missing: found.filter((row) => !row.found).map((row) => row.name),
  };
});

app.delete("/api/companies/:id", async (request) => ({
  removed: repo.removeCompany(Number((request.params as { id: string }).id)),
}));

/** Re-score every posting against the profile. Cheap; run after a sync. */
app.post("/api/rank", async (_request, reply) => {
  try {
    return rankAllJobs();
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
  return syncBoards(body.companies);
});

/* ------------------------------------------------------------------- prefs */

/** Where the person works, and so what the job list shows by default. */
app.get("/api/prefs", async () => ({ home_location: homeLocation() }));

app.put("/api/prefs", async (request) => {
  const body = (request.body ?? {}) as { home_location?: string };
  setHomeLocation(body.home_location ?? "");
  return { home_location: homeLocation() };
});

app.get("/api/jobs", async (request) => {
  const q = request.query as Record<string, string | undefined>;
  const list = (value: string | undefined) =>
    value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  // An empty `location` means everywhere, which is different from the
  // parameter being absent — absent falls back to where the person lives.
  const places =
    q.location === undefined ? (homeLocation() ?? "") : q.location;
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

  const jobs = repo.searchJobs(criteria);
  // The total ignores the limit, so the UI can say how much it is not showing.
  return { count: jobs.length, total: repo.countJobs(criteria), jobs };
});

app.get("/api/jobs/:id", async (request, reply) => {
  const id = Number((request.params as { id: string }).id);
  const job = repo.getJob(id);
  if (!job) return reply.code(404).send({ error: `No job with id ${id}` });
  return { ...job, history: repo.applicationHistory(id) };
});

app.get("/api/applications", async (request) => {
  const q = request.query as { status?: string };
  const statuses = q.status ? q.status.split(",") : undefined;
  return repo.listApplications(statuses);
});

app.post("/api/jobs/:id/track", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { note?: string };
    return repo.trackJob(Number((request.params as { id: string }).id), body.note);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});

app.post("/api/jobs/:id/status", async (request, reply) => {
  const body = (request.body ?? {}) as { status?: string; note?: string };
  if (!body.status) return reply.code(400).send({ error: "status is required" });
  try {
    return repo.setStatus(Number((request.params as { id: string }).id), body.status, body.note);
  } catch (error) {
    return reply.code(400).send({ error: (error as Error).message });
  }
});


/* ------------------------------------------------------------------ profile */

const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) =>
  reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });

app.get("/api/profile", async () => ({ ...profile.fullProfile(), empty: profile.isEmpty() }));

app.patch("/api/profile", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const links = Array.isArray(body.links) ? JSON.stringify(body.links) : undefined;
    return profile.updateProfile({ ...(body as object), links } as never);
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
    return profile.updateRole(Number((request.params as { id: string }).id), request.body as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/roles/:id", async (request) => ({
  removed: profile.deleteRole(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/bullets", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { role_id?: number | null; text?: string; skills?: string[] };
    if (!body.text?.trim()) return reply.code(400).send({ error: "text is required" });
    return profile.addBullet(body.role_id ?? null, body.text, body.skills ?? []);
  } catch (error) {
    return bad(reply, error);
  }
});

app.patch("/api/profile/bullets/:id", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { text?: string; skills?: string[] };
    return profile.updateBullet(Number((request.params as { id: string }).id), body.text, body.skills);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/bullets/:id", async (request) => ({
  removed: profile.deleteBullet(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/education", async (request, reply) => {
  try {
    return profile.addEducation(request.body as never);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/education/:id", async (request) => ({
  removed: profile.deleteEducation(Number((request.params as { id: string }).id)),
}));

app.post("/api/profile/skills", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { name?: string; category?: string; years?: number };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
    return profile.addSkill(body.name, body.category, body.years);
  } catch (error) {
    return bad(reply, error);
  }
});

app.delete("/api/profile/skills/:id", async (request) => ({
  removed: profile.deleteSkill(Number((request.params as { id: string }).id)),
}));

/* ------------------------------------------------------------------ resumes */

app.get("/api/resumes", async (request) => {
  const q = request.query as { job_id?: string };
  return resume.listResumes(q.job_id ? Number(q.job_id) : undefined);
});

app.get("/api/resumes/:id", async (request, reply) => {
  try {
    return resume.getResume(Number((request.params as { id: string }).id));
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.get("/api/resumes/:id/markdown", async (request, reply) => {
  try {
    return { markdown: resume.renderMarkdown(Number((request.params as { id: string }).id)) };
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/resumes/:id", async (request) => ({
  removed: resume.deleteResume(Number((request.params as { id: string }).id)),
}));

app.get("/api/jobs/:id/cover-letters", async (request) =>
  resume.listCoverLetters(Number((request.params as { id: string }).id)),
);

app.get("/api/cover-letters", async () => resume.listAllCoverLetters());

app.get("/api/cover-letters/:id", async (request, reply) => {
  try {
    return resume.getCoverLetter(Number((request.params as { id: string }).id));
  } catch (error) {
    return reply.code(404).send({ error: (error as Error).message });
  }
});

app.delete("/api/cover-letters/:id", async (request) => ({
  removed: resume.deleteCoverLetter(Number((request.params as { id: string }).id)),
}));

/* ---------------------------------------------------------------------- chat */


app.post("/api/conversations", async (request) => {
  const body = (request.body ?? {}) as { title?: string };
  return { id: repo.createConversation(body.title) };
});

app.get("/api/conversations/:id/messages", async (request) =>
  repo.listMessages(Number((request.params as { id: string }).id)),
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

  const conversationId = body.conversationId ?? repo.createConversation(body.message.slice(0, 80));
  repo.addMessage(conversationId, "user", body.message);

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
      resume: repo.getSdkSessionId(conversationId),
      signal: controller.signal,
    })) {
      if (event.type === "session") repo.setSdkSessionId(conversationId, event.sessionId);
      if (event.type === "text") replyText.push(event.text);
      send(event);
    }
  } catch (error) {
    send({ type: "error", message: (error as Error).message });
  }

  if (replyText.length > 0) {
    repo.addMessage(conversationId, "assistant", replyText.join("\n\n"));
  }
  finished = true;
  send({ type: "end" });
  reply.raw.end();
});

await app.listen({ port: PORT, host: "127.0.0.1" });
app.log.info(`jobsearch server on http://127.0.0.1:${PORT} — database ${DB_PATH}`);
if (!credentialStatus().set) {
  app.log.warn("No Claude credential yet. Open the app and finish Setup.");
}
