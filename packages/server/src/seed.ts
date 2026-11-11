import { addCompany, listCompanies } from "./repo.js";

/**
 * A starter set of boards, so a new database is useful immediately.
 * Replace these with your own targets; `ats` must be greenhouse, lever or ashby.
 */
const STARTER_BOARDS: [name: string, ats: string, token: string][] = [
  ["Anthropic", "greenhouse", "anthropic"],
  ["Stripe", "greenhouse", "stripe"],
  ["Ramp", "ashby", "ramp"],
  ["Linear", "ashby", "linear"],
  ["Spotify", "lever", "spotify"],
  ["Palantir", "lever", "palantir"],
];

/** Insert the starter boards, but only into an empty database. */
export function seedIfEmpty(): void {
  if (listCompanies().length > 0) return;
  for (const [name, ats, token] of STARTER_BOARDS) addCompany(name, ats, token);
}
