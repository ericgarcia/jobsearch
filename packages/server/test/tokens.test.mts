/*
  The token checker is the whole boundary.

  There is no user-authored CSS in this system, so every value that reaches a
  stylesheet comes through checkToken. If it lets something past, the design's
  one safety property is gone — and it would be gone quietly, because a page
  that leaks its visitors looks exactly like a page that does not.
*/
import assert from "node:assert/strict";
import { checkToken, checkTokens, cssVariables } from "@jobsearch/layout";

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

console.log("\n1. Values that escape the declaration are refused");
const escapes = [
  "red; } body { background: url(https://attacker/x) ",
  "#fff; background-image: url(//evil)",
  "}",
  "var(--x)",
  "rgb(1,2,3)",
  "url(https://evil/x)",
  "@import url(//evil)",
  "expression(alert(1))",
  "'",
  '"',
  "#fff/**/;color:red",
];
for (const value of escapes) {
  check(`refuses ${JSON.stringify(value).slice(0, 44)}`, checkToken("accent", value) !== null);
}

console.log("\n2. Ordinary values are accepted");
check("a hex colour", checkToken("accent", "#2b3a55") === null);
check("a short hex colour", checkToken("accent", "#abc") === null);
check("a named font stack", checkToken("fontHeading", "transitional") === null);
check("a length with an allowed unit", checkToken("pageMargin", "0.75in") === null);
check("a plain number", checkToken("density", "0.9") === null);

console.log("\n3. Ranges hold");
check("a 2pt resume is refused", checkToken("fontSize", "2pt") !== null);
check("a 9in margin is refused", checkToken("pageMargin", "9in") !== null);
check("density 99 is refused", checkToken("density", "99") !== null);
check("a disallowed unit is refused", checkToken("pageMargin", "20px") !== null);
check("an unknown font is refused", checkToken("fontHeading", "Comic Sans") !== null);
check("an unknown token is refused", checkToken("nope", "1") !== null);

console.log("\n4. A token only applies where it means something");
check("pageMargin is not a profile token", checkTokens("profile", { pageMargin: "0.5in" }).length === 1);
check("pageMargin is a resume token", checkTokens("resume", { pageMargin: "0.5in" }).length === 0);
check("maxWidth is not a resume token", checkTokens("resume", { maxWidth: "40rem" }).length === 1);

console.log("\n5. Nothing unchecked reaches the stylesheet");
// A value that somehow got stored — an older build, a hand-edited row — must
// not be emitted. The default is used instead of the stored rubbish.
const css = cssVariables("resume", { accent: "red; } body { background: url(//evil)", ink: "#222222" });
check("a bad stored value is dropped", !css.includes("evil"), css);
check("the default takes its place", css.includes("--accent: #111111;"), css);
check("a good value beside it still applies", css.includes("--ink: #222222;"), css);
check("no declaration is ever broken open", !/[;{}]\s*[a-z-]+\s*:/.test(css.replace(/;\n/g, "\n")), css);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
