# @jobsearch/layout

Turns a stored layout into HTML. No database, no filesystem, no Node APIs, so
the hosted route and the local server can both render with it.

- `spec.ts` — which sections exist, their order, and whether each is shown.
- `tokens.ts` — the whole styling surface, and the check every value passes.
- `styles.ts` — the two stylesheets, profile and resume.
- `render.ts` — one renderer for both.

There is no user-authored CSS and no user-authored HTML. See
`spikes/public-profile/` for what that decision is based on.

## Importing it

A server takes the package itself. A browser takes a subpath — `./render`,
`./styles` or `./tokens` — because the index re-exports `spec.ts`, and
`spec.ts` imports zod. One import of the index from the web app would put a
schema validator in the bundle that no browser runs: the UI renders a
document, and the server is what checks one. `./spec` is there for its types,
which erase.
