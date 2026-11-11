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
- A Chrome split view, held by an extension of its own, where the app sits on
  the left and every link you click opens on the right instead of in a new
  tab. The assistant can arrange it and drive either side. That extension is
  also the Playwright target, so there is one extension to install, not two.

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

1. Install **Split Pilot**, the extension in [`extension/`](extension/). It is
   not in the Web Store, so load it unpacked: open `chrome://extensions`, turn
   on **Developer mode**, choose **Load unpacked**, and select that folder.

   Chrome will ask you to accept the `debugger` permission. That is the one
   behind the "is debugging this browser" banner, and it is what lets the
   agent drive a tab at all.

2. Copy the extension's id from its card in `chrome://extensions` — Chrome
   derives it from the path you loaded it from, so yours is not the one in
   this repository. Put it in `.env` with the browser switch:

   ```
   JOBSEARCH_BROWSER=1
   JOBSEARCH_SPLIT_EXTENSION_ID=<the id on the card>
   ```

   Then `npm install`. A postinstall step points the pinned Playwright at your
   extension; without the id it leaves Playwright pointed at Microsoft's and
   says so.

3. Start the app and open it. That is all: loading the app arranges the two
   panes, and keeps them arranged.

   The first time Playwright connects, a tab asks whether to allow it.
   Approve once; the token is remembered, and the app keeps it in step after
   that.

A second pane opens beside the app. From then on every link you click in the
app opens in that pane instead of a new tab, and the pane never moves: it is
one tab, navigating in place. The assistant can drive either pane, and can put
a page on the right with `open_on_stage` without disturbing what you are
reading on the left.

There is no control for this and no setting. The two panes are how the app is
meant to be used, and the assistant needs both to do its job — a switch whose
only effect is to take half of that away is not worth having. The app also
puts the panes back when you return to its tab, so taking the arrangement
apart from outside, through the extension's own popup, lasts until you look at
the app again.

To stop the browser work entirely, drop `JOBSEARCH_BROWSER` from `.env`. That
is the real off switch, and it turns off the driving as well as the panes.

### Why the server arranges it, and not the page

The app could pair the two tabs by itself. The result would look identical and
be half as useful.

A tab the page opens is a tab Playwright never opened, and the bridge knows
only the tabs it opened itself — so the assistant would watch that pane work
and never be able to touch it. So the page asks the server (`POST
/api/split/open`), the server has Playwright open the stage, and the extension
adopts it. That is the only order that ends with both panes drivable.

The request is safe to repeat, because the app makes it on every load: an
arrangement that is already good is left alone, and blank stage tabs left over
from previous rounds are cleared rather than piling up. If it fails — the
browser is off, the extension is not answering — the app says nothing and
carries on. It is an arrangement, not the work.

### One extension, not two

Driving a browser through `@playwright/mcp` normally means installing
Microsoft's **Playwright Extension** as well: a small bridge that relays CDP
over a WebSocket. Split Pilot does that job itself, so there is one extension
to install and one to trust.

Playwright chooses its extension with a constant compiled into
`playwright-core`, and offers no flag for it, so the postinstall step rewrites
that constant in the copy this repository installs. That is why
`@playwright/mcp` is pinned to an exact version: a patch against a moving
dependency rots in silence, while a patch against a pinned one either applies
or stops the install and names the version it found.

If any of this gets in your way, the fallback is intact. Install the
[Playwright Extension](https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm),
drop `JOBSEARCH_SPLIT_EXTENSION_ID` from `.env`, reinstall, and Playwright
goes back to talking to Microsoft's bridge. Split Pilot keeps holding the
split and routing links either way.

### Why the extension, rather than arranging the tabs yourself

You can pair two tabs by hand — right-click a tab, choose **Split view** — and
that is how this worked at first. It comes apart. A link opens a tab, the new
tab takes focus, the agent's next instruction lands on it, and the arrangement
you made is gone. Nothing in Playwright can prevent that, because the thing
moving is the browser.

Split Pilot fixes it where it happens. Links are caught in the page before the
browser acts on them and sent to the right-hand pane, so no tab is ever
created. [`extension/README.md`](extension/README.md) has the detail, including
what it catches and what it costs you in permissions.

The split is held by the extension, so it survives restarting the server. The
Playwright connection does not, and it knows only the tabs it opened itself,
so after a restart the panes look perfectly arranged while the assistant can
route links to the stage and no longer address it. The app checks for exactly
that when it loads — a pair alone is not enough, the bridge has to be able to
reach both panes — and rebuilds the arrangement when it cannot. Reloading the
app is the whole fix.

### Why one connection matters

The Agent SDK starts a fresh MCP connection for every turn. Pointed straight at
Playwright, each turn opens its own extension connection, and so its own tab:
the tab you paired is never the tab being driven, and the pairing looks broken
after the first message.

So the app connects to Playwright once, at startup, and republishes the browser
tools as its own (`agent/browserClient.ts`). The agent talks to the app, the app
talks to Playwright over a connection that outlives any single turn.

Two consequences worth knowing:

- **Restarting the server drops the connection**, and `npm run dev` restarts it
  whenever you edit server code. The split view itself survives, because the
  extension holds it; what is lost is the agent's ability to address the pane,
  as described above.
- **The token rotates** if you press refresh on the extension's status page.
  Update `.env` when you do.

The agent gets nine browser tools, not Playwright's full set: navigate, read the
page, click, type, press a key, list tabs, wait, and read the console. There is
no file upload and no arbitrary JavaScript, because this is your own signed-in
browser.

It also gets three for the split view — `open_split_view`, `split_view_state`
and `open_on_stage`. Those do run JavaScript in the app's own tab, since the
extension answers pages rather than processes, but the script is fixed in
`agent/split.ts` and never written by the model.

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

### Stop following one

Press the × beside a board. It asks what to do with the postings it already
fetched, and shows how many there are.

Keeping them is not free. They stay in your list and keep their place in the
order, but nothing will ever refresh them again, so from that day they only go
stale. Deleting them is usually right. Postings you are pursuing, or have
drafted a resume or a cover letter for, are kept whichever you choose: their
applications and drafts would cascade away with them, and no tidy-up is worth
that.

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
