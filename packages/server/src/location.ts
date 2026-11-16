/**
 * Matching a posting's location against a place the person will work.
 *
 * Boards write location however they like. Real examples from the stored data:
 *
 *   New York, NY
 *   San Francisco, CA | New York City, NY | Seattle, WA
 *   NY, SF, Chicago, Remote
 *   US-Remote; US-Chicago; US-Atlanta; CA-Toronto; CA-Remote
 *   New York City Metropolitan Area
 *   Dublin or London
 *
 * A substring test is wrong in both directions: "New York" misses the posting
 * written "NY, SF, Chicago", and "NY" matches "Germany". So a short needle is
 * compared against the location's separate parts, and a long one against the
 * whole string.
 */

/** Split a location into the places it names. */
function parts(location: string): string[] {
  return location
    .toLowerCase()
    .split(/[,;|/()]+|\s+or\s+|\s+-\s+/)
    .flatMap((piece) => {
      const trimmed = piece.trim();
      // "us-remote" and "ca-toronto" carry a country prefix on the same token.
      return trimmed.includes("-") ? [trimmed, ...trimmed.split("-")] : [trimmed];
    })
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/**
 * Does this location include this place?
 * Needles of four characters or more are matched against the whole string, so
 * "new york" finds "New York City Metropolitan Area". Shorter ones are matched
 * against the parts only, so "ny" finds "NY, SF" but not "Germany".
 */
export function locationMatches(location: string | null, needle: string): boolean {
  if (!location) return false;
  const want = needle.trim().toLowerCase();
  if (!want) return false;

  if (want.length >= 4) return location.toLowerCase().includes(want);
  return parts(location).includes(want);
}

/**
 * The parts of a location, in a form SQL can match against.
 *
 * `locationMatches` used to run inside SQLite, as a function registered on the
 * connection. libSQL cannot do that: the query runs on Turso's server, where
 * this process's JavaScript does not exist. So the same split is done once,
 * when a job is written, and stored.
 *
 * Delimiters at both ends and between every part, so `LIKE '%|ny|%'` means the
 * part "ny" and never the "ny" inside "germany". That is the short-needle rule
 * from `locationMatches`, expressed in SQL; the long-needle rule needs no
 * tokens, because matching the whole string is what LIKE already does.
 */
export const TOKEN_EDGE = "|";

export function locationTokens(location: string | null): string {
  if (!location) return TOKEN_EDGE;
  return TOKEN_EDGE + parts(location).join(TOKEN_EDGE) + TOKEN_EDGE;
}

/** The SQL fragment and parameter that match one needle. Mirrors locationMatches. */
export function locationClause(needle: string): { sql: string; param: string } | null {
  const want = needle.trim().toLowerCase();
  if (!want) return null;
  return want.length >= 4
    ? { sql: "LOWER(COALESCE(j.location, '')) LIKE ?", param: `%${want}%` }
    : { sql: "COALESCE(j.location_tokens, '') LIKE ?", param: `%${TOKEN_EDGE}${want}${TOKEN_EDGE}%` };
}

/**
 * Short forms that boards use for the same place. Only the ones that are
 * genuinely ambiguous to a substring test are worth listing; anything else is
 * already handled by matching the full name.
 */
const ALIASES: Record<string, string[]> = {
  "new york": ["new york", "nyc", "ny"],
  brooklyn: ["new york", "nyc", "ny", "brooklyn"],
  "san francisco": ["san francisco", "sf", "bay area"],
  "los angeles": ["los angeles", "la"],
  "washington": ["washington", "dc"],
  boston: ["boston", "ma"],
  seattle: ["seattle", "wa"],
  chicago: ["chicago", "il"],
  austin: ["austin", "tx"],
  london: ["london", "uk"],
};

/**
 * Expand one place into the forms a board might use.
 * Unknown places are returned as themselves: the long-needle rule handles them.
 */
export function expandPlace(place: string): string[] {
  const key = place.trim().toLowerCase();
  if (ALIASES[key]) return ALIASES[key];

  // "New York, New York, United States" from a profile: take the city.
  const city = key.split(",")[0]?.trim() ?? key;
  return ALIASES[city] ?? [city];
}
