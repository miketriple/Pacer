/* ============================================================
   cues.test.js — tests for the CueScheduler priority model (web path).

   The scheduler is driven through an injected speak function (setSpeakFn),
   so no browser SpeechSynthesis is needed. The injected function records
   what was spoken and hands back a Promise we resolve manually to simulate
   a cue finishing — letting us assert the protected/countdown priority rules:

     - a countdown fires only in silence (skips if anything is speaking)
     - a countdown never interrupts another countdown
     - a protected cue (opening / extra / completion) interrupts a countdown
     - a protected cue queues behind another protected cue
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { CueScheduler } from '../cues.js';

// Build a scheduler whose "speech" we control. spoken[] records utterances in
// order; stops[] records cancellations; finishSpeaking() completes the current
// utterance and lets the scheduler's completion chain run.
function makeScheduler() {
  const spoken = [];
  const stops  = [];
  let pendingResolve = null;
  const cs = new CueScheduler();
  cs.setSpeakFn(
    (text) => { spoken.push(text); return new Promise(res => { pendingResolve = res; }); },
    ()     => { stops.push(true);  return Promise.resolve(); },
  );
  const finishSpeaking = async () => {
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(); }
    await new Promise(res => setTimeout(res, 0));   // flush the .then(done) microtask
  };
  return { cs, spoken, stops, finishSpeaking };
}

test('countdown — skips while a protected opening cue is speaking, resumes once silent', async () => {
  const { cs, spoken, finishSpeaking } = makeScheduler();
  cs.arm({ name: 'Hold', voiceCues: [{ text: 'Hold' }] });
  assert.deepEqual(spoken, ['Hold']);
  cs.countdown(3, 5);                       // opening cue still speaking → skip
  assert.deepEqual(spoken, ['Hold']);
  await finishSpeaking();                    // opening cue done
  cs.countdown(2, 5);                        // silent now → speaks
  assert.deepEqual(spoken, ['Hold', '2']);
});

test('countdown — a number never interrupts another countdown number', async () => {
  const { cs, spoken, stops, finishSpeaking } = makeScheduler();
  cs.arm({ name: '', voiceCues: [] });       // no opening cue to isolate countdown behavior
  cs.countdown(3, 5);                         // silence → "3" speaks
  assert.deepEqual(spoken, ['3']);
  cs.countdown(2, 5);                         // "3" still speaking → "2" skips (no interrupt)
  assert.deepEqual(spoken, ['3']);
  assert.deepEqual(stops, []);               // nothing was cancelled
  await finishSpeaking();                     // "3" done
  cs.countdown(1, 5);                         // silence → "1" speaks
  assert.deepEqual(spoken, ['3', '1']);
});

test('protected extra cue interrupts a speaking countdown number', async () => {
  const { cs, spoken, stops, finishSpeaking } = makeScheduler();
  cs.arm({ name: 'Plank', voiceCues: [{ text: 'Plank' }, { offsetSeconds: 5, text: 'Halfway' }] });
  await finishSpeaking();                     // opening "Plank" done
  cs.countdown(3, 5);                         // "3" speaks
  assert.deepEqual(spoken, ['Plank', '3']);
  cs.tick(5);                                 // extra "Halfway" becomes due → interrupts "3"
  assert.deepEqual(spoken, ['Plank', '3', 'Halfway']);
  assert.equal(stops.length, 1);             // the countdown was cancelled
});

test('protected cue queues behind another protected cue (no interrupt)', async () => {
  const { cs, spoken, stops, finishSpeaking } = makeScheduler();
  cs.arm({ name: 'A', voiceCues: [{ text: 'A' }] });
  cs.speak('B');                             // protected, while A speaking → queues (no cancel)
  assert.deepEqual(spoken, ['A']);
  assert.deepEqual(stops, []);
  await finishSpeaking();                     // A done → B flushes
  assert.deepEqual(spoken, ['A', 'B']);
});
