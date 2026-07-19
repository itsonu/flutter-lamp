/**
 * Canonical runtime event model.
 *
 * Per docs/Rules.md every runtime event MUST carry: timestamp, source,
 * severity, category. Everything the collectors produce funnels through this
 * shape so tools and the diagnosis engine reason over one uniform stream.
 */

export type Severity = "debug" | "info" | "warning" | "error" | "critical";

export type Category =
  | "log"
  | "exception"
  | "frame"
  | "network"
  | "system";

export interface RuntimeEvent {
  /** Monotonic id assigned by the store (insertion order). */
  id: number;
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

/** Severity ordering for threshold filters. */
export const SEVERITY_RANK: Record<Severity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};
