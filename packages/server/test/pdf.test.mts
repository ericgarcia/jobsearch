/*
  The exported resume must be a document, not a picture of one.

  An applicant tracking system reads the text out of the file before any
  person sees it. A rasterised resume parses as nothing at all, and the
  person never finds out — their application is simply filtered. So this
  checks the one property that failure would take away.

  It needs the server running, because it exercises the real route.
*/
import assert from "node:assert/strict";

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

console.log("\nThe exported resume is a real document");

const response = await fetch(`${BASE}/api/resume.pdf`);
check("the route answers", response.ok, `${response.status}`);
if (!response.ok) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

check(
  "it is served as a pdf",
  (response.headers.get("content-type") ?? "").includes("application/pdf"),
);
check(
  "it downloads under a name",
  (response.headers.get("content-disposition") ?? "").includes("filename="),
);

const bytes = Buffer.from(await response.arrayBuffer());
const raw = bytes.toString("latin1");

check("it is a pdf", raw.startsWith("%PDF-"));
check("it has pages", /\/Type\s*\/Page[^s]/.test(raw));

const media = /\/MediaBox\s*\[([^\]]+)\]/.exec(raw);
const box = media ? media[1]!.trim().split(/\s+/).map(Number) : [];
const width = box.length === 4 ? (box[2]! - box[0]!) / 72 : 0;
const height = box.length === 4 ? (box[3]! - box[1]!) / 72 : 0;
check("the paper is letter", Math.abs(width - 8.5) < 0.02 && Math.abs(height - 11) < 0.02, `${width}x${height}in`);

// The two that matter. Fonts mean glyphs; no images means nothing was
// flattened into a bitmap on the way out.
check("fonts are embedded, so there is text", /\/BaseFont\s*\//.test(raw));
check("nothing was rasterised", !/\/Subtype\s*\/Image/.test(raw));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
