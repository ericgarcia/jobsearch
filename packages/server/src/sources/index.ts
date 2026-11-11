import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import type { JobSource } from "./types.js";

export const SOURCES: Record<string, JobSource> = {
  greenhouse,
  lever,
  ashby,
};

export function getSource(id: string): JobSource {
  const source = SOURCES[id];
  if (!source) {
    throw new Error(`Unknown source "${id}". Known sources: ${Object.keys(SOURCES).join(", ")}`);
  }
  return source;
}

export * from "./types.js";
