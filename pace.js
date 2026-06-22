/* ============================================================
   pace.js — Pace data model: factories, transforms, migration.
   Pure functions only. No DOM, no side effects.
   Safe to test in Node without a browser.
   ============================================================ */

import { genId, formatTime } from './utils.js';

// ── Constants ────────────────────────────────────────────────

export const STEP_COLORS = {
  red:    '#ff4444',
  orange: '#ff8c00',
  yellow: '#ffd700',
  green:  '#39c759',
  teal:   '#00c9a7',
  blue:   '#4488ff',
  purple: '#a044ff',
  pink:   '#ff44aa',
  white:  '#e8e8e8',
  grey:   '#888888',
};

export const DEFAULT_COLOR         = 'blue';
export const DEFAULT_STEP_DURATION = 60;

// ── Lookup ───────────────────────────────────────────────────

export function colorHex(colorKey) {
  return STEP_COLORS[colorKey] || STEP_COLORS[DEFAULT_COLOR];
}

// ── Factories ────────────────────────────────────────────────

export function makeBlankStep() {
  const step = {
    type: 'step', id: genId(),
    name: 'Step', duration: DEFAULT_STEP_DURATION,
    color: DEFAULT_COLOR,
    voiceCues: [],
  };
  step.voiceCues = [{ id: genId(), offsetSeconds: 0, text: step.name }];
  return step;
}

export function makeBlankGroup() {
  return {
    type: 'group', id: genId(),
    name: 'Group', repeats: 3,
    steps: [makeBlankStep(), makeBlankStep()],
  };
}

// ── Transforms ───────────────────────────────────────────────

/**
 * Expand groups × repeats into a flat array of step objects.
 * Each step from a group gets _groupName, _repeat, _totalRepeats metadata.
 */
export function flattenItems(items) {
  if (!Array.isArray(items)) return [];
  const result = [];
  for (const item of items) {
    if (item.type === 'step') {
      result.push(item);
    } else if (item.type === 'group') {
      for (let r = 0; r < (item.repeats || 1); r++) {
        for (const step of (item.steps || [])) {
          result.push({ ...step, _groupName: item.name, _repeat: r + 1, _totalRepeats: item.repeats });
        }
      }
    }
  }
  return result;
}

/**
 * Like flattenItems, but also returns the AUTHORED structure for the run view:
 * one "unit" per authored step (a group is counted once, not ×repeats) plus the
 * section list. Each flat segment is tagged with _unitIndex (which authored unit
 * it belongs to) and _sectionIndex, so the running UI can map its live position
 * back onto the structure. flattenItems is left untouched — other call sites
 * (home cards, paceMeta) depend on its exact passthrough output.
 *
 *   units    — [{ sectionIndex, name, color }]                    one per dot
 *   sections — [{ name, kind:'step'|'group', unitStart, unitCount, totalRounds }]
 *   flat     — flattenItems-shaped segments + _unitIndex/_sectionIndex
 */
export function buildRunStructure(items) {
  const flat = [], units = [], sections = [];
  if (!Array.isArray(items)) return { flat, units, sections };

  for (const item of items) {
    const sectionIndex = sections.length;
    if (item.type === 'step') {
      const unitStart = units.length;
      units.push({ sectionIndex, name: item.name, color: item.color });
      sections.push({ name: item.name, kind: 'step', unitStart, unitCount: 1, totalRounds: 1 });
      flat.push({ ...item, _unitIndex: unitStart, _sectionIndex: sectionIndex });
    } else if (item.type === 'group') {
      const steps     = item.steps || [];
      const repeats   = item.repeats || 1;
      const unitStart = units.length;
      steps.forEach(step => units.push({ sectionIndex, name: step.name, color: step.color }));
      sections.push({ name: item.name, kind: 'group', unitStart, unitCount: steps.length, totalRounds: repeats });
      for (let r = 0; r < repeats; r++) {
        steps.forEach((step, si) => {
          flat.push({
            ...step,
            _groupName: item.name, _repeat: r + 1, _totalRepeats: repeats,
            _unitIndex: unitStart + si, _sectionIndex: sectionIndex,
          });
        });
      }
    }
  }
  return { flat, units, sections };
}

/** Human-readable summary: "5 steps · 03:20" */
export function paceMeta(pace) {
  const steps     = flattenItems(pace.items);
  const total     = steps.reduce((a, s) => a + (s.duration || 0), 0);
  const stepCount = steps.length;
  return `${stepCount} step${stepCount !== 1 ? 's' : ''} · ${formatTime(total)}`;
}

/** Assign fresh IDs to every item/step/cue in place (used after deep-cloning a template). */
export function regenIds(items) {
  if (!Array.isArray(items)) return;
  items.forEach(item => {
    item.id = genId();
    if (item.type === 'group') regenIds(item.steps);
    if (Array.isArray(item.voiceCues)) item.voiceCues.forEach(c => c.id = genId());
  });
}

// ── Migration ────────────────────────────────────────────────

/** Upgrade a pace from any older format to the current items-based format. */
export function migratePace(pace) {
  if (Array.isArray(pace.items)) return pace;

  const items = [];

  if (Array.isArray(pace.segments)) {
    pace.segments.forEach(seg => {
      items.push({
        type: 'step', id: genId(),
        name: seg.label || 'Step',
        duration: seg.duration || 60,
        color: seg.phase === 'work'     ? 'red'
             : seg.phase === 'rest'     ? 'blue'
             : seg.phase === 'warmup'   ? 'yellow'
             : seg.phase === 'cooldown' ? 'teal'
             : DEFAULT_COLOR,
        voiceCues: [{ id: genId(), offsetSeconds: 0, text: seg.label || 'Step' }],
      });
    });
  } else if (pace.type === 'interval') {
    if (pace.warmupDuration > 0)
      items.push({ type: 'step', id: genId(), name: 'Warm Up',  duration: pace.warmupDuration,   color: 'yellow', voiceCues: [{ id: genId(), offsetSeconds: 0, text: 'Warm up.'  }] });

    const gs = [];
    gs.push(                { type: 'step', id: genId(), name: 'Work',     duration: pace.workDuration || 40, color: 'red',  voiceCues: [{ id: genId(), offsetSeconds: 0, text: 'Begin!'   }] });
    if (pace.restDuration > 0)
      gs.push(              { type: 'step', id: genId(), name: 'Rest',     duration: pace.restDuration,       color: 'blue', voiceCues: [{ id: genId(), offsetSeconds: 0, text: 'Rest.'    }] });

    items.push({ type: 'group', id: genId(), name: 'Round', repeats: pace.rounds || 1, steps: gs });

    if (pace.cooldownDuration > 0)
      items.push({ type: 'step', id: genId(), name: 'Cool Down', duration: pace.cooldownDuration, color: 'teal', voiceCues: [{ id: genId(), offsetSeconds: 0, text: 'Cool down.' }] });
  }

  return { ...pace, items, type: 'custom' };
}

// ── Query ────────────────────────────────────────────────────

/** Recursively find a step by id across top-level steps and group steps. */
export function findStepById(items, id) {
  for (const item of items) {
    if (item.type === 'step'  && item.id === id) return item;
    if (item.type === 'group') {
      const found = (item.steps || []).find(s => s.id === id);
      if (found) return found;
    }
  }
  return null;
}
