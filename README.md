# jobsearch

A local app that helps you find jobs, tailor applications, and keep the status of
each one correct. A headless Claude session does the judgement; the app owns the
data.

Everything runs on your machine. The database lives in `~/.jobsearch/`, outside
this repository, because this repository is public and your job search is not.

## What works today

- Polls public ATS job boards — Greenhouse, Lever and Ashby — and stores every
  posting in SQLite.
- A chat pane driven by a headless Claude session. Claude has no shell, no file
  system and no web access; it acts only through the app's own tools.
- An application status machine that refuses an illegal move and records every
  change.
- A profile of your roles and achievements, which you edit directly or dictate
  to the assistant.
- A ranked list: keyword matching against your profile for everything, and a
  read-and-score pass on the best of it.
- Resumes and cover letters tailored to one posting, assembled only from facts
  you have recorded.

## How a resume stays true

A resume restates facts. It never creates them.

The assistant cannot write a resume line from nothing. `draft_resume` takes
**bullet ids**, not free text, so there is no field in which to invent an
employer or an achievement. What it may do is reword a bullet for a posting —
and that is where a figure can drift.

So every reworded line is compared with the fact it came from. A figure that the
stored bullet does not support becomes a warning, carried on the line and shown
in the app:

    Led a team of 15 engineers, cutting p99 latency by 50%
    FROM Led a team of 4 engineers, cutting p99 latency by 38%
    ⚠ The figure "15" is not in the stored bullet.
    ⚠ The figure "50%" is not in the stored bullet.

The summary paragraph is free prose, so it is checked against the whole profile
instead.

A cover letter is free prose throughout, so it gets the same whole-profile
check and nothing stronger. There is no stored fact behind each sentence to
compare it with, which is why the **Drafts** tab shows a letter in full rather
than summarising it: the check finds an invented figure, and reading finds the
rest. A letter with an unsupported figure is marked in the list before you open
it.

Warnings do not block a draft, because a fair rewording may combine or convert
figures. They make the drift visible before the resume goes out. Run the checks
with:

```bash
npm test --workspace=@jobsearch/server
```

## Requirements

- Node 22 or later.
- A Claude credential. The app asks for one the first time you open it.

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. The server runs on port 5179.

On first run the app asks for a Claude credential, because the Agent SDK does
not read the Claude Code desktop app's keychain entry. Choose one:

- **Claude subscription.** Run `claude setup-token`, approve the request in the
  browser, and paste the token the terminal prints.
- **Anthropic API key.** Create a key at
  <https://console.anthropic.com/settings/keys> and paste it.

The app runs one small request to check the credential, then stores it in
`~/.jobsearch/jobsearch.db`, which is chmod 600. The credential never leaves
your machine, and the API never returns it.

You can set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in a `.env` file
instead. See `.env.example`.

## Use it in a Chrome split view

The app on the left, the posting the agent is reading on the right, in one
window.

1. Install the **Playwright Extension**, published by the Playwright Team at
   Microsoft:
   <https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm>

   Take the id seriously. Other extensions call themselves a "Playwright MCP
   bridge" and look the same, but `@playwright/mcp` talks only to this one. If
   you install another, the connection times out and says nothing.

2. Open `chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html` and
   copy the token. Put it, and the browser switch, in `.env`:

   ```
   JOBSEARCH_BROWSER=1
   PLAYWRIGHT_MCP_EXTENSION_TOKEN=<the token from that page>
   ```

   Without the token the extension asks you to approve each connection in a tab
   of its own. That tab is easy to miss, and the request times out while it
   waits.

3. Start the app. It opens one browser tab and keeps it.

4. Ask the assistant to open a posting. Then put the app in the left half of a
   Chrome split view and that tab in the right half: right-click a tab and
   choose **Split view**, or drag one tab onto the other.

From then on the agent drives that same tab, so the right half follows what you
ask for in the left half.

### Why one connection matters

The Agent SDK starts a fresh MCP connection for every turn. Pointed straight at
Playwright, each turn opens its own extension connection, and so its own tab:
the tab you paired is never the tab being driven, and the pairing looks broken
after the first message.

So the app connects to Playwright once, at startup, and republishes the browser
tools as its own (`agent/browserClient.ts`). The agent talks to the app, the app
talks to Playwright over a connection that outlives any single turn.

Two consequences worth knowing:

- **Restarting the server breaks the pairing.** The connection lives as long as
  the server process, and `npm run dev` restarts it whenever you edit server
  code. Pair again after a restart.
- **The token rotates** if you press refresh on the extension's status page.
  Update `.env` when you do.

The agent gets nine browser tools, not Playwright's full set: navigate, read the
page, click, type, press a key, list tabs, wait, and read the console. There is
no file upload and no arbitrary JavaScript, because this is your own signed-in
browser.

If a split view is more trouble than it is worth, drop `JOBSEARCH_BROWSER` and
run the app in one window beside an ordinary browser. Nothing else depends on
it.

## How the list gets its order

Three things decide what you see first, and they are deliberately kept apart.

**Keyword match**, in `matching.ts`. Arithmetic over two sets of terms. The
first is what you say you want, under **What you are looking for** on the
Profile tab: the titles you want, the subjects to seek out, the subjects to
avoid. The second is what your profile shows you have done: skills you listed,
skills tagged on your achievements, words from your job titles. A term in the
posting's title counts for three times a term in its body.

