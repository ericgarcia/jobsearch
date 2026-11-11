import { useState } from "react";
import { api, type CredentialKind, type Setup as SetupInfo } from "../api.ts";

/**
 * First-run setup. The agent needs its own credential, because the Agent SDK
 * does not read the Claude Code desktop app's keychain entry.
 *
 * The token travels from this form to the local server and into the local
 * database. It is never sent anywhere else and never read back out.
 */
export function Setup({ info, onDone }: { info: SetupInfo; onDone: () => void }) {
  const [kind, setKind] = useState<CredentialKind>("oauth-token");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const command = "claude setup-token";

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveCredential(kind, token);
      setToken("");
      onDone();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <h1>Set up jobsearch</h1>
      <p className="lede">
        The agent needs its own Claude credential. It is stored in your local database at{" "}
        <code>~/.jobsearch/jobsearch.db</code> and never leaves this machine.
      </p>

      <div className="choice">
        <label className={kind === "oauth-token" ? "on" : ""}>
          <input
            type="radio"
            checked={kind === "oauth-token"}
            onChange={() => setKind("oauth-token")}
          />
          <div>
            <b>Claude subscription</b>
            <span>Usage bills your Claude plan. Recommended.</span>
          </div>
        </label>
        <label className={kind === "api-key" ? "on" : ""}>
          <input type="radio" checked={kind === "api-key"} onChange={() => setKind("api-key")} />
          <div>
            <b>Anthropic API key</b>
            <span>Usage bills your API account per token.</span>
          </div>
        </label>
      </div>

      {kind === "oauth-token" ? (
        <ol className="steps">
          <li>
            Run this in a terminal:
            <div className="cmd">
              <code>{command}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </li>
          <li>
            It opens <code>claude.ai</code> in your browser. Approve the request there. Put that
            tab in the right half of a Chrome split view to watch it beside this app.
          </li>
          <li>The terminal prints a token. Paste it below.</li>
        </ol>
      ) : (
        <ol className="steps">
          <li>
            Open{" "}
            <a href={info.links["api-key"]} target="_blank" rel="noreferrer">
              console.anthropic.com/settings/keys
            </a>{" "}
            — in the right half of a Chrome split view, beside this app.
          </li>
          <li>Create a key and copy it.</li>
          <li>Paste it below.</li>
        </ol>
      )}

      <form onSubmit={save}>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={kind === "oauth-token" ? "sk-ant-oat…" : "sk-ant-api…"}
          autoComplete="off"
          spellCheck={false}
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy || token.trim().length < 8}>
          {busy ? "Checking with Claude…" : "Verify and save"}
        </button>
        <p className="fine">
          Saving runs one tiny request to confirm the credential works before it is stored.
        </p>
      </form>
    </div>
  );
}
