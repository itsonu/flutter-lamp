/**
 * What counts as a late frame, and on whose authority.
 *
 * The budget was a literal in four places — 16_667 in the frame collector,
 * 16.67 in the performance diagnosis, and "16.7ms" written into two strings.
 * Four copies of one policy is a drift waiting to happen, and the policy itself
 * was stated as a fact when it is an assumption.
 *
 * ## Why it is not derived from observed cadence
 *
 * The obvious move is to measure the display's refresh period and use that.
 * Measured against real recorded sessions, it does not work with what is
 * currently collected:
 *
 * - **Stored frame data has no frame start time.** `Flutter.Frame` is reduced to
 *   `number`, `elapsed`, `build`, `raster` before it reaches the store, so the
 *   only per-frame clock is the event's arrival timestamp.
 * - **Arrival timestamps are batched.** DDS delivers buffered stream events on
 *   subscribe and in bursts thereafter. In a recorded device session of 240
 *   frames the median inter-arrival delta was **0ms** with a maximum of
 *   7,703ms, while 235 of 239 frame-number pairs were consecutive — the app was
 *   rendering continuously and the arrival clock still could not see it.
 * - **`elapsed` is work per frame, not the vsync period.** A 3ms frame on a
 *   60Hz display is an idle frame, not a fast display. A low median elapsed is
 *   consistent with a faster panel but does not demonstrate one: the same
 *   recorded session shows p50 8.23ms, which a 60Hz device doing light work
 *   produces just as readily as a 120Hz device.
 *
 * So the refresh rate is **unknown**, and this module says so rather than
 * inferring it from a signal that cannot carry it. {@link cadenceEvidence}
 * reports whether a target supplies what a future derivation would need;
 * {@link FrameCollector} now stores those fields when the event carries them,
 * so the question can be answered from evidence rather than reopened from
 * first principles.
 *
 * A developer who *knows* their device's refresh rate can supply the fact the
 * runtime cannot: `FLUTTER_LAMP_FRAME_BUDGET_MS=8.33`. That is a configured
 * value with a named provenance, not a silent default.
 */

/** The 60fps period. Assumed, not observed — see the note above. */
export const ASSUMED_BUDGET_MS = 16.67;

/** Refresh periods a developer plausibly has, for validating an override. */
const MIN_BUDGET_MS = 1;
const MAX_BUDGET_MS = 100;

export type BudgetSource = "configured" | "assumed";

export interface FrameBudget {
  /** The threshold in milliseconds. */
  ms: number;
  /** Where the number came from. Never omitted, so a caller cannot present an
   *  assumption as a measurement by accident. */
  source: BudgetSource;
  /** One clause naming the provenance, for a summary or a UI label. */
  detail: string;
}

let cached: FrameBudget | null = null;

/**
 * The effective budget and its provenance.
 *
 * Read once and cached: the collector consults this per frame, and re-reading
 * the environment thousands of times a second to get the same answer is waste.
 * {@link resetFrameBudget} exists for tests.
 */
export function frameBudget(): FrameBudget {
  if (cached) return cached;
  const raw = process.env.FLUTTER_LAMP_FRAME_BUDGET_MS;
  if (raw !== undefined && raw !== "") {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms >= MIN_BUDGET_MS && ms <= MAX_BUDGET_MS) {
      cached = {
        ms,
        source: "configured",
        detail: `configured via FLUTTER_LAMP_FRAME_BUDGET_MS (${ms}ms, ~${Math.round(1000 / ms)}fps)`,
      };
      return cached;
    }
    // A bad override is reported, not silently swallowed into the default —
    // otherwise a typo looks exactly like a working configuration.
    console.error(
      `[flutter-lamp] ignoring FLUTTER_LAMP_FRAME_BUDGET_MS="${raw}": ` +
        `expected a number between ${MIN_BUDGET_MS} and ${MAX_BUDGET_MS}. Using the assumed 60fps budget.`,
    );
  }
  cached = {
    ms: ASSUMED_BUDGET_MS,
    source: "assumed",
    detail: "assumed 60fps — the VM Service does not report the display refresh rate",
  };
  return cached;
}

/** Test seam: drop the cached read so a test can change the environment. */
export function resetFrameBudget(): void {
  cached = null;
}

/** Milliseconds, for the collector's microsecond comparisons. */
export function frameBudgetUs(): number {
  return frameBudget().ms * 1000;
}

export interface CadenceEvidence {
  /** True when the target supplies per-frame start times at all. */
  derivable: boolean;
  /** Consecutive-frame start-time samples available. */
  samples: number;
  /** Why the answer is what it is, in one clause. */
  detail: string;
}

/**
 * Could this target's refresh period be derived from the frames on hand?
 *
 * Deliberately answers only that question. It does not return a rate, because
 * returning one from insufficient evidence is the failure this whole module
 * exists to avoid. A caller uses it to decide whether to say "unknown" or to
 * point at the override.
 */
export function cadenceEvidence(
  frames: ReadonlyArray<{ data: { number?: unknown; startTimeUs?: unknown } }>,
): CadenceEvidence {
  let samples = 0;
  let lastNumber: number | null = null;
  let lastStart: number | null = null;
  for (const f of frames) {
    const n = typeof f.data.number === "number" ? f.data.number : null;
    const t = typeof f.data.startTimeUs === "number" ? f.data.startTimeUs : null;
    if (n !== null && t !== null && lastNumber !== null && lastStart !== null && n === lastNumber + 1) samples++;
    lastNumber = n;
    lastStart = t;
  }
  if (samples === 0)
    return {
      derivable: false,
      samples: 0,
      detail:
        "this target does not report per-frame start times, and event arrival times are batched, " +
        "so the display refresh period cannot be measured from the frames captured here",
    };
  // Enough consecutive samples exist that a future release could take the modal
  // interval. Reporting the possibility is not the same as claiming the rate.
  return {
    derivable: true,
    samples,
    detail: `${samples} consecutive-frame start-time intervals are available on this target`,
  };
}
