/*
  One renderer, not two.

  The editor renders the document in the browser now, so that styling shows
  without a round trip. The danger in that is a second renderer: the page
  drifts from the server, and what someone styles stops being what the PDF
  and the public profile produce. They would find out after sending it.

  So `/api/document/:surface` hands over the three things `renderDocument`
  takes, and this renders them and compares the string with what
  `/api/render/:surface` serves. Identical, or one of them is wrong.

  It needs the server running, because it exercises the real routes.
*/
import { renderDocument, type LayoutSpec, type RenderContent } from "@jobsearch/layout";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 5179}`;

let pass = 0;
let fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
};

const reachable = await fetch(`${BASE}/api/health`).then(
  (r) => r.ok,
  () => false,
);
if (!reachable) {
  console.log("\nskipped: no server on " + BASE);
  process.exit(0);
}

interface Payload {
  surface: "profile" | "resume";
  layout: { id: number; spec: LayoutSpec; tokens: Record<string, string> };
  content: RenderContent;
}

for (const [surface, paged] of [
  ["resume", true],
  ["profile", false],
] as const) {
  console.log(`\nThe ${surface} renders the same on both sides`);

  const payload = (await fetch(`${BASE}/api/document/${surface}`).then((r) => r.json())) as Payload;
  check("the document route answers", payload?.layout?.spec !== undefined, JSON.stringify(payload).slice(0, 120));

  const here = renderDocument({
    spec: payload.layout.spec,
    tokens: payload.layout.tokens,
    content: payload.content,
    surface,
    paged,
  });

  const served = await fetch(`${BASE}/api/render/${surface}${paged ? "?paged=1" : ""}`).then((r) =>
    r.text(),
  );

  check("the two strings are identical", here === served, firstDifference(here, served));
}

/*
  The editor needs to know which bullet a click landed on. The public page
  and the PDF need to carry no such thing: they are the document, and an id
  on it is the editor leaking into what someone sends to an employer.
*/
console.log("\nIds are the editor's, and stay there");

const payload = (await fetch(`${BASE}/api/document/profile`).then((r) => r.json())) as Payload;
const served = await fetch(`${BASE}/api/render/profile`).then((r) => r.text());
const annotated = renderDocument({
  spec: payload.layout.spec,
  tokens: payload.layout.tokens,
  content: payload.content,
  surface: "profile",
  annotate: true,
});

for (const attribute of ["data-section", "data-field", "data-role", "data-bullet", "data-skill"]) {
  check(`the public page has no ${attribute}`, !served.includes(attribute));
}
check("the editor's rendering names its sections", annotated.includes('data-section="header"'));
check("and its fields", annotated.includes('data-field="name"'));
check(
  "the two differ only by that",
  annotated.replace(/ data-[a-z-]+="[^"]*"/g, "") === served,
  firstDifference(annotated.replace(/ data-[a-z-]+="[^"]*"/g, ""), served),
);

console.log("\nA surface that is not one is not found");
const bad = await fetch(`${BASE}/api/document/sideways`);
check("it is a 404", bad.status === 404, `${bad.status}`);

/** Where two renderings part company, with a little either side of it. */
function firstDifference(a: string, b: string): string {
  if (a === b) return "";
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - 40);
  return `at ${at}:\n  here:   ${JSON.stringify(a.slice(from, at + 60))}\n  served: ${JSON.stringify(b.slice(from, at + 60))}`;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
