/**
 * Something the page wants to say to the assistant.
 *
 * A local bus, in the shape of changes.ts, because the two components that
 * need to talk are siblings: the profile page is where somebody keeps or
 * skips a proposed change, and the chat is where the conversation about it
 * continues. Threading a callback from App through both would work and would
 * also mean every future component that wants to say something edits App.
 *
 * It carries a sentence in the person's own voice, because that is what it
 * is — their answer, arriving by click rather than by typing.
 */

type Listener = (said: string) => void;

const listeners = new Set<Listener>();

export function onSay(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function say(said: string): void {
  for (const listener of listeners) listener(said);
}
