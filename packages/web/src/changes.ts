import { useEffect, useRef, useState } from "react";

/**
 * Listening for "this changed", from wherever it came.
 *
 * One EventSource for the whole page, shared by every component that cares.
 * A connection each would be a connection each: the browser caps them per
 * origin, and six components watching six streams would starve the chat.
 */

export type Topic =
  | "profile"
  | "projects"
  | "sections"
  | "layout"
  | "interests"
  | "resumes"
  | "threads"
  | "applications"
  /* What the assistant is proposing to change, and which field to look at. */
  | "focus"
  /* Folders on this computer the assistant may read, and requests for more. */
  | "files";

type Listener = (topic: Topic) => void;

/*
  Each listener with the topics it is waiting for, so that a reconnection can
  tell it about its own rather than about somebody else's. See the note on
  onerror below for what that cost.

  Topics plural because one component can care about two things. The stored
  answers are a case: the card proposing a change arrives on "focus" and the
  value it writes lands on "profile", so a pane listening to one of them
  shows the question and then never shows the answer.
*/
const listeners = new Map<Listener, Topic[]>();
let source: EventSource | null = null;
/** A reconnection already on its way, so a burst of errors makes one. */
let retry: ReturnType<typeof setTimeout> | null = null;
/** When this stream last said anything, beats included. */
let heard = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

function again(): void {
  if (retry !== null) return;
  source?.close();
  source = null;
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, 2000);
}

function connect(): void {
  if (source) return;
  heard = Date.now();
  source = new EventSource("/api/events");

  source.onmessage = (event) => {
    try {
      const change = JSON.parse(event.data) as { topic: Topic | "beat" };
      heard = Date.now();
      /* The beat is only there to be heard. See the watchdog below. */
      if (change.topic === "beat") return;
      for (const listener of [...listeners.keys()]) listener(change.topic);
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  };

  /*
    EventSource reconnects by itself, and that is usually what you want. It
    is not enough here: while it was away, changes happened that nobody will
    resend. So on every connection each listener is told its own topic
    changed, and refetches. A spurious refetch costs one request; a missed
    one leaves the page quietly wrong, which is the failure this whole
    mechanism exists to prevent.

    On open, not on error. Two things were wrong with doing it in onerror.
    It fired on the way down — readyState CONNECTING means "lost it, about to
    retry", so the refetches went to a server that was not there and the one
    that came back was never announced. And it told every listener that
    "profile" had changed, which only the profile listeners were waiting for,
    so every other topic stopped updating for good.

    What that looked like: the assistant proposed a change to a line on the
    profile, said so, and the page showed nothing. The proposal was in the
    database and correct; the page had simply never been told, because it
    was listening for "focus" and the reconnection had said "profile" to a
    server that was still down.
  */
  source.onopen = () => {
    /* Any one of its topics: the listener refetches whole, once. */
    for (const [listener, topics] of [...listeners]) listener(topics[0]!);
  };

  /*
    And putting it back, because the browser will not always do it.

    EventSource retries a connection that drops cleanly, and gives up for
    good on one that answers with an error — which is exactly what happens
    here. The dev server proxies /api to the backend, so while the backend is
    restarting the proxy answers with an error page, the browser marks the
    stream CLOSED, and the page stops hearing about anything for the rest of
    its life. Nothing looks broken: the data is right, the page is just no
    longer being told.

    So a stream the browser has given up on is replaced, with a pause so a
    backend that is still starting is not hammered.
  */
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) again();
  };

  /*
    And the case the browser does not report at all: a connection that is
    open and dead. The server beats every 25 seconds, so a minute of silence
    means this stream is finished whatever readyState claims — start another.
  */
  if (watchdog === null) {
    watchdog = setInterval(() => {
      if (heard > 0 && Date.now() - heard > 60_000) again();
    }, 15_000);
  }
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
export function useChanges(
  topic: Topic | Topic[],
  reload: () => void,
  isBusy?: () => boolean,
): boolean {
  const latest = useRef({ reload, isBusy });
  latest.current = { reload, isBusy };

  const missed = useRef(false);
  // Mirrored into state so a component can say it is holding something.
  // Silently withholding an update is how a page ends up quietly wrong.
  const [held, setHeld] = useState(false);

  /* A stable identity for the effect, so an array literal does not resubscribe. */
  const wanted = Array.isArray(topic) ? topic : [topic];
  const key = wanted.join(",");

  useEffect(() => {
    connect();
    const topics = key.split(",") as Topic[];

    const listener = (changedTopic: Topic) => {
      if (!topics.includes(changedTopic)) return;
      if (latest.current.isBusy?.()) {
        missed.current = true;
        setHeld(true);
        return;
      }
      latest.current.reload();
    };

    listeners.set(listener, topics);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);

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
