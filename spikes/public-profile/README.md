# Can the public profile be custom HTML and JavaScript?

Yes — in a sandboxed iframe on a second host, with the shell and the
OpenGraph tags served from the app. Not on the app's own origin, at any price.

Run it:

```
node spikes/public-profile/server.mjs
```

Then open `http://app.localhost:7101/safe/ada` and
`http://app.localhost:7101/naive/ada`, and read
`http://app.localhost:7101/reports`.

## What the two designs do

Both serve the same stored document: a profile page with CSS animation, a
button with state, and five things a hostile page would try.

| The page tried to | Served from the app's origin | In a sandboxed iframe on a second host |
| --- | --- | --- |
| read the visitor's cookie | **`session=supersecret-visitor-token`** | `BLOCKED: SecurityError` |
| read `localStorage` | allowed | `BLOCKED: SecurityError` |
| read the parent's origin | **`http://app.localhost:7101`** | `BLOCKED: SecurityError` |
| navigate the whole tab away | **ALLOWED — and it did** | `BLOCKED: SecurityError` |
| report its own origin | `http://app.localhost:7101` | `null` (opaque) |

Measured in Chrome 157. The animation, the button and the counter all work in
the sandboxed version: this costs the user nothing they would notice.

The first run of this spike lost its own results, because the naive page's
top-navigation succeeded and took the tab to example.com before anything could
be read back. A page that can do that can also replace your site with a copy
of itself and ask the visitor to sign in.

## Why two hosts and not two ports

An origin is scheme + host + port, but **cookies ignore the port**. Two ports
on one host would have made the isolation look better than it is. The spike
uses `app.localhost` and `usercontent.localhost`; in production that is two
registrable domains, so a cookie can never be scoped across both.

## What the shell does

- Carries `<title>`, `og:*`, `twitter:card` and `canonical`, built from stored
  fields — never from the user's HTML, so a page cannot claim to be someone
  else in a link preview.
- `Content-Security-Policy: default-src 'none'; frame-src <sandbox>` — it has
  no scripts of its own and can frame exactly one origin.
- The document host answers `frame-ancestors <app>`, so the raw document
  cannot be used as a standalone page trading on the app's reputation.

## Serving it from the database

The document lives in a row and is served from it: median 0.6 ms locally for
3 KB. Remote Turso adds a network round trip per request, so the shell and the
document both want `s-maxage` with `stale-while-revalidate`, purged on save.
Not measured here — no remote database to measure against.

## The real cost, which is not security

**Content inside an iframe is not indexed as part of the outer page.** Link
previews work, because a scraper reads the shell's meta tags. Search does not:
the profile's text belongs to the iframe's URL, not to the profile URL. For a
page whose purpose is "this is who I am", that matters.

So the content people search for should be server-rendered into the shell from
the stored layout, and fully custom HTML should be the opt-in that accepts the
trade. That is an argument for layout-as-data being the main path, not a
detour on the way to custom HTML.

## Not covered here

- Generating `og:image`. `@vercel/og` renders one at the edge from the same
  stored fields.
- Moderation. A public page that anyone can author, on your domain, will
  eventually be used to host a convincing sign-in form for somewhere else.
  The sandbox does not help with that; it is a product problem.
