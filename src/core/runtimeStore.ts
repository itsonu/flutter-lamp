import { EventEmitter } from "node:events";
import type { Category, RuntimeEvent, Severity } from "./events.js";
import { CATEGORIES, CATEGORY_PREFIX, SEVERITY_RANK } from "./events.js";

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
  /**
   * Which session to read. Defaults to "current": evidence from a previous app
   * run must not be correlated with this one. "all" reads the whole retained
   * history, which is what a human watching the dashboard wants.
   */
  sessions?: "current" | "all";
}

/**
 * How many events of each category are retained.
 *
 * These are deliberately NOT one shared budget. A frame event is produced every
 * frame — 60 per second — while an exception might arrive once an hour. Under a
 * single shared cap the frame stream evicts every exception, network request and
 * log within a couple of minutes, destroying exactly the evidence this project
 * exists to keep. Each category gets its own budget so a noisy stream can only
 * ever evict itself.
 *
 * Frames get the smallest window because they are the least individually
 * interesting and the most numerous; jank is still visible through severity.
 */
export const DEFAULT_CAPACITIES: Record<Category, number> = {
  exception: 1_000,
  network: 1_000,
  log: 3_000,
  frame: 1_000,
  system: 500,
};

/**
 * Fixed-size circular buffer. Overwrites the oldest entry when full, in O(1) —
 * the previous implementation spliced the front off a plain array on every
 * insert past capacity, copying the whole buffer 60 times a second inside the
 * tool whose job is diagnosing performance problems.
 */
class Ring<T> {
  private readonly items: (T | undefined)[];
  private head = 0; // next write position
  private count = 0;
  /** How many entries have been overwritten — retention loss, reported not hidden. */
  evicted = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    if (this.count === this.capacity) this.evicted++;
    this.items[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get size(): number {
    return this.count;
  }

  /** Newest first. */
  *newestFirst(): Generator<T> {
    for (let i = 1; i <= this.count; i++) {
      yield this.items[(this.head - i + this.capacity) % this.capacity] as T;
    }
  }

  /** The oldest retained entry, or undefined when empty. */
  oldest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.items[(this.head - this.count + this.capacity) % this.capacity];
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.evicted = 0;
  }
}

export interface RetentionReport {
  capacity: Record<Category, number>;
  retained: Record<Category, number>;
  /** Events dropped to stay within capacity, by category. */
  evicted: Record<Category, number>;
  /** Epoch ms of the oldest retained event, or null when the store is empty. */
  oldestEventMs: number | null;
}

/**
 * Centralized runtime cache (docs/Rules.md: "Runtime cache is centralized").
 *
 * One store, one event shape, but one ring buffer per category so a high-volume
 * stream cannot evict a low-volume one. Retention is bounded and the bounds are
 * reported through `retention()` — a capped buffer is fine, a silently capped
 * buffer is not, because an agent reasoning over truncated history has no way to
 * know its evidence was incomplete.
 *
 * Emits `"event"` (a single `RuntimeEvent`) on every add and `"clear"` when
 * cleared, so live consumers (the dashboard) stream without polling. Consumers
 * subscribe ONCE and fan out to their own clients — the store keeps one
 * listener regardless of how many browsers are watching.
 */
export class RuntimeStore extends EventEmitter {
  private readonly rings: Record<Category, Ring<RuntimeEvent>>;
  private nextId = 1;
  private sessionId: string | null = null;
  private sessionSeq = 0;

  constructor(capacities: Partial<Record<Category, number>> = {}) {
    super();
    this.setMaxListeners(0); // consumers manage their own fan-out
    this.rings = {} as Record<Category, Ring<RuntimeEvent>>;
    for (const category of CATEGORIES) {
      this.rings[category] = new Ring(capacities[category] ?? DEFAULT_CAPACITIES[category]);
    }
  }

  /**
   * Start a new debugging session and return its id. Called on every connect,
   * so a hot restart or a reconnect is a visible boundary in the evidence
   * rather than an invisible seam two app runs get correlated across.
   */
  beginSession(): string {
    this.sessionId = `s${++this.sessionSeq}`;
    return this.sessionId;
  }

  /** The session events are currently being stamped with, if any. */
  currentSession(): string | null {
    return this.sessionId;
  }

  add(event: Omit<RuntimeEvent, "id" | "eventId" | "sessionId">): RuntimeEvent {
    const id = this.nextId++;
    const stored: RuntimeEvent = {
      ...event,
      id,
      eventId: `${CATEGORY_PREFIX[event.category]}_${String(id).padStart(5, "0")}`,
      sessionId: this.sessionId,
    };
    this.rings[stored.category].push(stored);
    this.emit("event", stored);
    return stored;
  }

  /**
   * Look up a single event by its stable id. Diagnoses cite ids; something has
   * to be able to resolve them back to the evidence.
   */
  byEventId(eventId: string): RuntimeEvent | undefined {
    for (const e of this.newestFirst()) if (e.eventId === eventId) return e;
    return undefined;
  }

  /** Most-recent-first query, merged across categories in arrival order. */
  query(opts: QueryOptions = {}): RuntimeEvent[] {
    const minRank = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : -1;
    const needle = opts.contains?.toLowerCase();
    // No session started (direct store use, tests) means no session filtering.
    const scope = opts.sessions === "all" ? null : this.sessionId;
    const out: RuntimeEvent[] = [];
    for (const e of this.newestFirst(opts.category)) {
      if (scope !== null && e.sessionId !== scope) continue;
      if (minRank >= 0 && SEVERITY_RANK[e.severity] < minRank) continue;
      if (opts.since !== undefined && e.timestamp < opts.since) continue;
      if (needle && !e.message.toLowerCase().includes(needle)) continue;
      out.push(e);
      if (opts.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  /**
   * Newest-first across one or all categories. With no category filter this is
   * a k-way merge over the per-category rings, ordered by insertion id, so the
   * caller still sees one chronological stream and can stop early.
   */
  private *newestFirst(category?: Category): Generator<RuntimeEvent> {
    if (category) {
      yield* this.rings[category].newestFirst();
      return;
    }
    const iterators = CATEGORIES.map((c) => this.rings[c].newestFirst());
    const heads = iterators.map((it) => it.next());
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].done) continue;
        if (best === -1 || heads[i].value.id > heads[best].value.id) best = i;
      }
      if (best === -1) return;
      yield heads[best].value;
      heads[best] = iterators[best].next();
    }
  }

  /** Count by category — used for health/summary reporting. */
  counts(): Record<Category, number> {
    const c = {} as Record<Category, number>;
    for (const category of CATEGORIES) c[category] = this.rings[category].size;
    return c;
  }

  /** What is being kept, what was dropped, and how far back the history goes. */
  retention(): RetentionReport {
    const capacity = {} as Record<Category, number>;
    const retained = {} as Record<Category, number>;
    const evicted = {} as Record<Category, number>;
    let oldest: number | null = null;
    for (const category of CATEGORIES) {
      const ring = this.rings[category];
      capacity[category] = ring.capacity;
      retained[category] = ring.size;
      evicted[category] = ring.evicted;
      const first = ring.oldest();
      if (first && (oldest === null || first.timestamp < oldest)) oldest = first.timestamp;
    }
    return { capacity, retained, evicted, oldestEventMs: oldest };
  }

  size(): number {
    let total = 0;
    for (const category of CATEGORIES) total += this.rings[category].size;
    return total;
  }

  clear(): void {
    for (const category of CATEGORIES) this.rings[category].clear();
    this.emit("clear");
  }
}
