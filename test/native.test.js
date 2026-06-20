/* ============================================================
   native.test.js — tests for the cue-schedule construction in native.js.
   This is the timing-critical logic: which cues fire, when, and with
   what priority flags. Most of the bugs we've chased live here, so this
   is the highest-value test file.

   A cue is { delayMs, text, skipIfBusy? }. delayMs is relative to the
   start of the passed segments. Countdown numbers carry skipIfBusy:true.
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { buildCueSchedule, buildNativeChunk } from '../native.js';

// Helper: a timed step with a single opening cue.
const step = (name, duration) => ({
  name, duration, voiceCues: [{ text: name }],
});

// ── buildCueSchedule: opening cue + countdown ────────────────

test('buildCueSchedule — opening cue at 0, then a full 5-count for a long step', () => {
  const cues = buildCueSchedule([step('Run', 10)], '5', { addCompletionCue: false });
  assert.deepEqual(cues.map(c => c.text),    ['Run', '5', '4', '3', '2', '1']);
  assert.deepEqual(cues.map(c => c.delayMs), [0, 5000, 6000, 7000, 8000, 9000]);
});

test('buildCueSchedule — countdown numbers carry skipIfBusy, the opening cue does not', () => {
  const cues = buildCueSchedule([step('Run', 10)], '5', { addCompletionCue: false });
  const opening = cues.find(c => c.text === 'Run');
  const three   = cues.find(c => c.text === '3');
  assert.equal(opening.skipIfBusy, undefined);
  assert.equal(three.skipIfBusy, true);
});

test('buildCueSchedule — short step fits only the countdown numbers that have room', () => {
  // 4-second box-breathing step with a 5s countdown setting: only 4,3,2,1 fit.
  const cues = buildCueSchedule([step('Inhale', 4)], '5', { addCompletionCue: false });
  assert.deepEqual(cues.map(c => c.text),    ['Inhale', '4', '3', '2', '1']);
  // The opening cue and "4" share delay 0; the opening must sort first so it
  // speaks before the countdown number that yields to it.
  assert.deepEqual(cues.map(c => c.delayMs), [0, 0, 1000, 2000, 3000]);
  assert.equal(cues[0].text, 'Inhale');
});

test('buildCueSchedule — silent countdown produces no countdown numbers', () => {
  const cues = buildCueSchedule([step('Run', 10)], 'silent', { addCompletionCue: false });
  assert.deepEqual(cues.map(c => c.text), ['Run']);
});

test('buildCueSchedule — manual (zero-duration) steps are skipped entirely', () => {
  const cues = buildCueSchedule([{ name: 'Hold', duration: 0 }], '5', { addCompletionCue: false });
  assert.deepEqual(cues, []);
});

test('buildCueSchedule — completion cue fires 500ms after the last step', () => {
  const cues = buildCueSchedule([step('Run', 10)], 'silent');   // addCompletionCue defaults true
  assert.deepEqual(cues.map(c => c.text),    ['Run', 'Pace complete. Well done!']);
  assert.deepEqual(cues.map(c => c.delayMs), [0, 10500]);
});

// ── buildCueSchedule: extra voice cues ───────────────────────

test('buildCueSchedule — extra voice cues fire at their offset within the step', () => {
  const seg = { name: 'Plank', duration: 30, voiceCues: [
    { text: 'Plank' },
    { offsetSeconds: 15, text: 'Halfway' },
  ] };
  const cues = buildCueSchedule([seg], '5', { addCompletionCue: false });
  const halfway = cues.find(c => c.text === 'Halfway');
  assert.equal(halfway.delayMs, 15000);
  // and it sorts ahead of the countdown that starts at 25s
  assert.ok(cues.findIndex(c => c.text === 'Halfway') < cues.findIndex(c => c.text === '5'));
});

test('buildCueSchedule — an extra cue past the step duration is dropped', () => {
  const seg = { name: 'Run', duration: 10, voiceCues: [
    { text: 'Run' },
    { offsetSeconds: 20, text: 'TooLate' },
  ] };
  const cues = buildCueSchedule([seg], 'silent', { addCompletionCue: false });
  assert.equal(cues.find(c => c.text === 'TooLate'), undefined);
});

// ── buildCueSchedule: multiple steps accumulate offset ───────

test('buildCueSchedule — second step is offset by the first step duration', () => {
  const cues = buildCueSchedule([step('A', 10), step('B', 10)], 'silent', { addCompletionCue: false });
  assert.deepEqual(cues.map(c => c.text),    ['A', 'B']);
  assert.deepEqual(cues.map(c => c.delayMs), [0, 10000]);
});

// ── buildNativeChunk: chunking around manual steps ───────────

test('buildNativeChunk — all-timed pace produces one chunk with a completion cue', () => {
  const segs = [step('A', 10), step('B', 10)];
  const cues = buildNativeChunk(segs, 0, 'silent');
  assert.deepEqual(cues.map(c => c.text), ['A', 'B', 'Pace complete. Well done!']);
});

test('buildNativeChunk — chunk ending at a manual step appends that step\'s opening cue', () => {
  // Run (timed) → Pushups (manual) → Rest (timed)
  const segs = [
    step('Run', 10),
    { name: 'Do pushups', duration: 0, voiceCues: [{ text: 'Do pushups' }] },
    step('Rest', 10),
  ];
  const cues = buildNativeChunk(segs, 0, 'silent');
  // The manual step's opening cue is pre-scheduled at the chunk's end (10s),
  // so it fires natively even if the screen is locked at the boundary.
  assert.deepEqual(cues.map(c => c.text),    ['Run', 'Do pushups']);
  assert.deepEqual(cues.map(c => c.delayMs), [0, 10000]);
  // No completion cue — this is not the final chunk.
  assert.equal(cues.find(c => c.text.startsWith('Pace complete')), undefined);
});

test('buildNativeChunk — manual step extra cues are pre-scheduled at their offset', () => {
  const segs = [
    step('Run', 10),
    { name: 'Pushups', duration: 0, voiceCues: [
      { text: 'Do pushups' },
      { offsetSeconds: 5, text: 'Halfway there' },
    ] },
  ];
  const cues = buildNativeChunk(segs, 0, 'silent');
  const extra = cues.find(c => c.text === 'Halfway there');
  assert.equal(extra.delayMs, 15000);   // 10s chunk + 5s into the manual step
});

test('buildNativeChunk — starting on a manual step yields an empty chunk (JS handles it)', () => {
  const segs = [
    step('Run', 10),
    { name: 'Pushups', duration: 0, voiceCues: [{ text: 'Do pushups' }] },
  ];
  // startIdx points at the manual step itself: no timed segments to schedule.
  assert.deepEqual(buildNativeChunk(segs, 1, 'silent'), []);
});

test('buildNativeChunk — final chunk after a manual step gets the completion cue', () => {
  const segs = [
    step('Run', 10),
    { name: 'Pushups', duration: 0, voiceCues: [{ text: 'Do pushups' }] },
    step('Rest', 10),
  ];
  const cues = buildNativeChunk(segs, 2, 'silent');   // just the trailing Rest
  assert.deepEqual(cues.map(c => c.text), ['Rest', 'Pace complete. Well done!']);
});
