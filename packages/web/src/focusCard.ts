/**
 * Calling the open question back into view.
 *
 * A card scrolls itself into view when it arrives, which covers the case it
 * was built for: the assistant asks, and the question is in front of you.
 * It does not cover the case of somebody who has scrolled away, or gone to
 * another tab, and now wants to get back to the thing they were asked.
 *
 * That happened at the top of the thread. While a turn is running the
 * Continue button is disabled, correctly — there is nothing to continue,
 * something is already being asked — and a disabled button is a dead end
 * exactly when the person is looking for where the question went. So it is
 * replaced by one that brings them back to it, and this is how the button
 * reaches a card it does not own.
 *
 * Deliberately not state: there is nothing to remember. "Show me the card"
 * is an event, and a card that is not on the screen to hear it is a card
 * that will scroll itself into view when it mounts anyway.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Bring the waiting card back into view, wherever it is. */
export function showCard(): void {
  for (const listener of listeners) listener();
}

/** A card, saying where it is. Returns the unsubscribe. */
export function onShowCard(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
