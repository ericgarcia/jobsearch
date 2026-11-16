import { useEffect, useRef, useState } from "react";

/**
 * Listening for "this changed", from wherever it came.
 *
 * One EventSource for the whole page, shared by every component that cares.
 * A connection each would be a connection each: the browser caps them per
 * origin, and six components watching six streams would starve the chat.
 */

export type Topic = "profile" | "projects" | "sections" | "layout" | "interests" | "resumes";

type Listener = (topic: Topic) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect(): void {
  if (source) return;
  source = new EventSource("/api/events");

  source.onmessage = (event) => {
    try {
      const change = JSON.parse(event.data) as { topic: Topic };
      for (const listener of [...listeners]) listener(change.topic);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  };

  /*
    EventSource reconnects by itself, and that is usually what you want. It
    is not enough here: while it was away, changes happened that nobody will
    resend. So on reconnection every listener is told its topic changed, and
    they refetch. A spurious refetch costs one request; a missed one leaves
    the page quietly wrong, which is the failure this whole mechanism exists
    to prevent.
  */
  source.onerror = () => {
    if (source?.readyState === EventSource.CONNECTING) {
      for (const listener of [...listeners]) listener("profile");
    }
  };
}

/**
 * Refetch when `topic` changes.
 *
 * `isBusy` is how a form protects itself. A component with unsaved text in
 * it should not be replaced from the server mid-sentence, so it says it is
 * busy and takes the update when it is not. Without this, an agent writing
 * to the profile while someone types a project narrative would take the
 * paragraph away as they wrote it.
 */
export function useChanges(topic: Topic, reload: () => void, isBusy?: () => boolean): boolean {
  const latest = useRef({ reload, isBusy });
  latest.current = { reload, isBusy };

  const missed = useRef(false);
  // Mirrored into state so a component can say it is holding something.
  // Silently withholding an update is how a page ends up quietly wrong.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    connect();

    const listener = (changedTopic: Topic) => {
      if (changedTopic !== topic) return;
      if (latest.current.isBusy?.()) {
        missed.current = true;
        setHeld(true);
        return;
      }
      latest.current.reload();
    };

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [topic]);

  /*
    Take a held update as soon as the form stops being busy. Checked on a
    timer rather than driven by the component, because "I have finished
    editing" is not an event React gives us, and a second of staleness after
    someone saves is not worth a callback in every caller.
  */
  useEffect(() => {
    const timer = setInterval(() => {
      if (missed.current && !latest.current.isBusy?.()) {
        missed.current = false;
        setHeld(false);
        latest.current.reload();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return held;
}
