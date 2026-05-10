/* ============================================================
   PACER — app.js
   Interval timer with voice cues, themes, and API sync.
   ============================================================ */

'use strict';

// ============================================================
// 1. PRESET DATA
// ============================================================

const M = 60; // seconds per minute — used for readability below

/** Build a segment array with warmup + intervals + cooldown */
function makeSegments(intervals, warmup = 5 * M, cooldown = 5 * M) {
  const segs = [];
  if (warmup > 0) segs.push({ label: 'Warm-up Walk', duration: warmup, phase: 'warmup' });
  segs.push(...intervals);
  if (cooldown > 0) segs.push({ label: 'Cool-down Walk', duration: cooldown, phase: 'cooldown' });
  return segs;
}

/** Repeat a set of intervals n times */
function repeat(n, ...segs) {
  const result = [];
  for (let i = 0; i < n; i++) result.push(...segs.map(s => ({ ...s })));
  return result;
}

/** Jog and walk segment shorthand */
const jog  = dur => ({ label: 'Jog',  duration: dur, phase: 'work' });
const walk = dur => ({ label: 'Walk', duration: dur, phase: 'rest' });
const run  = dur => ({ label: 'Run',  duration: dur, phase: 'work' });

const C25K_CUES = {
  warmup: 'Start your warm-up walk.', work: 'Begin jogging.', rest: 'Walk it out.', cooldown: 'Cool down. Great work.'
};

const C25K_PRESETS = [
  { id: 'c25k-w1', name: 'C25K – Week 1', description: 'Jog 60s / Walk 90s × 8',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments(repeat(8, jog(60), walk(90))) },

  { id: 'c25k-w2', name: 'C25K – Week 2', description: 'Jog 90s / Walk 2min × 6',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments(repeat(6, jog(90), walk(2 * M))) },

  { id: 'c25k-w3', name: 'C25K – Week 3', description: '90s / 90s / 3min / 3min × 2',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments(repeat(2, jog(90), walk(90), jog(3 * M), walk(3 * M))) },

  { id: 'c25k-w4', name: 'C25K – Week 4', description: '3min / 90s / 5min / 2.5min × 2',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([
      jog(3 * M), walk(90), jog(5 * M), walk(150),
      jog(3 * M), walk(90), jog(5 * M),
    ]) },

  { id: 'c25k-w5r1', name: 'C25K – Week 5 · Run 1', description: '5min jog × 3 with 3min walks',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([jog(5 * M), walk(3 * M), jog(5 * M), walk(3 * M), jog(5 * M)]) },

  { id: 'c25k-w5r2', name: 'C25K – Week 5 · Run 2', description: '8min jog / 5min walk / 8min jog',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([jog(8 * M), walk(5 * M), jog(8 * M)]) },

  { id: 'c25k-w5r3', name: 'C25K – Week 5 · Run 3', description: '20 minutes continuous',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([run(20 * M)]) },

  { id: 'c25k-w6r1', name: 'C25K – Week 6 · Run 1', description: '5min / 3min / 8min / 3min / 5min',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([jog(5 * M), walk(3 * M), jog(8 * M), walk(3 * M), jog(5 * M)]) },

  { id: 'c25k-w6r2', name: 'C25K – Week 6 · Run 2', description: '10min jog / 3min walk / 10min jog',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([jog(10 * M), walk(3 * M), jog(10 * M)]) },

  { id: 'c25k-w6r3', name: 'C25K – Week 6 · Run 3', description: '22 minutes continuous',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([run(22 * M)]) },

  { id: 'c25k-w7', name: 'C25K – Week 7', description: '25 minutes continuous',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([run(25 * M)]) },

  { id: 'c25k-w8', name: 'C25K – Week 8', description: '28 minutes continuous',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([run(28 * M)]) },

  { id: 'c25k-w9', name: 'C25K – Week 9', description: '30 minutes — you made it!',
    type: 'sequence', isPreset: true, group: 'c25k', phaseCues: { ...C25K_CUES },
    segments: makeSegments([run(30 * M)]) },
];

