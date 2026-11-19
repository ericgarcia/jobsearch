import { useEffect, useState } from "react";

/**
 * Which waiting question is actually on the screen.
 *
 * The card that asks about a change is painted over the thing it would
 * change, which is the right way round — the question is asked where the
 * answer will land — but it means a question about something the page does
 * not render is a question nobody is asked. The assistant says its piece in
 * the conversation, the person looks at their profile, and nothing is there.
 *
 * That failed three times in three different ways: a pane listening for the
 * wrong topic, a field that could not re-render, and a fact with no row at
 * all. Each was fixed where it broke, and each was invisible until somebody
 * noticed the highlight was missing. So rather than a fourth fix of the same
 * shape, every card says it is on the screen, and anything that notices a
 * waiting question nobody claimed can show it plainly instead.
 *
 * A proposal is identified by `at`, the moment it was made, since there is
 * only ever one waiting and the time it arrived is already unique.
 */

let claimedAt: string | null = null;
const watchers = new Set<() => void>();

function tell(): void {
  for (const watcher of [...watchers]) watcher();
}

/** Said by a card as it appears. */
export function claim(at: string): void {
  claimedAt = at;
  tell();
}

/**
 * Said as it goes away, by the card that claimed it.
 *
 * Guarded on the value because React mounts the next card before unmounting
 * the last one, and an unguarded release would have the newcomer wipe its
 * own claim on the way past.
 */
export function release(at: string): void {
  if (claimedAt !== at) return;
  claimedAt = null;
  tell();
}

/** Whether this exact question has a card somewhere on the screen. */
export function useClaimed(at: string | null): boolean {
  const [claimed, setClaimed] = useState(() => at != null && claimedAt === at);

  useEffect(() => {
    const look = () => setClaimed(at != null && claimedAt === at);
    look();
    watchers.add(look);
    return () => {
      watchers.delete(look);
    };
  }, [at]);

  return claimed;
}
