# Evaluation

Does the diagnosis actually get the right answer?

Every other test in this repo builds a store by hand and checks what the engine
does with it. That is worth having, and it measures the code against its
author's expectations — not against an app that actually misbehaved. This
directory measures the second thing.

## How it works

```bash
npm run build && node --test dist/eval/eval.test.js
```

Each file in `incidents/` is a **golden incident**: a real session recorded from
a device with `export_session` in `full` mode, plus what the right answer is.
Replay hydrates the events back into a store with their ids intact, re-runs the
diagnosers, and scores the output.

Nothing new had to be invented to record one. `export_session` was already
versioned, carried every event and every diagnosis, and had its shape pinned by
a test — recording an incident is attaching the export.

## The rule that makes this worth having

**A golden encodes what the right answer is, argued from the events. Never what
the tool currently says.**

A golden produced by pasting today's output is a test that can never fail: it
pins current behaviour and calls it truth. So every incident carries a `why`
field in prose, and the loader rejects a short one. Having to argue the answer
in sentences is what makes a copied golden obvious — there is nothing to write.

## The metric that matters

Not accuracy. **False confidence** — how often the engine commits to a cause and
is wrong.

A tool that says "unknown" when it cannot tell costs a developer nothing; they
go and look themselves, which is what they were doing anyway. A tool that says
"the network call caused your jank" at 85% confidence when it did not sends them
somewhere the bug is not, and spends the credibility that makes every correct
answer worth reading.

So the gate is asymmetric: accuracy has a floor, false confidence has a ceiling
of **zero**. Both are verified to fail, not assumed to — see below.

## The incidents

| Incident | Right answer | Why it is here |
| --- | --- | --- |
| `jank-20pct-build-bound` | `jank`, diagnosed, ~0.8 | 48/240 frames (20.0%) over budget, worst 64.5ms, build-bound. Nothing competes: no exceptions, no network, only info logs |
| `unknown-jank-just-under-threshold` | `unknown` | 74/381 frames (19.4%) — real jank, below the 20% the hypothesis requires, and no other fault. The honest answer is "nothing I can name" |
| `exception-uncaught-build-failure` | `exception`, diagnosed, ~0.8 | An uncaught `StateError` thrown inside `build`, twice, with a stack. 24.3% of frames are janky too — so the jank hypothesis fires and must still lose |
| `jank-with-incidental-framework-error` | `jank`, diagnosed, ~0.8 | A `RenderFlex overflowed` error *and* real jank. The exception must lose: in the 3s either side of it not one of 50 frames missed budget |

The first two are a deliberate pair, and the pairing is the point: 19.4% must
stay unknown, 20.0% must be diagnosed. Together they pin the **boundary**, which
is the part of a heuristic that actually drifts. Two unrelated incidents would
not.

The last two are a **ranking** pair, and between them they say that
`exception present` is not `exception is the root cause`. One session's
exception is an uncaught `StateError` with a stack pointing at a line of
application code; the other's is `A RenderFlex overflowed by 390 pixels`, which
arrives in the same category, at the same severity, on the same stream — and
carries no stack, because no application code threw. Both sessions also contain
jank that clears the hypothesis' threshold. The right answers are opposite, so
no fixed ordering of `exception` against `jank` can satisfy both, which is how
the unconditional priority that used to exist was found to be wrong.

A note on what a golden here may lean on — and on what changed because of these
three. All of them were recorded while events were stamped on *receipt*, which
made fine-grained ordering unusable: DDS drains a backlog at connect, where
receipt order is drain order, and over adb/WiFi delivery stalls and then flushes
111 frame events into one second. That is why one incident's `why` withdraws an
ordering claim, and why another had to be recorded over loopback after four
device captures were discarded.

Collectors now stamp events with the VM's own clock, so that constraint is
lifted for anything recorded from here on, and a device recording of an
ordering-sensitive incident is viable again. The three fixtures above predate
the fix and their `capturedFrom` says so. When re-recording one, check
`session.clockOffsetMs` in the export: captured events carry the VM's clock
while this server's own notes carry the host's, and a large offset means the two
are not comparable.

Verified by mutation — the gate is not decoration:

| Change | Result |
| --- | --- |
| jank threshold 20% → 15% | 3 tests fail, **including false confidence**: the 19.4% session gets a confident jank verdict it has not earned |
| jank threshold 20% → 25% | 2 tests fail on accuracy and evidence, and **false confidence does not fire** — abstaining when jank was real is wrong, not confidently wrong |
| exception detector blinded | 3 tests fail, **including false confidence**: the crash session is answered `jank`, confidently and wrongly |
| jank priority raised above exception | same 3 failures — the ranking is load-bearing, not cosmetic |
| stack-trace confidence bonus removed | 1 test fails on the band (0.7 against [0.75, 0.85]); **false confidence stays 0%** — less sure about the right cause is not confidently wrong |
| exception priority made unconditional again | 3 tests fail, false confidence **25%** — the overflow is named as the cause of a build-bound stall |
| jank strength dropped below the 0.7 threshold | 1 test fails on status and band; **false confidence stays 0%** — the engine abstains rather than answering wrongly |
| worst-frame-first evidence ordering removed | 1 test fails on evidence recall alone — the verdict stops citing the frame it rests on |

Too eager trips the ceiling. Too cautious trips the floor. Different failures,
which is what the scoring is for.

## Not covered yet

- **No network incident.** Both probes are offline.
- **No memory incident.** Needs a session long enough to show sustained growth.
- **No incident where the exception is starved by volume.** The regression that
  motivated it — a flat 2,000-event diagnosis window letting a bursty category
  crowd out the session's only exception — is guarded by a unit test in
  `src/diagnosis/engine.test.ts` instead. A capture large enough to reproduce it
  is ~1 MB of mostly repeated provider events, which buys a fixture no sharper
  than 30 deterministic lines.
- **No memory incident.** Needs a session long enough to show sustained growth.
- **Confidence bands are policy, not calibration.** They say "the engine should
  be about this sure", chosen to leave room for tuning. They are not evidence
  that 0.8 means 80%.
- **Four incidents is a floor, not a suite.** Top-1 accuracy over four cases is
  a regression guard, not a measurement of the engine's accuracy. Do not quote
  it as one.
- **No incident where an exception is incidental and nothing else fires.** The
  demotion is guarded by unit tests in `src/diagnosis/engine.test.ts`, not by a
  recording.

## Adding an incident

1. Run the app, connect, reproduce the behaviour, call `export_session` with
   `mode: "full"`.
2. Read the events. Decide what the right answer is *from them*.
3. Write `incidents/<name>.json`: `name`, `capturedFrom`, `why`, `expect`,
   `session`.
4. Run the suite. If it fails, decide which is wrong — the engine or your
   expectation — and say which in the commit.

Raise the floors when the set grows. Never lower one to make a run pass: a
lowered floor is a regression with paperwork.
