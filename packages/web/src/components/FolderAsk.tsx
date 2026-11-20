import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { useChanges } from "../changes.ts";
import { say } from "../say.ts";

/**
 * The assistant asking to read a folder on this computer.
 *
 * It sits at the top of the thread, where the question was asked, and it is
 * the only thing that grants: the assistant can name a folder and say what
 * it wants it for, and nothing in that folder is readable until this is
 * answered. See the server's files.ts.
 *
 * The path is shown as it really is, resolved, rather than as the assistant
 * typed it — "~/Documents/../.ssh" is a string, and what it leads to is the
 * thing being decided. What the folder is for is shown in the assistant's
 * own words, and is the reason to say no as often as the reason to say yes.
 */
export function FolderAsk() {
  const [asked, setAsked] = useState<{ path: string; why: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api
      .folders()
      .then((answer) => setAsked(answer.pending))
      .catch(() => setAsked(null));
  };

  useEffect(load, []);
  useChanges("files", load);

  if (!asked) return null;

  async function answer(allow: boolean) {
    if (!asked || busy) return;
    setBusy(true);
    try {
      await api.answerFolder(allow);
      setAsked(null);
      /*
        Told in the person's own voice, the same way an answered card is:
        the assistant hears the outcome from them rather than by looking.
      */
      say(
        allow
          ? `I let you read ${asked.path}. Only that folder, and only to read.`
          : `I would rather you did not read ${asked.path}. Ask me for what you need instead.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="folder-ask">
      <div className="folder-ask-head">The assistant wants to read a folder on this computer</div>
      <div className="folder-ask-path">{asked.path}</div>
      <div className="folder-ask-why">{asked.why}</div>
      <div className="folder-ask-note">
        It will be able to read the files in this folder and the folders inside it, and nothing
        else. It cannot change or delete anything. Hidden files are never included. You can take
        this back at any time in Admin.
      </div>
      <div className="field-answer">
        <button disabled={busy} onClick={() => void answer(true)}>
          Allow this folder
        </button>
        <button className="primary" disabled={busy} onClick={() => void answer(false)}>
          No
        </button>
      </div>
    </div>
  );
}
