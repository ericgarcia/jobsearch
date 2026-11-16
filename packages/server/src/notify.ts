import { EventEmitter } from "node:events";

/**
 * "Something changed" — raised by the code that changes it.
 *
 * The signal used to ride on the chat stream, which meant it only existed
 * while the agent was talking. A change has three possible sources: the
 * agent, the person editing the page, and anything calling the HTTP API. One
 * of those was covered.
 *
 * So the write functions raise it themselves. That is the whole design
 * decision here: if a route emitted and the matching tool did not, the two
 * would drift, and the symptom would be a page that is quietly out of date —
 * which nobody reports as a bug, they just reload. Emitting from the data
 * layer means a new caller cannot forget.
 *
 * This is a local emitter. It knows nothing about HTTP; the event route is
 * one subscriber among any others.
 */

export type Topic =
  | "profile"
  | "projects"
  | "sections"
  | "layout"
  | "interests"
  | "resumes"
  | "threads";

export interface Change {
  topic: Topic;
  at: string;
}

const bus = new EventEmitter();
// One per browser tab, and a person may have several open. The default of 10
// prints a leak warning long before that is actually a leak.
bus.setMaxListeners(50);

/** Say that a topic's stored data is now different. */
export function changed(topic: Topic): void {
  bus.emit("change", { topic, at: new Date().toISOString() } satisfies Change);
}

/** Listen. Returns the function that stops listening. */
export function onChange(listener: (change: Change) => void): () => void {
  bus.on("change", listener);
  return () => bus.off("change", listener);
}
