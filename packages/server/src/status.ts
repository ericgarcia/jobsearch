/**
 * The application status machine. Deterministic code owns this; the agent may
 * only move an application along a transition this table allows.
 */
export const STATUSES = [
  "interested",
  "applying",
  "applied",
  "screen",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
] as const;

export type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, readonly Status[]> = {
  interested: ["applying", "applied", "withdrawn"],
  applying: ["applied", "interested", "withdrawn"],
  applied: ["screen", "interview", "rejected", "withdrawn"],
  screen: ["interview", "offer", "rejected", "withdrawn"],
  interview: ["interview", "offer", "rejected", "withdrawn"],
  offer: ["accepted", "rejected", "withdrawn"],
  accepted: [],
  rejected: [],
  withdrawn: ["interested"],
};

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedNext(from: Status): readonly Status[] {
  return TRANSITIONS[from];
}
