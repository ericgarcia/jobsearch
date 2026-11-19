---
name: fix-reported-bug
description: Read the bug reports the assistant filed from inside the app and fix one. Use when asked to look at reported bugs, filed faults, what the assistant ran into, the Admin tab's fault list, or to fix a bug by its report number.
---

# Fix a reported bug

The assistant that runs inside this app files a report when the app does not
do what it says it does. A report holds three things it wrote — what it was
doing, what it expected, what happened — and the state of the app read off
the server as it filed: the card that was waiting, the conversation it
happened in, where the question queue stood. See `packages/server/src/bugs.ts`.

Your job is to turn one of those into a fix, or into a documented "not a
bug". Both are good outcomes. A report closed without either is worse than
an open one, because the list stops being worth reading.

## Read the reports

```bash
npm run bugs --workspace @jobsearch/server -- list
```

```bash
npm run bugs --workspace @jobsearch/server -- show 3
```

`show` prints every kept sighting with its attached state. Read the
conversation it happened in — the turn usually says what the assistant tried
before it gave up:

```bash
npm run bugs --workspace @jobsearch/server -- transcript 5
```

## Work it in this order

1. **Reproduce it in a test first.** Write the failing case against the
   attached state: the sighting names the target, the field, the action, the
   answers offered and the question id, which is enough to set the same card
   up. Suites live in `packages/server/test/*.test.mts`, are plain `tsx`
   scripts with `node:assert/strict`, and each needs its own data directory:

   ```bash
   JOBSEARCH_DATA_DIR=$(mktemp -d) npx tsx packages/server/test/pending.test.mts
   ```

   A test that fails for the reported reason is the proof you have found the
   bug. Without it you are guessing, and the next person has nothing.

2. **Fix the cause, not the sighting.** The report says what the assistant
   saw from outside. The fault is usually one layer in: a write that did not
   happen, a guard that fired, a state the page threw away. Say in the commit
   what the real cause was, since the report's own words will not match it.

3. **Run everything.** `npm test` from the root. 27 suites; all of them must
   pass.

4. **Close it, with the fix in hand.**

   ```bash
   npm run bugs --workspace @jobsearch/server -- fixed 3
   ```

   Only after a test that failed before your change passes after it. A report
   that happens again reopens itself, so closing one you have not fixed buys
   nothing and loses the sighting count.

## When it is not a bug

Some reports are true accounts of something that is not the app's fault. The
assistant can only see from where it stands: a card it was waiting on can
vanish because somebody withdrew it by hand, a tool can look like it failed
because the thing it wrote was then changed. One report in this app's history
was caused by a developer deleting the pending edit from a console while the
assistant was waiting on it.

If you cannot reproduce it:

- say so plainly to the person, with what you tried;
- do not mark it fixed to tidy the list;
- if the cause was outside the app, say what it was, and consider whether the
  app should have noticed — a card disappearing from under the assistant with
  no answer is, arguably, something it should be told about rather than left
  to infer.

## What not to do

- Do not edit `bug_reports` or `bug_occurrences` with SQL. Use the commands
  above; they are the same path the app uses.
- Do not file reports yourself. That tool belongs to the assistant inside the
  app, which has the context to fill one in.
- Do not fix a report by making the assistant's prompt avoid the situation.
  A prompt that steers around a fault leaves the fault, and the next model
  that reads the prompt inherits a rule nobody can explain.
- Do not close several at once because they look alike. They were matched by
  meaning when filed; if two really are one, say so in the commit and close
  the other explicitly.
