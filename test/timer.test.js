/* ============================================================
   timer.test.js — tests for the pure timeline math in timer.js.
   resolveActiveSegment is what keeps the UI anchored to the same
   absolute timeline as the native audio (no accumulated drift).
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { resolveActiveSegment } from '../timer.js';

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
