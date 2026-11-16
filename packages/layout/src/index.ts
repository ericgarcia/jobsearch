/**
 * The layout engine: how a profile and a resume are laid out and styled.
 *
 * Its own package because two different servers render with it — the local
 * one for the agent, and a hosted route for the public profile — and one
 * engine is the only way those two agree about what a person's page looks
 * like. Two would drift, and the drift would show up as a resume that does
 * not match the profile it came from.
 *
 * Nothing here touches a database, a filesystem or a Node API. It takes a
 * layout, a set of tokens and a block of content, and returns a string. That
 * is what lets it run in a serverless route as readily as in the server.
 */
export * from "./tokens.js";
export * from "./spec.js";
export * from "./styles.js";
export * from "./render.js";
export * from "./guide.js";