The two are not weighted equally. A chosen term outweighs an inferred one,
because a profile is a record of the past and ranking against it alone measures
anyone changing direction against the work they are leaving. With the interests
left empty the profile is all there is, and a former employer rises to the top
of the list on history alone. A posting whose title is about something you
asked to avoid is pushed to the bottom; in the body the mention may be
incidental, so the penalty is lighter. Scoring all seven thousand postings
takes well under a second and costs nothing.

It also corrects for level. Keywords cannot tell seniority, so a PhD ML engineer
matches "PhD Machine Learning Engineer, Intern" almost perfectly. If your
profile shows senior titles, or eight years since your first recorded role,
junior postings are pushed down rather than hidden.

**Assessment**, in `assess.ts`. The keyword match decides what is worth reading;
this decides whether it is any good. Each posting goes to a cheap model in a
single call with your whole profile, and comes back with a score, reasoning that
cites the posting, and the single biggest gap. Twenty postings take about half a
minute and a few cents. Run it from **Assess top 20**, or ask the assistant.

**The order itself.** An assessment wins where there is one, the keyword match
orders the rest, and ties break on when the company posted the job. Nothing is
ever ordered by when this app happened to fetch it: fetch order is an artifact
of the sync, and sorting by it looks like relevance while meaning nothing.

The two scores are shown differently in the list. An assessment is a plain
number; a keyword match is dimmed and italic, with a tooltip saying it is not a
judgement. Each assessment records the model that made it.

### Where you will work

The list is limited to your city. Boards cover every office a company has, so
without this most of what you see is in the wrong place: of 2,056 stored
postings, 796 are in New York and the rest are not.

The city comes from your profile the first time, and the box under the search
field changes it. Leave the box empty to search everywhere.

**Remote elsewhere** widens that: a posting counts if it is in your city, or if
it is remote wherever it is based. It is off by default, because being willing
to work remotely is not something to assume. Turning it on takes New York from
796 postings to 979.

Matching a location is harder than it looks, because boards write them freely:

    New York, NY
    San Francisco, CA | New York City, NY | Seattle, WA
    NY, SF, Chicago, Remote
    US-Remote; US-Chicago; CA-Toronto
    New York City Metropolitan Area
    Dublin or London

A substring test fails in both directions: "New York" misses the third line,
and "NY" matches "Germany". So a name of four characters or more is matched
against the whole string, and a shorter one only against the location's
separate parts. Common short forms are expanded for you, so asking for New York
also finds NY and NYC. The rules are in `location.ts`, with tests in
`test/location.test.mts`.

The assistant follows the same rule: it searches your city unless you tell it
otherwise, and it will say when it has widened a search.

### Two models

The chat runs on a capable model because it is open-ended work. Scoring a
posting is a judgement about one document, so it runs on a cheap one:

| | model | cost per 100 postings |
| --- | --- | --- |
| Chat | `claude-opus-5-5` | — |
| Assessment | `claude-haiku-5-5` | about $0.22 measured |

Override either with `JOBSEARCH_MODEL` and `JOBSEARCH_ASSESS_MODEL`. If the
reasoning feels thin, `claude-sonnet-5-5` is the next step up.

## Add your own boards

The app seeds a few boards so a new database is useful immediately. Replace them
with your own targets. A board token is the company's identifier in its ATS URL:

| ATS | URL | Token |
| --- | --- | --- |
| Greenhouse | `boards.greenhouse.io/anthropic` | `anthropic` |
| Lever | `jobs.lever.co/spotify` | `spotify` |
| Ashby | `jobs.ashbyhq.com/ramp` | `ramp` |

### Read a board before you follow it

No applicant tracking system offers a search across every company, so a name
has to come from somewhere — you, or the assistant proposing one from what it
knows of your field. Either way it is a guess until the board is read.

Type the names on the **Boards** tab and press **Check their boards**. The app
finds each board, scores every posting against the same terms the ranked list
uses, and reports how many match, what the best one is, and its top few titles
with links. Nothing is stored. Follow the ones worth following; a company
hiring for nothing you want is then a cheap answer rather than a sync, a
thousand stored postings and a list to clean up later.

Scores are scaled against the best match in the postings you already have, not
against the batch being checked, so a company read here is measured by the same
bar as every company you follow. Normalising each batch against itself would
make every company look like a perfect match.

The assistant has the same tool. Ask it which companies are worth following and
it will propose names, read the boards and report what they are actually
hiring for.

### By hand

Ask the assistant to add one, or post to the API:

```bash
curl -X POST http://127.0.0.1:5179/api/companies -H 'content-type: application/json' \
  -d '{"name":"Anthropic","ats":"greenhouse","board_token":"anthropic"}'
```

## How it is put together

```
packages/server   Fastify API, SQLite, ATS adapters, the Claude Agent SDK session
packages/web      React app (Vite)
```

The agent reaches the database only through a fixed set of tools in
`packages/server/src/agent/tools.ts`. Deterministic code owns the schema, the
dedup rules and the status machine. The agent owns judgement: whether a posting
fits, and why. That split is deliberate. An agent with free SQL access corrupts
an application tracker within a week.

Adding a new job board means writing one `JobSource` adapter in
`packages/server/src/sources/`. Nothing else changes.

## Status

Early. Job search, ranking, assessment, status tracking, the profile, tailored
resumes and cover letters all work.

Not built yet: email-driven status updates, and any export beyond copying
Markdown. Tailoring is still driven from the chat box rather than a button on
the posting, and a saved draft can be read and deleted but not edited in place.
