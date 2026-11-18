/*
  The agent must not be told confidently about a screen nobody is looking at.

  A wrong answer here is worse than no answer: "make this one warmer" acting
  on whatever was last open is a change to the wrong thing, made silently.
*/
import assert from "node:assert/strict";
import { clearState, currentState, reportState } from "../src/appState.js";

let pass = 0, fail = 0;
const check = (label: string, condition: boolean, detail = "") => {
  if (condition) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label} ${detail}`); }
};

console.log("\n1. Nothing reported yet");
clearState();
let answer = currentState();
check("looking is false", answer.looking === false);
check("it says to ask rather than guess", /Ask the person/.test(answer.note));
check("it claims no tab", answer.tab === undefined);

console.log("\n2. A fresh report");
reportState({ tab: "design", selected: { surface: "resume" } });
answer = currentState();
check("looking is true", answer.looking === true);
check("the tab comes through", answer.tab === "design");
check("so does the selection", answer.selected?.surface === "resume");
check('the note resolves "this one"', /This one/.test(answer.note), answer.note);

console.log("\n3. An old report is not an answer");
// Two minutes later, with no word from the page.
answer = currentState(Date.now() + 120_000);
check("looking is false again", answer.looking === false);
check("it says the tab is probably closed", /probably closed/.test(answer.note));
check("it does not hand back the stale tab", answer.tab === undefined, JSON.stringify(answer));
check("it says how old", (answer.seconds_ago ?? 0) >= 119);

console.log("\n4. Leaving the page clears it");
reportState({ tab: "jobs", selected: { job: 7 } });
check("reported", currentState().looking === true);
clearState();
check("and gone", currentState().looking === false);

/*
  A bullet selected on a tailored draft has two ids, and the agent must not
  pick between them by guessing. Rewording the line changes one resume;
  rewriting the bullet changes the person's stored history and every resume
  that cites it. The second is not undone by noticing afterwards.
*/
console.log("\n5. A part of the document, selected");
reportState({
  tab: "design",
  selected: {
    surface: "resume",
    draft: 3,
    selection: { section: "experience", field: "bullet", role: 2, bullet: 11, line: 44, text: "Cut p95 latency" },
  },
});
answer = currentState();
check("the selection comes through", answer.selected?.selection?.line === 44);
check("the note names the part", /bullet of the experience/.test(answer.note), answer.note);
check("and both ids", /bullet 11/.test(answer.note) && /line 44/.test(answer.note), answer.note);
check("it quotes the words", /Cut p95 latency/.test(answer.note), answer.note);
check("and says to edit the line", /resume line, not the stored bullet/.test(answer.note), answer.note);

console.log("\n6. The same bullet with no draft open is the fact itself");
reportState({
  tab: "design",
  selected: { surface: "resume", selection: { section: "experience", field: "bullet", bullet: 11 } },
});
answer = currentState();
check("it says so", /stored fact itself/.test(answer.note), answer.note);
check("and warns what it reaches", /every resume that cites it/.test(answer.note), answer.note);

console.log("\n7. Nothing selected still answers plainly");
reportState({ tab: "design", selected: { surface: "resume" } });
answer = currentState();
check('"this one" still resolves', /This one/.test(currentState().note), answer.note);
check("and nothing is invented about a selection", !/selected the/.test(answer.note), answer.note);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
