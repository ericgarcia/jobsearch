/**
 * Checks on generated text.
 *
 * A resume line is built from a stored bullet, so the agent cannot invent a
 * whole job: the tool takes a bullet id, not free text. What it can still do is
 * drift while rewording one — and the drift that matters is numeric. "Led a
 * team of 3" becoming "led a team of 30" is the failure that gets someone
 * caught in an interview, and it is the one a machine can catch reliably.
 *
 * These checks warn. They never block, because a legitimate rewording may
 * combine or convert figures. The warning travels with the line so the person
 * sees it before the resume goes out.
 */

/** Numbers, with the punctuation and units that usually ride along. */
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|bn?\b|x\b)?/gi;

/** Strip formatting so "1,200" and "1200" compare equal. */
function normalise(token: string): string {
  return token.toLowerCase().replace(/[$,\s]/g, "");
}

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map(normalise);
}

/**
 * Compare a reworded line with the fact it came from.
 * Returns one warning for each figure that the source does not support.
 */
export function checkRendering(source: string, rendered: string): string[] {
  if (!rendered || rendered.trim() === source.trim()) return [];

  const supported = new Set(numbersIn(source));
  const warnings: string[] = [];

  for (const figure of new Set(numbersIn(rendered))) {
    if (!supported.has(figure)) {
      warnings.push(`The figure "${figure}" is not in the stored bullet.`);
    }
  }
  return warnings;
}

/**
 * Compare free prose, such as a cover letter, with everything stored in the
 * profile. A figure that appears nowhere in the profile is worth a look.
 */
export function checkAgainstCorpus(corpus: string, generated: string): string[] {
  const supported = new Set(numbersIn(corpus));
  const warnings: string[] = [];

  for (const figure of new Set(numbersIn(generated))) {
    // Four-digit years are almost always dates, not claims about results.
    if (/^(19|20)\d{2}$/.test(figure)) continue;
    if (!supported.has(figure)) {
      warnings.push(`The figure "${figure}" does not appear anywhere in your profile.`);
    }
  }
  return warnings;
}