const BUILTIN_PRESETS = [
  { id: 'boxing',    name: 'Boxing',    description: '3 min rounds · 1 min rest · 12 rounds',
    type: 'interval', isPreset: true, group: 'preset',
    warmupDuration: 5 * M, workDuration: 3 * M, restDuration: M, rounds: 12, cooldownDuration: M,
    phaseCues: { warmup: 'Shadow box to warm up.', work: 'Hands up. Begin!', rest: 'Rest.', cooldown: 'Cool down.' } },

  { id: 'jumprope',  name: 'Jump Rope', description: '2 min work · 30s rest · 10 rounds',
    type: 'interval', isPreset: true, group: 'preset',
    warmupDuration: 3 * M, workDuration: 2 * M, restDuration: 30, rounds: 10, cooldownDuration: M,
    phaseCues: { warmup: 'Get your rope ready.', work: 'Jump!', rest: 'Rest.', cooldown: 'Good work. Cool down.' } },

  { id: 'hiit',      name: 'HIIT',      description: '40s work · 20s rest · 8 rounds',
    type: 'interval', isPreset: true, group: 'preset',
    warmupDuration: 3 * M, workDuration: 40, restDuration: 20, rounds: 8, cooldownDuration: M,
    phaseCues: { warmup: 'Get ready to work.', work: 'Go hard!', rest: 'Rest.', cooldown: 'Cool down.' } },
];

const ALL_PRESETS = [...BUILTIN_PRESETS, ...C25K_PRESETS];

// ============================================================
// 2. STATE
// ============================================================

let workouts       = [];          // custom workouts from storage/API
let editingWorkout = null;        // workout being configured/edited
let activeWorkout  = null;        // workout currently running
let activeSegments = [];          // flat segment array built from activeWorkout
let segmentIndex   = 0;           // which segment is current
let segmentDuration = 0;          // total duration of current segment (for progress)
let secondsLeft    = 0;           // countdown for current segment
let timerInterval  = null;        // setInterval reference
let isPaused       = false;
let workoutStartTime = 0;         // Date.now() when workout started (for elapsed time)
let totalElapsedSeconds = 0;      // accumulated across pauses

let settings = {
  theme:  'venom',
  mode:   'system',
  apiUrl: '',
  apiKey: '',
};

// ============================================================
// 3. STORAGE & API
// ============================================================

function loadSettings() {
  try {
    const saved = localStorage.getItem('pacer_settings');
    if (saved) Object.assign(settings, JSON.parse(saved));
  } catch (e) { /* ignore */ }
}

function saveSettings() {
  localStorage.setItem('pacer_settings', JSON.stringify(settings));
}

