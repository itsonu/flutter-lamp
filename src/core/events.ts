/**
 * Canonical runtime event model.
 *
 * Per docs/Rules.md every runtime event MUST carry: timestamp, source,
 * severity, category. Everything the collectors produce funnels through this
 * shape so tools and the diagnosis engine reason over one uniform stream.
 *
 * `id` and `sessionId` are stamped by the store, so collectors construct events
 * without them.
 */

export type Severity = "debug" | "info" | "warning" | "error" | "critical";

/**
 * Every event category. Declared as a value so the store can build one buffer
 * per category and iterate them; the type is derived so the two cannot drift.
 */
export const CATEGORIES = [
  "log",
  "exception",
  "frame",
  "rebuild",
  "network",
  "navigation",
  "state",
  "system",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface RuntimeEvent {
  /** Monotonic id assigned by the store (insertion order). */
  id: number;
  /**
   * Human-readable stable identity, e.g. `exc_00142`. A diagnosis cites these
   * so every claim points at a specific captured event instead of paraphrasing
   * it. Unique for the lifetime of the store, across categories and sessions.
   */
  eventId: string;
  /**
   * Which debugging session produced this event. A hot restart or a reconnect
   * starts a new session; without this marker, evidence from two different app
   * runs sits in one timeline and correlation invents causes across the gap.
   * Null for events added outside a session (tests, direct store use).
   */
  sessionId: string | null;
  /**
   * Identity shared with other events from the same operation, when the
   * runtime provides one (the dart:io HTTP profile request id today). Absent
   * when no real identity exists — never invented.
   */
  correlationId?: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Origin stream/extension, e.g. "Stdout", "Flutter.Error", "Flutter.Frame". */
  source: string;
  severity: Severity;
  category: Category;
  /** One-line human summary; always present so tools can render without digging into `data`. */
  message: string;
  /** Structured payload — shape depends on category. */
  data: Record<string, unknown>;
}

/** Short prefix per category, used to build readable event ids. */
export const CATEGORY_PREFIX: Record<Category, string> = {
  log: "log",
  exception: "exc",
  frame: "frm",
  rebuild: "rbd",
  network: "net",
  navigation: "nav",
  state: "stt",
  system: "sys",
};

/** Severity ordering for threshold filters. */
export const SEVERITY_RANK: Record<Severity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};
