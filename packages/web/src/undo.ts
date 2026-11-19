import { useCallback, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";

/**
 * Undo that belongs to the field you are typing in.
 *
 * Cmd-Z in one of this app's boxes used to reach past it: somebody editing a
 * proposed line pressed it and the chat composer gave back text they had
 * already sent. The browser applies undo to the focused editable, and when
 * that element has no history of its own it looks further — and a React
 * field has no history worth the name. A controlled box has its value
 * rewritten from state on every keystroke, and an uncontrolled one is
 * replaced outright whenever what it shows changes.
 *
 * So each field keeps its own, and swallows the key rather than letting it
 * travel. The history is a list of values with the cursor where it was, and
 * typing is coalesced: a run of characters with no pause is one step, which
 * is what somebody means by "undo that".
 *
 * The value is put back through the element's own setter and announced as an
 * input event, so a controlled box and an uncontrolled one both notice.
 */

interface Step {
  value: string;
  start: number;
  end: number;
}

/** A pause long enough that what follows is a separate thing to undo. */
const APART = 500;

type Field = HTMLInputElement | HTMLTextAreaElement;

function put(node: Field, step: Step): void {
  const prototype =
    node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(node, step.value);
  node.setSelectionRange(step.start, step.end);
  /* So a controlled field's state follows, rather than snapping back. */
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useFieldHistory(): {
  onKeyDown: (event: KeyboardEvent<Field>) => void;
  onBeforeInput: (event: FormEvent<Field>) => void;
} {
  const past = useRef<Step[]>([]);
  const future = useRef<Step[]>([]);
  const last = useRef(0);
  /*
    Putting a value back announces an input event, so that a controlled box
    follows. That event is not somebody typing, and treating it as typing
    threw away the redo stack the moment an undo used it.
  */
  const applying = useRef(false);

  /*
    Recorded before the edit, not after it.

    The first version recorded on input, which fires once the change has
    happened: the value had already moved on, and the cursor with it, so
    undoing restored text from one moment and a caret from another — it
    jumped. beforeinput fires with the box still as the person left it, so
    what goes on the stack is exactly the state to come back to, cursor
    included.
  */
  const onBeforeInput = useCallback((event: FormEvent<Field>) => {
    if (applying.current) return;
    const node = event.currentTarget;
    const now = Date.now();

    /* A run of typing with no pause is one thing to undo, not twenty. */
    if (past.current.length === 0 || now - last.current > APART) {
      past.current.push({
        value: node.value,
        start: node.selectionStart ?? node.value.length,
        end: node.selectionEnd ?? node.value.length,
      });
      if (past.current.length > 200) past.current.shift();
    }
    last.current = now;
    future.current = [];
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<Field>) => {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta || event.key.toLowerCase() !== "z") return;

    const node = event.currentTarget;
    const here: Step = {
      value: node.value,
      start: node.selectionStart ?? 0,
      end: node.selectionEnd ?? 0,
    };

    /*
      Swallowed either way, even with nothing to undo. Letting it through is
      exactly the bug: the browser would look for somewhere else to apply it,
      and find a field the person is not looking at.
    */
    event.preventDefault();
    event.stopPropagation();

    applying.current = true;
    try {
      if (event.shiftKey) {
        const next = future.current.pop();
        if (!next) return;
        past.current.push(here);
        put(node, next);
        return;
      }

      let step = past.current.pop();
      /* A step identical to what is on screen is not a change to undo. */
      while (step && step.value === here.value) step = past.current.pop();
      if (!step) return;
      future.current.push(here);
      put(node, step);
    } finally {
      applying.current = false;
    }
  }, []);

  return { onKeyDown, onBeforeInput };
}
