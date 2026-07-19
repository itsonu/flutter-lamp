import { EventEmitter } from "node:events";
import type { Category, RuntimeEvent, Severity } from "./events.js";
import { SEVERITY_RANK } from "./events.js";

export interface QueryOptions {
  category?: Category;
  /** Minimum severity (inclusive). */
  minSeverity?: Severity;
  /** Only events at/after this epoch-ms. */
  since?: number;
  /** Substring match against `message` (case-insensitive). */
  contains?: string;
  /** Max events returned (most recent first). */
  limit?: number;
}

/**
 * Centralized runtime cache (docs/Rules.md: "Runtime cache is centralized").
 *
 * A single capped ring buffer holds every event from every collector so we
 * "never lose runtime history" within the retention window. Capacity bounds
 * memory for long-running sessions; the oldest events roll off first.
 *
 * Emits `"event"` (a single `RuntimeEvent`) on every add and `"clear"` when
 * cleared, so live consumers (the dashboard) stream without polling. Consumers
 * subscribe ONCE and fan out to their own clients — the store keeps one
 * listener regardless of how many browsers are watching.
 */
export class RuntimeStore extends EventEmitter {
  private events: RuntimeEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 5000) {
    super();
    this.setMaxListeners(0); // consumers manage their own fan-out
  }

  add(event: Omit<RuntimeEvent, "id">): RuntimeEvent {
    const stored: RuntimeEvent = { ...event, id: this.nextId++ };
    this.events.push(stored);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    this.emit("event", stored);
    return stored;
  }

  /** Most-recent-first query. */
  query(opts: QueryOptions = {}): RuntimeEvent[] {
    const minRank = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : -1;
    const needle = opts.contains?.toLowerCase();
    const out: RuntimeEvent[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (opts.category && e.category !== opts.category) continue;
      if (minRank >= 0 && SEVERITY_RANK[e.severity] < minRank) continue;
      if (opts.since !== undefined && e.timestamp < opts.since) continue;
      if (needle && !e.message.toLowerCase().includes(needle)) continue;
      out.push(e);
      if (opts.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  /** Count by category — used for health/summary reporting. */
  counts(): Record<Category, number> {
    const c: Record<Category, number> = {
      log: 0,
      exception: 0,
      frame: 0,
      network: 0,
      system: 0,
    };
    for (const e of this.events) c[e.category]++;
    return c;
  }

  size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.emit("clear");
  }
}
