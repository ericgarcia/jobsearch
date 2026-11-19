import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useFieldHistory } from "../undo.ts";
import type { TextareaHTMLAttributes } from "react";

/**
 * A text box that is as tall as what is in it.
 *
 * Every multi-line field in this app used to be a fixed height with a drag
 * handle: five lines of a resume bullet, four of a project section, and the
 * rest behind a scrollbar until you dragged the corner. That is the wrong way
 * round. The person is being asked to read and approve what is written, and a
 * drag handle asks them to do the layout first.
 *
 * So the box measures its own contents and takes the height they need, and
 * the handle is gone. The `rows` attribute keeps its usual meaning as the
 * resting size: the box never shrinks below it, so an empty field still looks
 * like somewhere to write rather than a single line.
 *
 * It works for a controlled field and an uncontrolled one. A controlled field
 * refits when its value prop changes; both refit on input, which is what the
 * uncontrolled ones have instead of a value.
 */
export function GrowText({
  max,
  onInput,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /**
   * A ceiling in pixels, after which it scrolls instead of growing. For the
   * message box, where a pasted resume would otherwise push the conversation
   * off the screen. Leave it out and the box grows to whatever it holds.
   */
  max?: number;
}) {
  const node = useRef<HTMLTextAreaElement>(null);
  /* Undo that stays in this box rather than reaching the rest of the page. */
  const history = useFieldHistory();

  const fit = useCallback(() => {
    const box = node.current;
    if (!box) return;

    const style = getComputedStyle(box);
    const border =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) || 0;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 16;
    /* What `rows` would have given, which is the smallest this may be. */
    const floor = (box.rows || 1) * line + padding + border;

    /*
      Height is set as a border-box height, while scrollHeight is the content
      and the padding only. Leaving the border out makes the box a couple of
      pixels short of its own last line.
    */
    box.style.height = "auto";
    const needed = box.scrollHeight + border;
    const height = Math.max(needed, floor);

    if (max != null && height > max) {
      box.style.height = `${max}px`;
      box.style.overflowY = "auto";
    } else {
      box.style.height = `${height}px`;
      box.style.overflowY = "hidden";
    }
  }, [max]);

  /* Before the frame is painted, so it is never briefly the wrong height. */
  useLayoutEffect(fit, [fit, rest.value, rest.defaultValue]);

  useEffect(() => {
    const box = node.current;
    if (!box) return;

    /*
      The same text wraps into a different number of lines when the column
      changes width, so a width change is a refit. Only a width change: the
      height is this element's own output, and feeding it back in is a loop.
    */
    let width = box.clientWidth;
    let watch: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      watch = new ResizeObserver(() => {
        if (box.clientWidth === width) return;
        width = box.clientWidth;
        fit();
      });
      watch.observe(box);
    }

    /*
      And once more when the fonts arrive. Measuring against a fallback font
      gives a height for text that is about to be set in something else.
    */
    let stale = false;
    void document.fonts?.ready.then(() => {
      if (!stale) fit();
    });

    return () => {
      stale = true;
      watch?.disconnect();
    };
  }, [fit]);

  return (
    <textarea
      {...rest}
      ref={node}
      onKeyDown={(event) => {
        history.onKeyDown(event);
        rest.onKeyDown?.(event);
      }}
      onInput={(event) => {
        history.onInput(event);
        fit();
        onInput?.(event);
      }}
    />
  );
}
