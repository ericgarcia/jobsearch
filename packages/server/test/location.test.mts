import { locationMatches, expandPlace } from "../src/location.js";

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};

console.log("\n1. A long name matches the whole string");
check('"New York, NY" ~ new york', locationMatches("New York, NY", "new york"));
check(
  '"New York City Metropolitan Area" ~ new york',
  locationMatches("New York City Metropolitan Area", "new york"),
);
check(
  '"San Francisco, CA | New York City, NY" ~ new york',
  locationMatches("San Francisco, CA | New York City, NY", "new york"),
);
check(
  '"New York City, NY; San Francisco, CA" ~ new york',
  locationMatches("New York City, NY; San Francisco, CA", "new york"),
);

console.log("\n2. A short name matches only a whole part");
check('"NY, SF, Chicago, Remote" ~ ny', locationMatches("NY, SF, Chicago, Remote", "ny"));
check('"Germany" does NOT match ny', !locationMatches("Germany", "ny"));
check('"Munich, Germany" does NOT match ny', !locationMatches("Munich, Germany", "ny"));
check('"Albany, NY" ~ ny', locationMatches("Albany, NY", "ny"));

console.log("\n3. Country-prefixed parts are split");
check(
  '"US-Remote; US-Chicago; CA-Toronto" ~ chicago',
  locationMatches("US-Remote; US-Chicago; CA-Toronto", "chicago"),
);
check(
  '"US-Remote; US-Chicago; CA-Toronto" does NOT match ny',
  !locationMatches("US-Remote; US-Chicago; CA-Toronto", "ny"),
);

console.log("\n4. Near misses are not matches");
check('"Newark, NJ" does NOT match new york', !locationMatches("Newark, NJ", "new york"));
check('"London" does NOT match new york', !locationMatches("London", "new york"));
check('null location never matches', !locationMatches(null, "new york"));
check('empty needle never matches', !locationMatches("New York, NY", "   "));

console.log("\n5. Separators boards actually use");
check('"Dublin or London" ~ london', locationMatches("Dublin or London", "london"));
check(
  '"Remote-Friendly (Travel-Required) | Seattle, WA" ~ seattle',
  locationMatches("Remote-Friendly (Travel-Required) | Seattle, WA", "seattle"),
);

console.log("\n6. Places expand to the forms boards write");
check("New York expands to include ny", expandPlace("New York").includes("ny"));
check(
  "a profile location keeps only the city",
  expandPlace("New York, New York, United States").includes("nyc"),
);
check("an unknown place is used as itself", expandPlace("Reykjavik")[0] === "reykjavik");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
