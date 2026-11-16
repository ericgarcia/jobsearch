import { get as dbGet, run } from "./db/client.js";

export type CredentialKind = "oauth-token" | "api-key";

const CREDENTIAL = "agent_credential";
const CREDENTIAL_KIND = "agent_credential_kind";

async function get(key: string): Promise<string | null> {
  const row = await dbGet<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
  return row?.value ?? null;
}

async function put(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
  );
}

export interface Credential {
  kind: CredentialKind;
  token: string;
}

/**
 * The agent credential, from the database first and the environment second.
 * Callers pass it to the Agent SDK subprocess. It is never sent to the client.
 */
export async function readCredential(): Promise<Credential | null> {
  const [stored, storedKind] = await Promise.all([get(CREDENTIAL), get(CREDENTIAL_KIND)]);
  if (stored && (storedKind === "oauth-token" || storedKind === "api-key")) {
    return { kind: storedKind, token: stored };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { kind: "oauth-token", token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: "api-key", token: process.env.ANTHROPIC_API_KEY };
  }
  return null;
}

export async function saveCredential(kind: CredentialKind, token: string): Promise<void> {
  put(CREDENTIAL, token.trim());
  put(CREDENTIAL_KIND, kind);
}

export async function clearCredential(): Promise<void> {
  await run(`DELETE FROM settings WHERE key IN (?, ?)`, CREDENTIAL, CREDENTIAL_KIND);
}

/** The last four characters, so the user can tell which credential is stored. */
function maskOf(token: string): string {
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

/** Everything the client may know about the credential. Never the value. */
export async function credentialStatus() {
  const credential = await readCredential();
  const fromEnv = (await get(CREDENTIAL)) == null && credential != null;
  return {
    set: credential != null,
    kind: credential?.kind ?? null,
    masked: credential ? maskOf(credential.token) : null,
    source: credential ? (fromEnv ? "env" : "database") : null,
  };
}

/**
 * Build the environment for the Agent SDK subprocess. Exactly one credential
 * variable is set, so a stale one in the shell cannot win.
 */
export function credentialEnv(credential: Credential): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && key !== "CLAUDE_CODE_OAUTH_TOKEN" && key !== "ANTHROPIC_API_KEY") {
      base[key] = value;
    }
  }
  if (credential.kind === "oauth-token") base.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
  else base.ANTHROPIC_API_KEY = credential.token;
  return base;
}

/* ------------------------------------------------------------------ search */

const HOME_LOCATION = "home_location";

/**
 * Where the person is. Defaults to the city in their profile, so the job list
 * is local out of the box rather than showing every city the boards cover.
 */
export async function homeLocation(): Promise<string | null> {
  const stored = await get(HOME_LOCATION);
  if (stored !== null) return stored.trim() === "" ? null : stored;

  const row = await dbGet<{ location: string | null }>(
    `SELECT location FROM profile WHERE id = 1`,
  );
  const city = row?.location?.split(",")[0]?.trim();
  return city && city.length > 0 ? city : null;
}

/* -------------------------------------------------------------- the bar */

const MATCH_BAR = "match_threshold";

/*
  How good a match a posting has to be before it is worth storing.

  A setting rather than a constant, because it is a judgement about this
  person's search and not about the software. A board is the company's whole
  list: at 40 one company contributed 208 postings out of 660, which is not
  a shortlist. Scores run to 65, so 50 keeps roughly the top quarter.
*/
export const DEFAULT_MATCH_BAR = 50;

export async function matchBar(): Promise<number> {
  const stored = Number(await get(MATCH_BAR));
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_MATCH_BAR;
}

export async function setMatchBar(score: number): Promise<number> {
  const wanted = Math.round(Math.min(65, Math.max(0, score)));
  await put(MATCH_BAR, String(wanted));
  return wanted;
}

/** Pass an empty string to search everywhere. */
export async function setHomeLocation(place: string): Promise<void> {
  put(HOME_LOCATION, place.trim());
}
