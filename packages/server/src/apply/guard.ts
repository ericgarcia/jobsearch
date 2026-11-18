/**
 * The thing that is not allowed to happen.
 *
 * An application cannot be taken back. Once it is sent, a half-finished
 * letter or an answer meant for a different company is somewhere a person
 * wanted to work, permanently, and no apology undoes it. So sending one is
 * the person's, every time.
 *
 * Saying that in the prompt is not the same as making it true. A rule the
 * model can break is a rule the person has to re-check on every turn, which
 * is the opposite of a guarantee. This refuses it in the tool layer instead:
 * while the page is an application form, a click on anything that looks like
 * the send button does not reach the browser at all.
 *
 * It is a lock on the obvious door rather than a proof. A determined model
 * could describe the submit button as something else, or press Enter in a
 * single-field form. What it does give is that the ordinary path — fill the
 * form, then click the obvious button — stops, every time, without anyone
 * having to watch for it.
 */

/** Pages where an application is sent. */
const APPLY_PAGE =
  /(?:boards|job-boards)\.greenhouse\.io\/|jobs\.lever\.co\/[^/]+\/[^/]+\/apply|jobs\.ashbyhq\.com\/[^/]+\/[^/]+\/application|\/apply(?:\/|$|\?)|\/application(?:\/|$|\?)/i;

/**
 * Words that send something.
 *
 * "Continue" and "Next" are in here too. A multi-page application sends
 * itself one page at a time, and the last Next is a submit wearing a
 * different word.
 */
const SENDS =
  /\b(?:submit|apply now|apply\b|send(?:\s+application)?|finish|complete application|continue|next\b|i'?m done)\b/i;

export interface Refusal {
  refused: true;
  reason: string;
}

/**
 * Whether a click should be stopped, given where the page is and what the
 * caller says it is clicking.
 *
 * Pure, so the rule can be tested without a browser.
 */
export function wouldSend(url: string | null, description: string): boolean {
  if (!url || !APPLY_PAGE.test(url)) return false;
  return SENDS.test(description);
}

export function refusal(description: string): Refusal {
  return {
    refused: true,
    reason:
      `Not done from here: "${description}" looks like the control that sends the application, and sending it is the person's. ` +
      "Tell them it is filled in and ready, say what you left for them, and let them press it. " +
      "This is refused by the app rather than by instruction, so asking again will not change it.",
  };
}
