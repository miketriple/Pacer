/* ============================================================
   pace.test.js — tests for the pace data model in pace.js.
   Covers flattening groups, migration of old formats, metadata,
   id regeneration, and step lookup.
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import {
  flattenItems, migratePace, paceMeta, regenIds, findStepById, colorHex,
} from '../pace.js';

// ── flattenItems ─────────────────────────────────────────────

test('flattenItems — passes through plain steps unchanged', () => {
  const items = [
    { type: 'step', id: 'a', name: 'A', duration: 10 },
    { type: 'step', id: 'b', name: 'B', duration: 20 },
  ];
  const flat = flattenItems(items);
  assert.equal(flat.length, 2);
  assert.deepEqual(flat.map(s => s.name), ['A', 'B']);
});

test('flattenItems — expands a group by its repeat count', () => {
  const items = [{
    type: 'group', name: 'Round', repeats: 2,
    steps: [
      { type: 'step', name: 'Work', duration: 5 },
      { type: 'step', name: 'Rest', duration: 3 },
    ],
  }];
  const flat = flattenItems(items);
  assert.equal(flat.length, 4);                                  // 2 steps × 2 repeats
  assert.deepEqual(flat.map(s => s.name), ['Work', 'Rest', 'Work', 'Rest']);
});

test('flattenItems — tags grouped steps with repeat metadata', () => {
  const items = [{
    type: 'group', name: 'Round', repeats: 2,
    steps: [{ type: 'step', name: 'Work', duration: 5 }],
  }];
  const flat = flattenItems(items);
  assert.equal(flat[0]._groupName, 'Round');
  assert.equal(flat[0]._repeat, 1);
  assert.equal(flat[1]._repeat, 2);
  assert.equal(flat[0]._totalRepeats, 2);
});

test('flattenItems — non-array input yields an empty array', () => {
  assert.deepEqual(flattenItems(undefined), []);
  assert.deepEqual(flattenItems(null), []);
});

// ── migratePace ──────────────────────────────────────────────

test('migratePace — already-migrated pace is returned unchanged', () => {
  const pace = { items: [{ type: 'step', name: 'A', duration: 10 }] };
  assert.equal(migratePace(pace), pace);   // same reference, untouched
});

test('migratePace — old segments[] format becomes items[]', () => {
  const migrated = migratePace({
    name: 'Legacy',
    segments: [{ label: 'Work', duration: 30, phase: 'work' }],
  });
  assert.equal(migrated.type, 'custom');
  assert.equal(migrated.items.length, 1);
  assert.equal(migrated.items[0].name, 'Work');
  assert.equal(migrated.items[0].duration, 30);
  assert.equal(migrated.items[0].color, 'red');                 // phase 'work' → red
});

test('migratePace — phase maps to the right color', () => {
  const m = migratePace({ segments: [{ label: 'WU', duration: 60, phase: 'warmup' }] });
  assert.equal(m.items[0].color, 'yellow');
});

test('migratePace — old interval format becomes a warmup + group + cooldown', () => {
  const m = migratePace({
    type: 'interval',
    warmupDuration: 60, workDuration: 40, restDuration: 20,
    rounds: 3, cooldownDuration: 30,
  });
  assert.equal(m.items.length, 3);                              // warmup, group, cooldown
  assert.equal(m.items[0].name, 'Warm Up');
  assert.equal(m.items[1].type, 'group');
  assert.equal(m.items[1].repeats, 3);
  assert.deepEqual(m.items[1].steps.map(s => s.name), ['Work', 'Rest']);
  assert.equal(m.items[2].name, 'Cool Down');
});

// ── paceMeta ─────────────────────────────────────────────────

test('paceMeta — summarizes step count and total time', () => {
  const pace = { items: [
    { type: 'step', duration: 60 },
    { type: 'step', duration: 60 },
  ] };
  assert.equal(paceMeta(pace), '2 steps · 02:00');
});

test('paceMeta — uses singular "step" for a one-step pace', () => {
  assert.equal(paceMeta({ items: [{ type: 'step', duration: 30 }] }), '1 step · 00:30');
});

// ── regenIds ─────────────────────────────────────────────────

test('regenIds — replaces ids on steps, nested group steps, and cues', () => {
  const items = [
    { type: 'step', id: 'old-step', voiceCues: [{ id: 'old-cue', text: 'x' }] },
    { type: 'group', id: 'old-group', steps: [{ type: 'step', id: 'old-nested' }] },
  ];
  regenIds(items);
  assert.notEqual(items[0].id, 'old-step');
  assert.notEqual(items[0].voiceCues[0].id, 'old-cue');
  assert.notEqual(items[1].id, 'old-group');
  assert.notEqual(items[1].steps[0].id, 'old-nested');
});

// ── findStepById ─────────────────────────────────────────────

test('findStepById — finds a top-level step', () => {
  const items = [{ type: 'step', id: 'x', name: 'Target' }];
  assert.equal(findStepById(items, 'x').name, 'Target');
});

test('findStepById — finds a step nested inside a group', () => {
  const items = [{ type: 'group', steps: [{ type: 'step', id: 'y', name: 'Nested' }] }];
  assert.equal(findStepById(items, 'y').name, 'Nested');
});

test('findStepById — returns null when not found', () => {
  assert.equal(findStepById([{ type: 'step', id: 'x' }], 'missing'), null);
});

// ── colorHex ─────────────────────────────────────────────────

test('colorHex — known color resolves, unknown falls back to default', () => {
  assert.equal(colorHex('red'), '#ff4444');
  assert.equal(colorHex('not-a-color'), colorHex('blue'));      // DEFAULT_COLOR
});
