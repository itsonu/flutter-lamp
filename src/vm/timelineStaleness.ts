/**
 * Staleness of the VM timeline recorder.
 *
 * Measured on a physical Android device (Dart 3.12, recorder "Ring",
 * 2026-08-25): the recorder silently stalls once its buffer fills
 * (~24,500 events) — `getVMTimelineFlags` keeps reporting the streams as
 * recorded while no new events are written. `clearVMTimeline` restores
 * recording, but nothing detects the stall for you: a consumer that trusts
 * the flags will happily read minutes-old events as if they were current.
 *
 * The defence is arithmetic: compare the newest event's monotonic timestamp
 * against `getVMTimelineMicros`. A recorder that is minutes behind "now" is
 * stalled regardless of what the flags say.
 */

export interface TimelineStaleness {
  /** Gap between the VM's current timeline clock and the newest event, ms. */
  recorderLagMs: number | null;
  /** True when the lag exceeds the stall threshold. */
  stalled: boolean;
  /** Present exactly when stalled — written for the agent. */
  warning?: string;
}

/**
 * Beyond this lag the recorder is treated as stalled. Generous on purpose:
 * an idle app can legitimately go seconds without a timeline event, but not
 * this long while the app is running at all.
 */
export const STALL_THRESHOLD_MS = 30_000;

export function timelineStaleness(
  nowMicros: number | null,
  events: Array<{ ts?: number }>,
): TimelineStaleness {
  const newest = events.reduce<number>((max, e) => Math.max(max, e.ts ?? 0), 0);
  if (nowMicros === null || newest === 0) {
    return { recorderLagMs: null, stalled: false };
  }
  const recorderLagMs = Math.max(0, Math.round((nowMicros - newest) / 1000));
  if (recorderLagMs <= STALL_THRESHOLD_MS) return { recorderLagMs, stalled: false };
  return {
    recorderLagMs,
    stalled: true,
    warning:
      `The newest timeline event is ${Math.round(recorderLagMs / 1000)}s behind the VM's timeline clock. ` +
      "The recorder has likely stalled (it stops once its buffer fills, while still reporting its streams " +
      "as recorded). Treat these events as historical, not current; clearVMTimeline or an app restart resets the recorder.",
  };
}
