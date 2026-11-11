/** Whether the agent may drive the person's browser. Its own module, so the
 * tool list and the session runner can both read it without a cycle. */
export const browserEnabled = process.env.JOBSEARCH_BROWSER === "1";
