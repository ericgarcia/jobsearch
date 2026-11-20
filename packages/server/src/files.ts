import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { all, get, run } from "./db/client.js";
import { changed } from "./notify.js";

/**
 * Folders on this computer the person has let the assistant read.
 *
 * The assistant had no way to read a file at all, which came up the moment
 * it was asked about work that lives on disk: a resume in Documents, a repo
 * whose README says what a project does, a cover letter written last year.
 * It could only ask the person to paste it in.
 *
 * Reading somebody's disk is not a small thing to hand over, so the shape
 * here is the narrowest one that does the job:
 *
 * Nothing is readable by default. A folder becomes readable when the person
 * says so, in answer to a request that names the folder and says why. The
 * assistant can ask; only the person can grant.
 *
 * It is read-only. There is no tool here that writes, moves or deletes, and
 * none that runs anything. The worst a mistake can do is show the assistant
 * a file it did not need.
 *
 * And the check is on the resolved path, not the one that was typed. A
 * grant on ~/Documents is a grant on what ~/Documents really is: `..` is
 * resolved away before the comparison, and a symbolic link inside it that
 * points at ~/.ssh resolves to ~/.ssh, which is not inside the grant and is
 * refused. Comparing the strings as given would make either of those a way
 * out of the folder the person chose.
 *
 * Dot-files and dot-folders are refused inside a grant as well. Somebody
 * allowing ~/code is allowing their code, and they are not thinking about
 * ~/code/.env or ~/code/.ssh while they do it. The things most worth
 * protecting on a developer's disk are nearly all named with a leading dot,
 * so the line is drawn there rather than at a list of filenames that would
 * always be one name short.
 */

/** How much of one file to read. Beyond this it is cut and says so. */
const MOST_BYTES = 256 * 1024;

/** How many entries one listing gives back. */
const MOST_ENTRIES = 500;

/*
  Names that are secrets even without a leading dot. The dot rule above
  catches most of what matters; this catches the rest, and is deliberately
  short — a long list reads as thorough and is still not a boundary. The
  boundary is that the person picks the folder.
*/
const SECRET = [
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks|keychain)$/i,
  /^credentials$/i,
  /^\.?netrc$/i,
];

export interface Grant {
  id: number;
  /** Absolute and resolved, which is what every check compares against. */
  path: string;
  why: string | null;
  at: string;
}

export interface Request {
  path: string;
  why: string;
  at: string;
}

/** The folders that are readable now. */
export async function grants(): Promise<Grant[]> {
  return await all<Grant>(
    `SELECT id, path, why, at FROM folder_grants
      WHERE revoked_at IS NULL ORDER BY at DESC, id DESC`,
  );
}

/**
 * The folder the assistant is waiting to be allowed, if any.
 *
 * One slot, for the same reason the proposals have one: a queue of requests
 * is a dialog box repeated, and the honest way to ask for a second folder is
 * after the first has been answered.
 */
export async function pendingRequest(): Promise<Request | null> {
  return (
    (await get<Request>(`SELECT path, why, at FROM pending_grant WHERE id = 1`)) ?? null
  );
}

/** Whether this path is already inside something the person allowed. */
export async function allowed(real: string): Promise<Grant | null> {
  for (const grant of await grants()) {
    if (real === grant.path || real.startsWith(grant.path + path.sep)) return grant;
  }
  return null;
}

class Refused extends Error {}

/** Said to the assistant, so the refusal tells it what to do instead. */
function refuse(why: string): never {
  throw new Refused(why);
}

/**
 * The path this really is, or a refusal.
 *
 * Every read goes through here. It resolves first and checks second, which
 * is the whole point: the string the assistant passed is not evidence of
 * where it leads.
 */
async function resolved(given: string): Promise<string> {
  if (!given || !path.isAbsolute(given)) {
    refuse(`"${given}" is not an absolute path. Give the full path, starting from /.`);
  }

  let real: string;
  try {
    real = await realpath(given);
  } catch {
    refuse(`There is nothing at "${given}".`);
  }

  const grant = await allowed(real);
  if (!grant) {
    refuse(
      `"${real}" is not in a folder you are allowed to read. Call ask_for_folder with the folder you need and why, and the person decides.`,
    );
  }

  /*
    Inside the grant, but hidden. Checked on the part below the grant only:
    a person who allows ~/.config/jobsearch has allowed a dot-folder on
    purpose, and refusing their own choice would be the rule outliving its
    reason.
  */
  const below = path.relative(grant.path, real);
  if (below.split(path.sep).some((part) => part.startsWith("."))) {
    refuse(
      `"${real}" is hidden, and hidden files are not covered by a grant on a folder. If you need it, ask for it by name with ask_for_folder.`,
    );
  }
  if (SECRET.some((pattern) => pattern.test(path.basename(real)))) {
    refuse(`"${path.basename(real)}" looks like a secret, so it is not readable.`);
  }

  return real;
}

export interface Entry {
  name: string;
  kind: "file" | "folder";
  /** Bytes, for a file. */
  size?: number;
}

export interface Listing {
  path: string;
  entries: Entry[];
  /** Said when there was more than one listing holds. */
  note?: string;
}

