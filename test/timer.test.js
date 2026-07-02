/* ============================================================
   timer.test.js — tests for the pure timeline math in timer.js.
   resolveActiveSegment is what keeps the UI anchored to the same
   absolute timeline as the native audio (no accumulated drift).
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { resolveActiveSegment, TimerEngine } from '../timer.js';

const seg = d => ({ duration: d });

test('resolveActiveSegment — stays put while now is within the current segment', () => {
  const segs = [seg(4), seg(4), seg(4)];
  const r = resolveActiveSegment(0, 1000, segs, 1000 + 3999);   // 3.999s into a 4s segment
  assert.deepEqual(r, { index: 0, startTime: 1000 });
});

test('resolveActiveSegment — advances exactly one segment at the boundary', () => {
  const segs = [seg(4), seg(4), seg(4)];
  const r = resolveActiveSegment(0, 1000, segs, 1000 + 4000);   // exactly at the boundary
  assert.deepEqual(r, { index: 1, startTime: 5000 });
});

test('resolveActiveSegment — skips multiple segments after a long gap (backgrounded)', () => {
  const segs = [seg(4), seg(4), seg(4), seg(4)];
  const r = resolveActiveSegment(0, 0, segs, 9000);             // 9s in → 3rd segment
  assert.deepEqual(r, { index: 2, startTime: 8000 });
});

test('resolveActiveSegment — stops at a manual (duration 0) segment', () => {
  const segs = [seg(4), seg(0), seg(4)];
  const r = resolveActiveSegment(0, 0, segs, 999999);           // huge elapsed
  assert.deepEqual(r, { index: 1, startTime: 4000 });           // halts at the manual step
});

test('resolveActiveSegment — returns the end index when the timeline is exhausted', () => {
  const segs = [seg(4), seg(4)];
  const r = resolveActiveSegment(0, 0, segs, 999999);
  assert.equal(r.index, segs.length);                           // caller treats this as complete
});

test('resolveActiveSegment — anchored starts never accumulate, even if now arrives late', () => {
  const segs = [seg(4), seg(4), seg(4)];
  // "now" lands late past each boundary, but the returned start is the exact
  // multiple of the durations — that lack of drift is the whole point.
  assert.equal(resolveActiveSegment(0, 0, segs, 4123).startTime, 4000);
  assert.equal(resolveActiveSegment(0, 0, segs, 8210).startTime, 8000);
});

/* ── TimerEngine.visualState — the per-frame view the ring renders from.
   Its job is to resolve straight through the window where the 250 ms
   heartbeat hasn't advanced the engine past a boundary yet. ── */

test('visualState — resolves into the next segment before the heartbeat advances', () => {
  const engine = new TimerEngine();
  try {
    const t0 = Date.now();
    engine.start([seg(4), seg(4)]);
    // 100 ms past the first boundary. No tick has fired (we're synchronous),
    // so the engine still reports segment 0 — the visual view must not.
    const vs = engine.visualState(t0 + 4100);
    assert.equal(engine.segmentIndex, 0);
    assert.equal(vs.index, 1);
    assert.equal(vs.duration, 4);
    assert.equal(vs.isManual, false);
    assert.ok(Math.abs(vs.elapsed - 0.1) < 0.05, `elapsed ≈ 0.1, got ${vs.elapsed}`);
  } finally {
    engine.stop();
  }
});

test('visualState — freezes at the pause instant regardless of the clock', () => {
  const engine = new TimerEngine();
  try {
    engine.start([seg(4), seg(4)]);
    engine.pause();
    const vs = engine.visualState(Date.now() + 99999);
    assert.equal(vs.index, 0);
    assert.ok(vs.elapsed < 0.05, `elapsed frozen near 0, got ${vs.elapsed}`);
  } finally {
    engine.stop();
  }
});

test('visualState — halts at a manual segment with growing elapsed', () => {
  const engine = new TimerEngine();
  try {
    const t0 = Date.now();
    engine.start([seg(2), seg(0)]);
    const vs = engine.visualState(t0 + 10000);
    assert.equal(vs.index, 1);
    assert.equal(vs.isManual, true);
    assert.ok(Math.abs(vs.elapsed - 8) < 0.05, `elapsed ≈ 8, got ${vs.elapsed}`);
  } finally {
    engine.stop();
  }
});

test('visualState — null when idle or when the timeline is exhausted', () => {
  const engine = new TimerEngine();
  assert.equal(engine.visualState(), null);
  try {
    const t0 = Date.now();
    engine.start([seg(1)]);
    assert.equal(engine.visualState(t0 + 5000), null);
  } finally {
    engine.stop();
  }
});