/** Load custom workouts from localStorage */
function loadLocalWorkouts() {
  try {
    const saved = localStorage.getItem('pacer_workouts');
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

/** Save custom workouts to localStorage */
function saveLocalWorkouts() {
  localStorage.setItem('pacer_workouts', JSON.stringify(workouts));
}

/** Make an authenticated API request */
async function apiRequest(method, path, body = null) {
  if (!settings.apiUrl || !settings.apiKey) throw new Error('API not configured');
  const url = settings.apiUrl.replace(/\/$/, '') + path;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': settings.apiKey,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/** Sync: fetch workouts from API, merge with any that aren't there yet */
async function syncWorkouts() {
  if (!settings.apiUrl || !settings.apiKey) return;
  setSyncStatus('Syncing…');
  try {
    const data = await apiRequest('GET', '/workouts');
    workouts = data.workouts || data; // accept {workouts:[]} or []
    saveLocalWorkouts();
    setSyncStatus('Synced', 'ok');
    renderWorkoutList();
  } catch (e) {
    setSyncStatus('Offline — using local data', 'error');
  }
}

async function persistWorkout(workout) {
  // Always save locally first
  const idx = workouts.findIndex(w => w.id === workout.id);
  if (idx >= 0) workouts[idx] = workout;
  else workouts.unshift(workout);
  saveLocalWorkouts();
  renderWorkoutList();

  // Then try API
  try {
    await apiRequest('PUT', `/workouts/${workout.id}`, workout);
  } catch (e) { /* offline — local save is enough */ }
}

async function deleteWorkout(id) {
  workouts = workouts.filter(w => w.id !== id);
  saveLocalWorkouts();
  renderWorkoutList();
  try {
    await apiRequest('DELETE', `/workouts/${id}`);
  } catch (e) { /* offline */ }
}

function setSyncStatus(msg, cls = '') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
  if (cls === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'sync-status'; }, 3000);
}

// ============================================================
// 4. WORKOUT UTILITIES
// ============================================================

function generateId() {
  return 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatTime(sec) {
  const m = Math.floor(Math.abs(sec) / 60).toString().padStart(2, '0');
  const s = (Math.abs(sec) % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function workoutMeta(w) {
  if (w.type === 'sequence') {
    const total = w.segments.reduce((a, s) => a + s.duration, 0);
    return formatTime(total) + ' total';
  }
  const total = (w.warmupDuration || 0) + w.rounds * (w.workDuration + w.restDuration) - w.restDuration + (w.cooldownDuration || 0);
  return `${w.rounds} rounds · ${formatTime(total)}`;
}

/**
 * Convert a workout config into a flat array of timed segments.
 * Each segment gets roundIndex (for work phases) and totalRounds.
 */
function buildSegments(workout) {
  if (workout.type === 'sequence') {
    let workCount = 0;
    const totalWork = workout.segments.filter(s => s.phase === 'work').length;
    return workout.segments.map(seg => ({
      ...seg,
      roundIndex: seg.phase === 'work' ? workCount++ : null,
      totalRounds: totalWork,
    }));
  }

  // interval type
  const segs = [];
  if (workout.warmupDuration > 0) {
    segs.push({ label: 'Warm-up', duration: workout.warmupDuration, phase: 'warmup', roundIndex: null, totalRounds: workout.rounds });
  }
  for (let i = 0; i < workout.rounds; i++) {
    segs.push({ label: `Round ${i + 1}`, duration: workout.workDuration, phase: 'work', roundIndex: i, totalRounds: workout.rounds });
    if (i < workout.rounds - 1) {
      segs.push({ label: 'Rest', duration: workout.restDuration, phase: 'rest', roundIndex: i, totalRounds: workout.rounds });
    }
  }
  if (workout.cooldownDuration > 0) {
    segs.push({ label: 'Cool-down', duration: workout.cooldownDuration, phase: 'cooldown', roundIndex: null, totalRounds: workout.rounds });
  }
  return segs;
}

// ============================================================
// 5. TIMER ENGINE
// ============================================================

function startTimer(workout) {
  activeWorkout   = workout;
  activeSegments  = buildSegments(workout);
  segmentIndex    = 0;
  isPaused        = false;
  workoutStartTime = Date.now();
  totalElapsedSeconds = 0;

  showScreen('timer');
  document.getElementById('timer-workout-name').textContent = workout.name;
  buildOverallDots();
  startSegment(0);
}

function startSegment(index) {
  const seg = activeSegments[index];
  if (!seg) { completeWorkout(); return; }

  segmentIndex   = index;
  segmentDuration = seg.duration;
  secondsLeft    = seg.duration;

  announcePhaseStart(seg);
  updateTimerDisplay();
  applyPhaseStyle(seg.phase);
  animatePhaseTransition();

  clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);
}

function tick() {
  if (isPaused) return;

  secondsLeft--;
  totalElapsedSeconds++;

  // Countdown warnings
  if (secondsLeft <= 5 && secondsLeft > 0 && segmentDuration > 10) {
    speak(String(secondsLeft));
  }

  // Custom cues
  checkCustomCues(segmentIndex, segmentDuration - secondsLeft);

  // Update display
  updateTimerDisplay();

  // Advance segment
  if (secondsLeft <= 0) {
    segmentIndex++;
    if (segmentIndex >= activeSegments.length) {
      completeWorkout();
    } else {
      startSegment(segmentIndex);
    }
  }
}

function pauseTimer() {
  isPaused = true;
  clearInterval(timerInterval);
  document.getElementById('btn-pause-resume').textContent = 'Resume';
  document.getElementById('timer-clock').classList.add('paused');
}

function resumeTimer() {
  isPaused = false;
  document.getElementById('btn-pause-resume').textContent = 'Pause';
  document.getElementById('timer-clock').classList.remove('paused');
  timerInterval = setInterval(tick, 1000);
}

function restartTimer() {
  clearInterval(timerInterval);
  isPaused = false;
  totalElapsedSeconds = 0;
  workoutStartTime = Date.now();
  document.getElementById('btn-pause-resume').textContent = 'Pause';
  document.getElementById('timer-clock').classList.remove('paused');
  startSegment(0);
}

function endTimer() {
  clearInterval(timerInterval);
  activeWorkout  = null;
  activeSegments = [];
  isPaused       = false;
}

function completeWorkout() {
  clearInterval(timerInterval);
  speak('Workout complete! Great work!');

  const name = activeWorkout ? activeWorkout.name : '';
  document.getElementById('complete-name').textContent = name;
  document.getElementById('complete-time').textContent = 'Total: ' + formatTime(totalElapsedSeconds);

  showScreen('complete');
}

// ============================================================
// 6. SPEECH ENGINE
// ============================================================

const synth = window.speechSynthesis;

function speak(text) {
  if (!synth) return;
  // Cancel anything queued (don't cancel mid-utterance to avoid cutting off phase names)
  // Small delay let the previous utterance finish naturally
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate   = 1.1;
  utterance.pitch  = 1.0;
  utterance.volume = 1.0;
  synth.speak(utterance);
}

function announcePhaseStart(seg) {
  const cues = (activeWorkout && activeWorkout.phaseCues) || {};
  let text = '';
  switch (seg.phase) {
    case 'warmup':
      text = cues.warmup || 'Warm up.';
      break;
    case 'cooldown':
      text = cues.cooldown || 'Cool down.';
      break;
    case 'rest':
      text = cues.rest || 'Rest.';
      break;
    case 'work': {
      const cueText = cues.work || 'Begin!';
      const isSequence = activeWorkout && activeWorkout.type === 'sequence';
      if (isSequence) {
        const num   = seg.roundIndex + 1;
        const total = seg.totalRounds;
        text = total > 1
          ? `${seg.label} ${num} of ${total}. ${cueText}`
          : `${seg.label}. ${cueText}`;
      } else {
        text = `Round ${seg.roundIndex + 1}. ${cueText}`;
      }
      break;
    }
    default:
      text = 'Go!';
  }
  speak(text);
}

function checkCustomCues(segIdx, elapsedSeconds) {
  if (!activeWorkout || !activeWorkout.cues) return;
  const seg = activeSegments[segIdx];

  activeWorkout.cues.forEach(cue => {
    if (cue.phase !== seg.phase) return;
    if (cue.offsetSeconds !== elapsedSeconds) return;

    // Recurring → applies to all rounds; specific → match roundIndex
    if (!cue.recurring && cue.roundIndex !== seg.roundIndex) return;

    speak(cue.text);
  });
}

// ============================================================
// 7. TIMER DISPLAY
// ============================================================

function updateTimerDisplay() {
  const seg = activeSegments[segmentIndex];
  if (!seg) return;

  // Phase label (Round X of Y / Warm-up / etc.)
  let phaseLabel = '';
  if (seg.phase === 'warmup')    phaseLabel = 'WARM-UP';
  else if (seg.phase === 'cooldown') phaseLabel = 'COOL-DOWN';
  else if (seg.phase === 'rest') {
    phaseLabel = 'REST';
    if (seg.totalRounds > 1 && seg.roundIndex != null)
      phaseLabel = `REST · AFTER ROUND ${seg.roundIndex + 1}`;
  } else if (seg.phase === 'work') {
    if (activeWorkout.type === 'sequence') {
      phaseLabel = seg.totalRounds > 1
        ? `${seg.label.toUpperCase()} · ${seg.roundIndex + 1} OF ${seg.totalRounds}`
        : seg.label.toUpperCase();
    } else {
      phaseLabel = `ROUND ${seg.roundIndex + 1} OF ${seg.totalRounds}`;
    }
  }

  document.getElementById('timer-phase-label').textContent = phaseLabel;
  document.getElementById('timer-clock').textContent = formatTime(secondsLeft);

  // Phase pill
  const pill = document.getElementById('timer-phase-pill');
  pill.textContent = { work: 'WORK', rest: 'REST', warmup: 'WARM-UP', cooldown: 'COOL-DOWN' }[seg.phase] || '';
  pill.className   = `timer-phase-pill phase-${seg.phase}`;

  // Progress bar (current segment)
  const elapsed = seg.duration - secondsLeft;
  const pct     = seg.duration > 0 ? (elapsed / seg.duration) * 100 : 100;
  document.getElementById('timer-progress-fill').style.width = `${pct}%`;

  // Overall dots
  const dots = document.querySelectorAll('.overall-dot');
  dots.forEach((dot, i) => {
    dot.classList.remove('done', 'active');
    if (i < segmentIndex)      dot.classList.add('done');
    else if (i === segmentIndex) dot.classList.add('active');
  });

  // Next segment
  const next = activeSegments[segmentIndex + 1];
  const nextEl = document.getElementById('timer-next');
  if (next) {
    const nextName = next.phase === 'rest' ? 'Rest' :
                     next.phase === 'work' ? (next.label || 'Work') :
                     next.phase === 'cooldown' ? 'Cool-down' : next.label;
    nextEl.textContent = `Next: ${nextName} · ${formatTime(next.duration)}`;
  } else {
    nextEl.textContent = 'Final segment';
  }
}

function applyPhaseStyle(phase) {
  document.getElementById('timer-progress-fill').className =
    `timer-progress-fill phase-${phase}`;
}

function buildOverallDots() {
  const container = document.getElementById('timer-overall-progress');
  container.innerHTML = '';
  const max = Math.min(activeSegments.length, 40); // cap at 40 dots to avoid clutter
  for (let i = 0; i < max; i++) {
    const dot = document.createElement('div');
    dot.className = 'overall-dot';
    container.appendChild(dot);
  }
}

function animatePhaseTransition() {
  const body = document.querySelector('.timer-body');
  body.classList.remove('phase-transition');
  void body.offsetWidth; // reflow to re-trigger animation
  body.classList.add('phase-transition');
}

// ============================================================
// 8. NAVIGATION
// ============================================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + id);
  if (target) target.classList.add('active');
}

// ============================================================
// 9. HOME SCREEN
// ============================================================

function renderWorkoutList() {
  const container = document.getElementById('workout-list');
  container.innerHTML = '';

  // --- Preset section ---
  const presetSection = document.createElement('div');
  presetSection.innerHTML = `<div class="workout-group-title">Workouts</div>`;
  const presetBody = document.createElement('div');
  presetBody.className = 'workout-group-body';
  BUILTIN_PRESETS.forEach(w => presetBody.appendChild(makeWorkoutCard(w)));
  presetSection.appendChild(presetBody);
  container.appendChild(presetSection);

  // --- C25K collapsible section ---
  const c25kSection = document.createElement('div');
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'group-toggle';
  toggleBtn.innerHTML = `<span class="group-toggle-label">Couch to 5K Program</span><span class="group-chevron">▼</span>`;
  const c25kBody = document.createElement('div');
  c25kBody.className = 'collapsible-group workout-group-body';
  C25K_PRESETS.forEach(w => c25kBody.appendChild(makeWorkoutCard(w)));
  toggleBtn.addEventListener('click', () => {
    toggleBtn.classList.toggle('collapsed');
    c25kBody.classList.toggle('collapsed');
  });
  c25kSection.appendChild(toggleBtn);
  c25kSection.appendChild(c25kBody);
  container.appendChild(c25kSection);

  // --- Custom workouts ---
  if (workouts.length > 0) {
    const customSection = document.createElement('div');
    customSection.innerHTML = `<div class="workout-group-title">My Workouts</div>`;
    const customBody = document.createElement('div');
    customBody.className = 'workout-group-body';
    workouts.forEach(w => customBody.appendChild(makeWorkoutCard(w)));
    customSection.appendChild(customBody);
    container.appendChild(customSection);
  }
}

function makeWorkoutCard(workout) {
  const btn = document.createElement('button');
  btn.className = 'workout-card';
  btn.innerHTML = `
    <div class="workout-card-info">
      <div class="workout-card-name">${escHtml(workout.name)}</div>
      <div class="workout-card-meta">${escHtml(workout.description || workoutMeta(workout))}</div>
    </div>
    <div class="workout-card-arrow">›</div>
  `;
  btn.addEventListener('click', () => showConfig(workout));
  return btn;
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ============================================================
// 10. CONFIG SCREEN
// ============================================================

function showConfig(workout) {
  // Deep-copy so edits don't mutate the original preset
  editingWorkout = JSON.parse(JSON.stringify(workout));
  editingWorkout.cues = editingWorkout.cues || [];

  document.getElementById('config-title').textContent = workout.name;

  // Show delete button only for custom workouts
  const deleteBtn = document.getElementById('btn-delete-workout');
  deleteBtn.style.visibility = workout.isPreset ? 'hidden' : 'visible';

  renderConfig();
  showScreen('config');
}

function renderConfig() {
  const w = editingWorkout;
  const container = document.getElementById('config-content');
  container.innerHTML = '';
  const pc = w.phaseCues || {};

  // Shared phase cue fields HTML
  const cueFields = `
    <div class="form-section-title" style="margin-top:16px">Phase Announcements</div>
    <div class="form-group">
      <label class="form-label">Warm-up cue</label>
      <input type="text" class="form-input" id="cfg-cue-warmup" value="${escHtml(pc.warmup || 'Warm up.')}">
    </div>
    <div class="form-group">
      <label class="form-label">Work / jog cue</label>
      <input type="text" class="form-input" id="cfg-cue-work" value="${escHtml(pc.work || 'Begin!')}">
    </div>
    <div class="form-group">
      <label class="form-label">Rest / walk cue</label>
      <input type="text" class="form-input" id="cfg-cue-rest" value="${escHtml(pc.rest || 'Rest.')}">
    </div>
    <div class="form-group">
      <label class="form-label">Cool-down cue</label>
      <input type="text" class="form-input" id="cfg-cue-cooldown" value="${escHtml(pc.cooldown || 'Cool down.')}">
    </div>`;

  if (w.type === 'sequence') {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="form-section-title">Session Plan</div>
      <ul class="segment-list">
        ${w.segments.map(s => `
          <li class="segment-item">
            <span class="segment-dot phase-${s.phase}"></span>
            <span class="segment-label">${escHtml(s.label)}</span>
            <span class="segment-duration">${formatTime(s.duration)}</span>
          </li>`).join('')}
      </ul>
      ${cueFields}`;
    container.appendChild(card);

  } else {
    const card = document.createElement('div');
    card.className = 'card';

    const nameField = w.isPreset ? '' : `
      <div class="form-group">
        <label class="form-label">Workout Name</label>
        <input type="text" class="form-input" id="cfg-name" value="${escHtml(w.name)}">
      </div>`;

    card.innerHTML = `
      <div class="form-section-title">Settings</div>
      ${nameField}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Warm-up (sec)</label>
          <input type="number" class="form-input" id="cfg-warmup" value="${w.warmupDuration}" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Rounds</label>
          <input type="number" class="form-input" id="cfg-rounds" value="${w.rounds}" min="1" max="99">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Work (sec)</label>
          <input type="number" class="form-input" id="cfg-work" value="${w.workDuration}" min="5">
        </div>
        <div class="form-group">
          <label class="form-label">Rest (sec)</label>
          <input type="number" class="form-input" id="cfg-rest" value="${w.restDuration}" min="0">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Cool-down (sec)</label>
        <input type="number" class="form-input" id="cfg-cooldown" value="${w.cooldownDuration}" min="0">
      </div>
      ${cueFields}`;
    container.appendChild(card);
  }

  // Cue summary
  const cueCount = w.cues ? w.cues.length : 0;
  const cueCard = document.createElement('div');
  cueCard.className = 'card';
  cueCard.innerHTML = `
    <div class="form-section-title">Custom Cues</div>
    <p style="font-size:14px;color:var(--text-muted)">
      ${cueCount === 0 ? 'No custom cues added yet.' : `${cueCount} cue${cueCount > 1 ? 's' : ''} configured.`}
    </p>`;
  container.appendChild(cueCard);
}

function buildWorkoutFromConfig() {
  const w = editingWorkout;
  if (w.type === 'interval') {
    const nameEl = document.getElementById('cfg-name');
    if (nameEl) w.name = nameEl.value.trim() || w.name;
    w.warmupDuration  = parseInt(document.getElementById('cfg-warmup').value)   || 0;
    w.rounds          = parseInt(document.getElementById('cfg-rounds').value)    || 1;
    w.workDuration    = parseInt(document.getElementById('cfg-work').value)      || 30;
    w.restDuration    = parseInt(document.getElementById('cfg-rest').value)      || 0;
    w.cooldownDuration= parseInt(document.getElementById('cfg-cooldown').value)  || 0;
  }
  // Read phase cues for both interval and sequence workouts
  w.phaseCues = {
    warmup:   document.getElementById('cfg-cue-warmup').value.trim()   || 'Warm up.',
    work:     document.getElementById('cfg-cue-work').value.trim()     || 'Begin!',
    rest:     document.getElementById('cfg-cue-rest').value.trim()     || 'Rest.',
    cooldown: document.getElementById('cfg-cue-cooldown').value.trim() || 'Cool down.',
  };
  return w;
}

// ============================================================
// 11. CUES EDITOR
// ============================================================

function showCueEditor() {
  renderCues();
  showScreen('cues');
}

function renderCues() {
  const container = document.getElementById('cue-list');
  const cues = editingWorkout.cues || [];
  container.innerHTML = '';

  if (cues.length === 0) {
    container.innerHTML = '<div class="cue-empty">No cues yet. Add one below.</div>';
    return;
  }

  cues.forEach((cue, idx) => {
    const item = document.createElement('div');
    item.className = 'cue-item';
    const recurringText = cue.recurring
      ? 'All rounds'
      : `Round ${(cue.roundIndex || 0) + 1} only`;
    item.innerHTML = `
      <div class="cue-item-info">
        <div class="cue-item-text">${escHtml(cue.text)}</div>
        <div class="cue-item-meta">
          <span class="cue-phase-tag phase-${cue.phase}">${cue.phase}</span>
          · at ${cue.offsetSeconds}s · ${recurringText}
        </div>
      </div>
      <button class="cue-delete-btn" data-idx="${idx}" aria-label="Delete cue">×</button>`;
    container.appendChild(item);
  });

  container.querySelectorAll('.cue-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      editingWorkout.cues.splice(i, 1);
      renderCues();
    });
  });
}

// ============================================================
// 12. SETTINGS UI
// ============================================================

function loadSettingsUI() {
  document.getElementById('settings-api-url').value = settings.apiUrl || '';
  document.getElementById('settings-api-key').value = settings.apiKey || '';
  updateModeButtons(settings.mode);
  updateThemeButtons(settings.theme);
}

function saveSettingsFromUI() {
  settings.apiUrl = document.getElementById('settings-api-url').value.trim();
  settings.apiKey = document.getElementById('settings-api-key').value.trim();
  saveSettings();
  syncWorkouts();
}

function updateModeButtons(mode) {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

function updateThemeButtons(theme) {
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function applyTheme(theme) {
  settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeButtons(theme);
  saveSettings();
}

function applyMode(mode) {
  settings.mode = mode;
  document.documentElement.setAttribute('data-mode', mode);
  updateModeButtons(mode);
  saveSettings();
}

async function testApiConnection() {
  const url = document.getElementById('settings-api-url').value.trim();
  const key = document.getElementById('settings-api-key').value.trim();
  const statusEl = document.getElementById('api-status');
  statusEl.textContent = 'Testing…';
  statusEl.className = 'api-status';
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/ping', {
      headers: { 'X-API-Key': key },
    });
    if (res.ok) {
      statusEl.textContent = '✓ Connected';
      statusEl.className = 'api-status ok';
    } else {
      throw new Error(res.status);
    }
  } catch (e) {
    statusEl.textContent = `✗ Failed — check URL and key (${e.message})`;
    statusEl.className = 'api-status error';
  }
}

// ============================================================
// 13. NEW CUSTOM WORKOUT
// ============================================================

function showNewWorkout() {
  editingWorkout = {
    id:               generateId(),
    name:             'My Workout',
    type:             'interval',
    isPreset:         false,
    group:            'custom',
    description:      '',
    warmupDuration:   3 * M,
    workDuration:     40,
    restDuration:     20,
    rounds:           8,
    cooldownDuration: M,
    phaseCues:        { warmup: 'Warm up.', work: 'Begin!', rest: 'Rest.', cooldown: 'Cool down.' },
    cues:             [],
  };
  document.getElementById('config-title').textContent = 'New Workout';
  document.getElementById('btn-delete-workout').style.visibility = 'hidden';
  renderConfig();
  showScreen('config');
}

// ============================================================
// 14. EVENT LISTENERS
// ============================================================

// Home
document.getElementById('btn-settings').addEventListener('click', () => {
  loadSettingsUI();
  showScreen('settings');
});
document.getElementById('btn-new-workout').addEventListener('click', showNewWorkout);

// Config
document.getElementById('btn-config-back').addEventListener('click', () => showScreen('home'));

document.getElementById('btn-delete-workout').addEventListener('click', async () => {
  if (!editingWorkout) return;
  if (confirm(`Delete "${editingWorkout.name}"?`)) {
    await deleteWorkout(editingWorkout.id);
    showScreen('home');
  }
});

document.getElementById('btn-manage-cues').addEventListener('click', () => {
  buildWorkoutFromConfig(); // capture any edits first
  showCueEditor();
});

document.getElementById('btn-start-workout').addEventListener('click', () => {
  const workout = buildWorkoutFromConfig();
  // Save custom workouts before starting
  if (!workout.isPreset) persistWorkout(workout);
  startTimer(workout);
});

// Timer
document.getElementById('btn-end-workout').addEventListener('click', () => {
  if (confirm('End this workout?')) {
    endTimer();
    showScreen('home');
  }
});

document.getElementById('btn-pause-resume').addEventListener('click', () => {
  if (isPaused) resumeTimer();
  else pauseTimer();
});

document.getElementById('btn-restart').addEventListener('click', () => {
  if (confirm('Restart from the beginning?')) restartTimer();
});

// Complete
document.getElementById('btn-complete-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-do-again').addEventListener('click', () => {
  if (activeWorkout) startTimer(activeWorkout);
  else showScreen('home');
});

// Cues
document.getElementById('btn-cues-back').addEventListener('click', () => {
  showConfig(editingWorkout); // go back to config with edits intact
  showScreen('config');
});

document.getElementById('cue-recurring').addEventListener('change', function () {
  const roundGroup = document.getElementById('cue-round-group');
  roundGroup.style.display = this.value === 'specific' ? 'block' : 'none';
});

document.getElementById('btn-save-cue').addEventListener('click', () => {
  const text = document.getElementById('cue-text').value.trim();
  if (!text) { alert('Please enter a cue message.'); return; }

  const phase    = document.getElementById('cue-phase').value;
  const offset   = parseInt(document.getElementById('cue-offset').value) || 0;
  const recurring = document.getElementById('cue-recurring').value === 'all';
  const roundIdx = recurring ? null : (parseInt(document.getElementById('cue-round-index').value) - 1 || 0);

  editingWorkout.cues = editingWorkout.cues || [];
  editingWorkout.cues.push({ text, phase, offsetSeconds: offset, recurring, roundIndex: roundIdx });

  // Clear form
  document.getElementById('cue-text').value = '';
  document.getElementById('cue-offset').value = '0';

  renderCues();
});

// Settings
document.getElementById('btn-settings-back').addEventListener('click', () => showScreen('home'));

document.getElementById('btn-save-settings').addEventListener('click', () => {
  saveSettingsFromUI();
  showScreen('home');
});

document.getElementById('btn-test-api').addEventListener('click', testApiConnection);

document.getElementById('mode-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (btn) applyMode(btn.dataset.mode);
});

document.getElementById('theme-grid').addEventListener('click', e => {
  const btn = e.target.closest('.theme-swatch');
  if (btn) applyTheme(btn.dataset.theme);
});

// ============================================================
// 15. INIT
// ============================================================

function init() {
  loadSettings();
  applyTheme(settings.theme);
  applyMode(settings.mode);

  // Load local workouts immediately, then try to sync
  workouts = loadLocalWorkouts();
  renderWorkoutList();

  // Attempt API sync in background
  syncWorkouts();

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