/** What is in a folder the person allowed. */
export async function listFolder(given: string): Promise<Listing> {
  const real = await resolved(given);
  const info = await stat(real);
  if (!info.isDirectory()) refuse(`"${real}" is a file, not a folder. Read it with read_file.`);

  const found = await readdir(real, { withFileTypes: true });
  const visible = found.filter((one) => !one.name.startsWith("."));
  const hidden = found.length - visible.length;

  /*
    Each entry as what it really is.

    A link is listed when it leads somewhere inside the grant and left out
    when it leads outside — listing it either way would offer a name that
    the read then refuses, and omitting it either way would hide a file that
    is genuinely in the folder. So the same resolve-then-check that guards a
    read decides what a listing shows, and the count of what it left out is
    said rather than passed over.
  */
  const entries: Entry[] = [];
  let outside = 0;
  for (const one of visible.slice(0, MOST_ENTRIES)) {
    const full = path.join(real, one.name);
    let info;
    try {
      info = await stat(full);
      if (one.isSymbolicLink() && !(await allowed(await realpath(full)))) {
        outside += 1;
        continue;
      }
    } catch {
      /* A broken link, or something that went while we were reading. */
      continue;
    }
    if (info.isDirectory()) entries.push({ name: one.name, kind: "folder" });
    else if (info.isFile()) entries.push({ name: one.name, kind: "file", size: info.size });
    /* Anything else — a socket, a device — is not something to read. */
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
  );

  const notes: string[] = [];
  if (visible.length > MOST_ENTRIES) {
    notes.push(`${visible.length} entries; the first ${MOST_ENTRIES} are listed.`);
  }
  if (hidden > 0) {
    notes.push(`${hidden} hidden ${hidden === 1 ? "entry is" : "entries are"} not listed.`);
  }
  if (outside > 0) {
    notes.push(
      `${outside} ${outside === 1 ? "link leads" : "links lead"} outside this folder and ${outside === 1 ? "is" : "are"} not listed.`,
    );
  }

  return { path: real, entries, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
}

export interface FileText {
  path: string;
  text: string;
  bytes: number;
  /** True when the file was longer than one read gives back. */
  cut: boolean;
}

/** The text of a file in a folder the person allowed. */
export async function readText(given: string): Promise<FileText> {
  const real = await resolved(given);
  const info = await stat(real);
  if (info.isDirectory()) {
    refuse(`"${real}" is a folder, not a file. List it with list_folder.`);
  }
  if (!info.isFile()) refuse(`"${real}" is not an ordinary file.`);

  const raw = await readFile(real);
  const head = raw.subarray(0, 8192);
  /*
    Binary, which there is no point handing to a model as mojibake. A zero
    byte in the first few kilobytes is the cheap test and it is right about
    every format this would meet: an image, a PDF, an archive, a compiled
    thing.
  */
  if (head.includes(0)) {
    refuse(
      `"${path.basename(real)}" is not text (${info.size} bytes). Ask the person to drop it into the conversation instead — the app reads PDFs and zips that way.`,
    );
  }

  const kept = raw.subarray(0, MOST_BYTES);
  return {
    path: real,
    text: kept.toString("utf8"),
    bytes: info.size,
    cut: raw.length > MOST_BYTES,
  };
}

/**
 * Ask for a folder.
 *
 * The request is stored rather than answered here, because the answer is not
 * the assistant's to give. The page shows it, the person allows or refuses
 * it, and until then nothing in that folder is readable.
 */
export async function askForFolder(
  given: string,
  why: string,
): Promise<{ asked: Request } | { already: Grant }> {
  if (!given || !path.isAbsolute(given)) {
    refuse(`"${given}" is not an absolute path. Ask for the full path, starting from /.`);
  }
  if (!why.trim()) refuse("Say why you need it, in one line. The person reads it before deciding.");

  let real: string;
  try {
    real = await realpath(given);
  } catch {
    refuse(`There is nothing at "${given}", so there is nothing to ask for.`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) {
    refuse(`"${real}" is a file. Ask for the folder it is in.`);
  }

  const have = await allowed(real);
  if (have) return { already: have };

  await run(
    `INSERT OR REPLACE INTO pending_grant (id, path, why, at)
          VALUES (1, ?, ?, datetime('now'))`,
    real,
    why.trim(),
  );
  changed("files");
  return { asked: (await pendingRequest())! };
}

/** Their answer, which is the only thing that grants. */
export async function answerRequest(allow: boolean): Promise<{ granted: Grant | null }> {
  const asked = await pendingRequest();
  if (!asked) throw new Error("No folder is waiting to be decided.");

  await run(`DELETE FROM pending_grant WHERE id = 1`);
  if (!allow) {
    changed("files");
    return { granted: null };
  }

  await run(
    `INSERT INTO folder_grants (path, why, at) VALUES (?, ?, datetime('now'))
       ON CONFLICT (path) DO UPDATE SET why = excluded.why, at = excluded.at, revoked_at = NULL`,
    asked.path,
    asked.why,
  );
  changed("files");
  const made = await get<Grant>(
    `SELECT id, path, why, at FROM folder_grants WHERE path = ?`,
    asked.path,
  );
  return { granted: made ?? null };
}

/**
 * Theirs to take back.
 *
 * Marked rather than deleted, so the admin page can show what was allowed
 * once and is not any more. A revoked grant stops every read immediately,
 * since every read asks this table rather than a copy of it.
 */
export async function revokeGrant(id: number): Promise<{ revoked: boolean }> {
  const done = await run(
    `UPDATE folder_grants SET revoked_at = datetime('now')
      WHERE id = ? AND revoked_at IS NULL`,
    id,
  );
  if (done.changes > 0) changed("files");
  return { revoked: done.changes > 0 };
}
