# @jobsearch/layout

Turns a stored layout into HTML. No database, no filesystem, no Node APIs, so
the hosted route and the local server can both render with it.

- `spec.ts` — which sections exist, their order, and whether each is shown.
- `tokens.ts` — the whole styling surface, and the check every value passes.
- `styles.ts` — the two stylesheets, profile and resume.
- `render.ts` — one renderer for both.

There is no user-authored CSS and no user-authored HTML. See
`spikes/public-profile/` for what that decision is based on.
