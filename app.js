/* ============================================================
   PACER — app.js  v2
   Guided rhythm for any workflow.
   ============================================================ */

'use strict';

// ============================================================
// 1. CONSTANTS
// ============================================================

const STEP_COLORS = {
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

const DEFAULT_COLOR = 'blue';
const DEFAULT_STEP_DURATION = 60; // seconds

// ============================================================
// 2. TEMPLATE LIBRARY
// ============================================================

function makeStep(name, duration, color = DEFAULT_COLOR, cueOverride = null) {
  return {
    type: 'step',
    id: genId(),
    name,
    duration,
    color,
    voiceCues: [{ id: genId(), offsetSeconds: 0, text: cueOverride ?? name }],
  };
}

function makeGroup(name, repeats, steps) {
  return { type: 'group', id: genId(), name, repeats, steps };
}

const M = 60;

const TEMPLATES = [
  {
    category: 'Fitness',
    items: [
      {
        id: 'tpl-boxing',
        name: 'Boxing',
        description: '3 min rounds · 1 min rest · 12 rounds',
        items: [
          makeStep('Warm Up', 5 * M, 'yellow'),
          makeGroup('Round', 12, [
            makeStep('Round', 3 * M, 'red', 'Begin!'),
            makeStep('Rest', M, 'blue', 'Rest.'),
          ]),
          makeStep('Cool Down', M, 'teal'),
        ],
      },
      {
        id: 'tpl-jumprope',
        name: 'Jump Rope',
        description: '2 min work · 30s rest · 10 rounds',
        items: [
          makeStep('Warm Up', 3 * M, 'yellow'),
          makeGroup('Round', 10, [
            makeStep('Jump', 2 * M, 'red', 'Jump!'),
            makeStep('Rest', 30, 'blue', 'Rest.'),
          ]),
          makeStep('Cool Down', M, 'teal'),
        ],
      },
      {
        id: 'tpl-hiit',
        name: 'HIIT',
        description: '40s work · 20s rest · 8 rounds',
        items: [
          makeStep('Warm Up', 3 * M, 'yellow'),
          makeGroup('Round', 8, [
            makeStep('Work', 40, 'red', 'Go!'),
            makeStep('Rest', 20, 'blue', 'Rest.'),
          ]),
          makeStep('Cool Down', M, 'teal'),
        ],
      },
      {
        id: 'tpl-c25k-w1',
        name: 'C25K — Week 1',
        description: 'Jog 60s / Walk 90s × 8',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeGroup('Interval', 8, [
            makeStep('Jog', 60, 'red', 'Begin jogging.'),
            makeStep('Walk', 90, 'blue', 'Walk it out.'),
          ]),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w2',
        name: 'C25K — Week 2',
        description: 'Jog 90s / Walk 2min × 6',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeGroup('Interval', 6, [
            makeStep('Jog', 90, 'red', 'Begin jogging.'),
            makeStep('Walk', 2 * M, 'blue', 'Walk it out.'),
          ]),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w3',
        name: 'C25K — Week 3',
        description: '90s / 90s / 3min / 3min × 2',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeGroup('Interval', 2, [
            makeStep('Jog', 90, 'red', 'Begin jogging.'),
            makeStep('Walk', 90, 'blue', 'Walk it out.'),
            makeStep('Jog', 3 * M, 'red', 'Keep going.'),
            makeStep('Walk', 3 * M, 'blue', 'Walk it out.'),
          ]),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w4',
        name: 'C25K — Week 4',
        description: '3min / 90s / 5min / 2.5min × 2',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeGroup('Interval', 2, [
            makeStep('Jog', 3 * M, 'red', 'Begin jogging.'),
            makeStep('Walk', 90, 'blue', 'Walk it out.'),
            makeStep('Jog', 5 * M, 'red', 'Keep going.'),
            makeStep('Walk', 150, 'blue', 'Walk it out.'),
          ]),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w5r1',
        name: 'C25K — Week 5, Run 1',
        description: '5min jog × 3 with 3min walks',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeGroup('Interval', 3, [
            makeStep('Jog', 5 * M, 'red', 'Begin jogging.'),
            makeStep('Walk', 3 * M, 'blue', 'Walk it out.'),
          ]),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w5r2',
        name: 'C25K — Week 5, Run 2',
        description: '8min jog / 5min walk / 8min jog',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeStep('Jog', 8 * M, 'red', 'Begin jogging.'),
          makeStep('Walk', 5 * M, 'blue', 'Walk it out.'),
          makeStep('Jog', 8 * M, 'red', 'Keep going. Final stretch.'),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w5r3',
        name: 'C25K — Week 5, Run 3',
        description: '20 minutes continuous',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeStep('Run', 20 * M, 'red', 'Begin running. You have got this.'),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Excellent work.'),
        ],
      },
      {
        id: 'tpl-c25k-w6r1',
        name: 'C25K — Week 6, Run 1',
        description: '5min / 3min / 8min / 3min / 5min',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeStep('Jog', 5 * M, 'red', 'Begin jogging.'),
          makeStep('Walk', 3 * M, 'blue', 'Walk it out.'),
          makeStep('Jog', 8 * M, 'red', 'Keep going.'),
          makeStep('Walk', 3 * M, 'blue', 'Walk it out.'),
          makeStep('Jog', 5 * M, 'red', 'Final stretch.'),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w6r2',
        name: 'C25K — Week 6, Run 2',
        description: '10min jog / 3min walk / 10min jog',
        items: [
          makeStep('Warm Up Walk', 5 * M, 'yellow', 'Start your warm up walk.'),
          makeStep('Jog', 10 * M, 'red', 'Begin jogging.'),
          makeStep('Walk', 3 * M, 'blue', 'Walk it out.'),
          makeStep('Jog', 10 * M, 'red', 'Final stretch.'),
          makeStep('Cool Down Walk', 5 * M, 'teal', 'Cool down. Great work.'),
        ],
      },
      {
        id: 'tpl-c25k-w6r3', name: 'C25K — Week 6, Run 3', description: '22 minutes continuous',
        items: [makeStep('Warm Up Walk', 5*M,'yellow','Start your warm up walk.'), makeStep('Run',22*M,'red','Begin running.'), makeStep('Cool Down Walk',5*M,'teal','Cool down.')],
      },
      {
        id: 'tpl-c25k-w7', name: 'C25K — Week 7', description: '25 minutes continuous',
        items: [makeStep('Warm Up Walk',5*M,'yellow','Start your warm up walk.'), makeStep('Run',25*M,'red','Begin running.'), makeStep('Cool Down Walk',5*M,'teal','Cool down.')],
      },
      {
        id: 'tpl-c25k-w8', name: 'C25K — Week 8', description: '28 minutes continuous',
        items: [makeStep('Warm Up Walk',5*M,'yellow','Start your warm up walk.'), makeStep('Run',28*M,'red','Begin running.'), makeStep('Cool Down Walk',5*M,'teal','Cool down.')],
      },
      {
        id: 'tpl-c25k-w9', name: 'C25K — Week 9', description: '30 minutes — you made it!',
        items: [makeStep('Warm Up Walk',5*M,'yellow','Start your warm up walk.'), makeStep('Run',30*M,'red','Begin running. This is it.'), makeStep('Cool Down Walk',5*M,'teal','Cool down. You did it!')],
      },
    ],
  },
  {
    category: 'Focus & Productivity',
    items: [
      {
        id: 'tpl-pomodoro',
        name: 'Pomodoro',
        description: '25min focus / 5min break × 4',
        items: [
          makeGroup('Pomodoro', 4, [
            makeStep('Focus', 25 * M, 'purple', 'Focus time. Begin.'),
            makeStep('Break', 5 * M, 'green', 'Take a break.'),
          ]),
        ],
      },
      {
        id: 'tpl-deepwork',
        name: 'Deep Work Session',
        description: '90min focus / 20min rest',
        items: [
          makeStep('Deep Work', 90 * M, 'purple', 'Deep work. Begin.'),
          makeStep('Rest', 20 * M, 'green', 'Step away and rest.'),
        ],
      },
    ],
  },
  {
    category: 'Mindfulness',
    items: [
      {
        id: 'tpl-boxbreathing',
        name: 'Box Breathing',
        description: 'Inhale / Hold / Exhale / Hold × 8',
        items: [
          makeGroup('Cycle', 8, [
            makeStep('Inhale', 4, 'teal', 'Inhale slowly.'),
            makeStep('Hold', 4, 'blue', 'Hold.'),
            makeStep('Exhale', 4, 'teal', 'Exhale slowly.'),
            makeStep('Hold', 4, 'blue', 'Hold.'),
          ]),
        ],
      },
      {
        id: 'tpl-meditation',
        name: 'Guided Meditation',
        description: '5min settle / 20min sit / 5min ease out',
        items: [
          makeStep('Settle In', 5 * M, 'teal', 'Find your position and settle in.'),
          makeStep('Sit', 20 * M, 'blue', 'Begin your meditation.'),
          makeStep('Ease Out', 5 * M, 'teal', 'Gently begin to return.'),
        ],
      },
    ],
  },
  {
    category: 'Cooking',
    items: [
      {
        id: 'tpl-softboiledegg',
        name: 'Soft Boiled Egg',
        description: 'Bring to boil, cook, ice bath',
        items: [
          makeStep('Bring to Boil', 8 * M, 'orange', 'Bring water to a rolling boil.'),
          makeStep('Cook', 7 * M, 'red', 'Add eggs. Timer started.'),
          makeStep('Ice Bath', 5 * M, 'blue', 'Transfer to ice bath.'),
        ],
      },
      {
        id: 'tpl-frenchpress',
        name: 'French Press Coffee',
        description: 'Bloom, brew, press',
        items: [
          makeStep('Bloom', 30, 'yellow', 'Add a little water. Let it bloom.'),
          makeStep('Brew', 3 * M + 30, 'orange', 'Fill the press. Brewing now.'),
          makeStep('Press & Pour', 30, 'red', 'Press slowly and pour.'),
        ],
      },
    ],
  },
];

// ============================================================
// 3. STATE
// ============================================================

let paces         = [];
let editingPace   = null;
let activePace    = null;
let flatSegments  = [];   // flattened steps for timer
let segmentIndex  = 0;
let secondsLeft   = 0;
let segmentDuration = 0;
let timerInterval = null;
let isPaused      = false;
let totalElapsedSeconds = 0;

let settings = {
  theme: 'venom', mode: 'system', apiUrl: '', apiKey: '', voiceName: '',
};

// ============================================================
// 4. UTILITIES
// ============================================================

function genId() {
  return '_' + Math.random().toString(36).slice(2, 9);
}

function formatTime(sec) {
  const s = Math.abs(Math.round(sec));
  return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
}

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function colorHex(colorKey) {
  return STEP_COLORS[colorKey] || STEP_COLORS[DEFAULT_COLOR];
}

function makeBlankStep() {
  return makeStep('Step', DEFAULT_STEP_DURATION, DEFAULT_COLOR);
}

function makeBlankGroup() {
  return makeGroup('Group', 3, [makeBlankStep(), makeBlankStep()]);
}

function paceMeta(pace) {
  const total = flattenItems(pace.items).reduce((a, s) => a + s.duration, 0);
  const stepCount = flattenItems(pace.items).length;
  return `${stepCount} step${stepCount !== 1 ? 's' : ''} · ${formatTime(total)}`;
}

function paceColorDots(pace) {
  const steps = flattenItems(pace.items).slice(0, 5);
  return steps.map(s => `<span class="pace-card-dot" style="background:${colorHex(s.color)}"></span>`).join('');
}

/** Flatten items (steps + groups) into a sequential list of steps for the timer */
function flattenItems(items) {
  const result = [];
  for (const item of items) {
    if (item.type === 'step') {
      result.push(item);
    } else if (item.type === 'group') {
      for (let r = 0; r < (item.repeats || 1); r++) {
        for (const step of item.steps) {
          result.push({ ...step, _groupName: item.name, _repeat: r + 1, _totalRepeats: item.repeats });
        }
      }
    }
  }
  return result;
}

// ============================================================
// 5. STORAGE & SYNC
// ============================================================

function loadSettings() {
  try { const s = localStorage.getItem('pacer_settings'); if (s) Object.assign(settings, JSON.parse(s)); } catch(e){}
}
function saveSettings() { localStorage.setItem('pacer_settings', JSON.stringify(settings)); }

function loadLocalPaces() {
  try { const s = localStorage.getItem('pacer_paces'); return s ? JSON.parse(s) : []; } catch(e){ return []; }
}
function saveLocalPaces() { localStorage.setItem('pacer_paces', JSON.stringify(paces)); }

async function apiRequest(method, path, body = null) {
  if (!settings.apiUrl || !settings.apiKey) throw new Error('API not configured');
  const url = settings.apiUrl.replace(/\/$/, '') + path;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': settings.apiKey } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function syncPaces() {
  if (!settings.apiUrl || !settings.apiKey) return;
  setSyncStatus('Syncing…');
  try {
    const data = await apiRequest('GET', '/workouts');
    paces = data.workouts || data;
    saveLocalPaces();
    setSyncStatus('Synced', 'ok');
    renderPaceList();
  } catch(e) { setSyncStatus('Offline — using local data', 'error'); }
}

async function persistPace(pace) {
  const idx = paces.findIndex(p => p.id === pace.id);
  if (idx >= 0) paces[idx] = pace; else paces.unshift(pace);
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('PUT', `/workouts/${pace.id}`, pace); } catch(e){}
}

async function deletePace(id) {
  paces = paces.filter(p => p.id !== id);
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('DELETE', `/workouts/${id}`); } catch(e){}
}

function setSyncStatus(msg, cls = '') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
  if (cls === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'sync-status'; }, 3000);
}

// ============================================================
// 6. NAVIGATION
// ============================================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id)?.classList.add('active');
}

// ============================================================
// 7. HOME SCREEN
// ============================================================

function renderPaceList() {
  const container = document.getElementById('pace-list');
  if (!paces.length) {
    container.innerHTML = `<div class="pace-empty">
      <div class="pace-empty-title">No paces yet</div>
      Tap <strong>+ New Pace</strong> to build your first guided rhythm.
    </div>`;
    return;
  }
  container.innerHTML = `<div class="pace-group-title">My Paces</div>
    <div class="pace-group-body" id="pace-group-body"></div>`;
  const body = document.getElementById('pace-group-body');
  paces.forEach(pace => body.appendChild(makePaceCard(pace)));
}

function makePaceCard(pace) {
  const btn = document.createElement('button');
  btn.className = 'pace-card';
  btn.innerHTML = `
    <div class="pace-card-dots">${paceColorDots(pace)}</div>
    <div class="pace-card-info">
      <div class="pace-card-name">${escHtml(pace.name || 'Untitled Pace')}</div>
      <div class="pace-card-meta">${paceMeta(pace)}</div>
    </div>
    <div class="pace-card-arrow">›</div>`;
  btn.addEventListener('click', () => openBuilder(pace));
  return btn;
}

// ============================================================
// 8. TEMPLATE PICKER
// ============================================================

function showTemplatePicker() {
  const container = document.getElementById('template-list');
  container.innerHTML = '';
  TEMPLATES.forEach(cat => {
    const section = document.createElement('div');
    section.className = 'template-category';
    section.innerHTML = `<div class="template-category-title">${escHtml(cat.category)}</div>
      <div class="template-cards"></div>`;
    const cards = section.querySelector('.template-cards');
    cat.items.forEach(tpl => {
      const btn = document.createElement('button');
      btn.className = 'template-card';
      const dots = tpl.items ? flattenItems(tpl.items).slice(0,4).map(s =>
        `<span class="template-card-dot" style="background:${colorHex(s.color)}"></span>`).join('') : '';
      btn.innerHTML = `
        <div class="template-card-dots">${dots}</div>
        <div class="template-card-info">
          <div class="template-card-name">${escHtml(tpl.name)}</div>
          <div class="template-card-desc">${escHtml(tpl.description || '')}</div>
        </div>
        <span class="template-card-arrow">›</span>`;
      btn.addEventListener('click', () => openBuilderFromTemplate(tpl));
      cards.appendChild(btn);
    });
    container.appendChild(section);
  });
  showScreen('templates');
}

function openBuilderFromTemplate(tpl) {
  // Deep clone the template items so edits don't mutate originals
  const pace = {
    id: genId(),
    name: tpl.name,
    items: JSON.parse(JSON.stringify(tpl.items)),
    isNew: true,
  };
  // Re-generate IDs so each pace is independent
  regenIds(pace.items);
  openBuilder(pace);
}

function regenIds(items) {
  items.forEach(item => {
    item.id = genId();
    if (item.type === 'group') regenIds(item.steps);
    if (item.voiceCues) item.voiceCues.forEach(c => c.id = genId());
  });
}

// ============================================================
// 9. BUILDER
// ============================================================

function openBuilder(pace) {
  editingPace = JSON.parse(JSON.stringify(pace));
  editingPace.items = editingPace.items || [];
  document.getElementById('builder-pace-name').value = editingPace.name || '';
  const deleteBtn = document.getElementById('btn-delete-pace');
  deleteBtn.style.visibility = editingPace.isNew ? 'hidden' : 'visible';
  renderBuilder();
  showScreen('builder');
}

function openBlankBuilder() {
  editingPace = { id: genId(), name: '', items: [], isNew: true };
  document.getElementById('builder-pace-name').value = '';
  document.getElementById('btn-delete-pace').style.visibility = 'hidden';
  renderBuilder();
  showScreen('builder');
}

function renderBuilder() {
  const container = document.getElementById('builder-content');
  container.innerHTML = '';
  const items = editingPace.items || [];

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'builder-empty';
    empty.innerHTML = 'No steps yet.<br>Tap <strong>+ Step</strong> or <strong>+ Group</strong> below to begin.';
    container.appendChild(empty);
    return;
  }

  items.forEach((item, idx) => {
    if (item.type === 'step') {
      container.appendChild(buildStepCard(item, idx, null));
    } else if (item.type === 'group') {
      container.appendChild(buildGroupCard(item, idx));
    }
  });
}

// ---- Step Card ----

function buildStepCard(step, itemIdx, groupIdx) {
  const inGroup = groupIdx !== null;
  const card = document.createElement('div');
  card.className = inGroup ? 'step-card group-step' : 'step-card';
  card.dataset.id = step.id;

  const mins = Math.floor(step.duration / 60);
  const secs = step.duration % 60;
  const startCue = step.voiceCues?.[0] ?? null;
  const extraCues = (step.voiceCues || []).slice(1);
  const isSilent = !startCue || !startCue.text;

  const extraCuesHtml = extraCues.map((cue, ci) => `
    <div class="extra-cue-row" data-cue-idx="${ci + 1}">
      <input type="number" class="extra-cue-offset" value="${cue.offsetSeconds}" min="0" placeholder="0" aria-label="Offset seconds">
      <span class="extra-cue-label">s —</span>
      <input type="text" class="extra-cue-text" value="${escHtml(cue.text || '')}" placeholder="What to say…">
      <button class="extra-cue-del" aria-label="Remove voice cue">×</button>
    </div>`).join('');

  card.innerHTML = `
    <div class="step-card-main">
      <span class="step-color-dot" style="background:${colorHex(step.color)}" title="Change color"></span>
      <input type="text" class="step-name-input" value="${escHtml(step.name)}" placeholder="Step name…" maxlength="40">
      <div class="step-duration-wrap">
        <input type="number" class="step-time-input" data-part="min" value="${mins}" min="0" max="99" aria-label="Minutes">
        <span class="step-colon">:</span>
        <input type="number" class="step-time-input" data-part="sec" value="${String(secs).padStart(2,'0')}" min="0" max="59" aria-label="Seconds">
      </div>
    </div>
    <div class="step-card-actions">
      <div class="step-voice-cue-row">
        <span class="step-voice-icon ${isSilent ? 'silent' : ''}" title="${isSilent ? 'Silent — tap to add cue' : 'Voice cue — tap to edit'}">🔊</span>
        <input type="text" class="step-voice-input" value="${escHtml(startCue?.text || '')}" placeholder="silent…" maxlength="120">
        <button class="step-voice-clear" title="Clear cue">×</button>
      </div>
      <div class="step-secondary-actions">
        ${!inGroup ? `
          <button class="step-action-btn" data-action="up"  ${itemIdx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="step-action-btn" data-action="down" ${itemIdx === (editingPace.items.length - 1) ? 'disabled' : ''} aria-label="Move down">↓</button>
        ` : `
          <button class="step-action-btn" data-action="up"  ${itemIdx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="step-action-btn" data-action="down" aria-label="Move down">↓</button>
        `}
        <button class="step-action-btn" data-action="dup" aria-label="Duplicate">⊕</button>
        <button class="step-action-btn danger" data-action="del" aria-label="Delete">×</button>
      </div>
    </div>
    ${extraCues.length ? `<div class="step-extra-cues">${extraCuesHtml}</div>` : ''}
    <button class="add-voice-cue-btn">+ Add Voice Cue</button>
    <div class="color-picker hidden">
      ${Object.entries(STEP_COLORS).map(([key, hex]) =>
        `<span class="color-swatch ${step.color === key ? 'selected' : ''}" data-color="${key}" style="background:${hex}" title="${key}"></span>`
      ).join('')}
    </div>`;

  // Wire up events
  const nameInput = card.querySelector('.step-name-input');
  const voiceInput = card.querySelector('.step-voice-input');
  const voiceClear = card.querySelector('.step-voice-clear');
  const voiceIcon  = card.querySelector('.step-voice-icon');
  const colorDot   = card.querySelector('.step-color-dot');
  const colorPicker = card.querySelector('.color-picker');

  nameInput.addEventListener('input', () => { step.name = nameInput.value; });

  // Duration
  card.querySelectorAll('.step-time-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const m = parseInt(card.querySelector('[data-part="min"]').value) || 0;
      const s = Math.min(59, parseInt(card.querySelector('[data-part="sec"]').value) || 0);
      step.duration = m * 60 + s;
    });
  });

  // Start voice cue
  if (!step.voiceCues) step.voiceCues = [];
  if (!step.voiceCues[0]) step.voiceCues[0] = { id: genId(), offsetSeconds: 0, text: step.name };
  voiceInput.addEventListener('input', () => {
    step.voiceCues[0].text = voiceInput.value;
    voiceIcon.classList.toggle('silent', !voiceInput.value.trim());
  });
  voiceClear.addEventListener('click', () => {
    voiceInput.value = '';
    step.voiceCues[0].text = '';
    voiceIcon.classList.add('silent');
  });

  // Color picker
  colorDot.addEventListener('click', () => colorPicker.classList.toggle('hidden'));
  colorPicker.addEventListener('click', e => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    step.color = sw.dataset.color;
    colorDot.style.background = colorHex(step.color);
    colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === step.color));
    colorPicker.classList.add('hidden');
  });

  // Extra cue events
  const extraCuesContainer = card.querySelector('.step-extra-cues');
  if (extraCuesContainer) wireExtraCues(extraCuesContainer, step);

  // Add voice cue
  card.querySelector('.add-voice-cue-btn').addEventListener('click', () => {
    step.voiceCues.push({ id: genId(), offsetSeconds: 30, text: '' });
    // re-render just this card in place
    const parent = card.parentElement;
    const newCard = buildStepCard(step, itemIdx, groupIdx);
    parent.replaceChild(newCard, card);
    newCard.querySelector('.step-extra-cues')?.lastElementChild?.querySelector('.extra-cue-text')?.focus();
  });

  // Action buttons
  card.querySelectorAll('.step-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncBuilderState();
      const action = btn.dataset.action;
      if (inGroup) {
        const group = editingPace.items[groupIdx];
        const steps = group.steps;
        handleStepAction(action, steps, itemIdx);
      } else {
        handleStepAction(action, editingPace.items, itemIdx);
      }
      renderBuilder();
    });
  });

  return card;
}

function wireExtraCues(container, step) {
  container.querySelectorAll('.extra-cue-row').forEach((row, ri) => {
    const actualIdx = ri + 1; // offset by 1 since [0] is start cue
    const offsetInput = row.querySelector('.extra-cue-offset');
    const textInput = row.querySelector('.extra-cue-text');
    const delBtn = row.querySelector('.extra-cue-del');

    offsetInput.addEventListener('change', () => {
      if (step.voiceCues[actualIdx]) step.voiceCues[actualIdx].offsetSeconds = parseInt(offsetInput.value) || 0;
    });
    textInput.addEventListener('input', () => {
      if (step.voiceCues[actualIdx]) step.voiceCues[actualIdx].text = textInput.value;
    });
    delBtn.addEventListener('click', () => {
      step.voiceCues.splice(actualIdx, 1);
      row.remove();
    });
  });
}

function handleStepAction(action, arr, idx) {
  switch(action) {
    case 'up':   if (idx > 0) [arr[idx-1], arr[idx]] = [arr[idx], arr[idx-1]]; break;
    case 'down': if (idx < arr.length-1) [arr[idx], arr[idx+1]] = [arr[idx+1], arr[idx]]; break;
    case 'dup':  arr.splice(idx+1, 0, JSON.parse(JSON.stringify(arr[idx]))); regenIds([arr[idx+1]]); break;
    case 'del':  if (arr.length > 1) arr.splice(idx, 1); break;
  }
}

// ---- Group Card ----

function buildGroupCard(group, groupIdx) {
  const card = document.createElement('div');
  card.className = 'group-card';
  card.dataset.id = group.id;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <input type="text" class="group-name-input" value="${escHtml(group.name)}" placeholder="Group name…" maxlength="40">
    <div class="group-repeats-wrap">
      <input type="number" class="group-repeats-input" value="${group.repeats}" min="1" max="99" aria-label="Repeats">
      <span class="group-repeats-x">×</span>
      <span class="group-repeats-label">repeats</span>
    </div>
    <button class="step-action-btn danger group-del-btn" aria-label="Delete group">×</button>`;
  card.appendChild(header);

  header.querySelector('.group-name-input').addEventListener('input', e => { group.name = e.target.value; });
  header.querySelector('.group-repeats-input').addEventListener('change', e => { group.repeats = parseInt(e.target.value) || 1; });
  header.querySelector('.group-del-btn').addEventListener('click', () => {
    if (confirm(`Remove group "${group.name || 'Group'}"?`)) {
      syncBuilderState();
      editingPace.items.splice(groupIdx, 1);
      renderBuilder();
    }
  });

  const body = document.createElement('div');
  body.className = 'group-body';

  if (!group.steps || group.steps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty';
    empty.textContent = 'No steps. Add one below.';
    body.appendChild(empty);
  } else {
    group.steps.forEach((step, stepIdx) => {
      body.appendChild(buildStepCard(step, stepIdx, groupIdx));
    });
  }
  card.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'group-footer';
  const addBtn = document.createElement('button');
  addBtn.className = 'add-to-group-btn';
  addBtn.textContent = '+ Add Step';
  addBtn.addEventListener('click', () => {
    syncBuilderState();
    group.steps.push(makeBlankStep());
    renderBuilder();
  });
  footer.appendChild(addBtn);
  card.appendChild(footer);

  return card;
}

// ---- Sync state before mutations ----

function syncBuilderState() {
  // Sync name
  editingPace.name = document.getElementById('builder-pace-name').value.trim();

  // Sync step fields by matching IDs
  document.querySelectorAll('.step-card').forEach(card => {
    const id = card.dataset.id;
    const step = findStepById(editingPace.items, id);
    if (!step) return;

    const nameEl = card.querySelector('.step-name-input');
    const minEl  = card.querySelector('[data-part="min"]');
    const secEl  = card.querySelector('[data-part="sec"]');
    const voiceEl = card.querySelector('.step-voice-input');

    if (nameEl) step.name = nameEl.value;
    if (minEl && secEl) step.duration = (parseInt(minEl.value)||0)*60 + Math.min(59, parseInt(secEl.value)||0);
    if (voiceEl && step.voiceCues?.[0]) step.voiceCues[0].text = voiceEl.value;
  });

  // Sync group fields
  document.querySelectorAll('.group-card').forEach(card => {
    const id = card.dataset.id;
    const group = editingPace.items.find(i => i.id === id);
    if (!group) return;
    const nameEl = card.querySelector('.group-name-input');
    const repEl  = card.querySelector('.group-repeats-input');
    if (nameEl) group.name = nameEl.value;
    if (repEl)  group.repeats = parseInt(repEl.value) || 1;
  });
}

function findStepById(items, id) {
  for (const item of items) {
    if (item.type === 'step' && item.id === id) return item;
    if (item.type === 'group') {
      const found = item.steps.find(s => s.id === id);
      if (found) return found;
    }
  }
  return null;
}

function savePaceFromBuilder() {
  syncBuilderState();
  editingPace.name = editingPace.name || 'My Pace';
  editingPace.isNew = false;
  delete editingPace.isNew;
  return editingPace;
}

// ============================================================
// 10. TIMER ENGINE
// ============================================================

function startPace(pace) {
  activePace     = pace;
  flatSegments   = flattenItems(pace.items);
  segmentIndex   = 0;
  isPaused       = false;
  totalElapsedSeconds = 0;

  if (!flatSegments.length) { alert('This pace has no steps.'); return; }

  document.getElementById('timer-pace-name').textContent = pace.name || 'Pacer';
  buildOverallDots();
  showScreen('timer');
  startSegment(0);
}

function startSegment(idx) {
  const seg = flatSegments[idx];
  if (!seg) { completePace(); return; }
  segmentIndex    = idx;
  segmentDuration = seg.duration;
  secondsLeft     = seg.duration;

  speakSegmentStart(seg);
  updateTimerDisplay();
  animatePhaseTransition();

  clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);
}

function tick() {
  if (isPaused) return;
  secondsLeft--;
  totalElapsedSeconds++;

  if (secondsLeft <= 5 && secondsLeft > 0 && segmentDuration > 10) speak(String(secondsLeft));

  checkVoiceCues(segmentIndex, segmentDuration - secondsLeft);
  updateTimerDisplay();

  if (secondsLeft <= 0) {
    segmentIndex++;
    if (segmentIndex >= flatSegments.length) completePace();
    else startSegment(segmentIndex);
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

function restartPaceTimer() {
  clearInterval(timerInterval);
  isPaused = false;
  totalElapsedSeconds = 0;
  document.getElementById('btn-pause-resume').textContent = 'Pause';
  document.getElementById('timer-clock').classList.remove('paused');
  startSegment(0);
}

function endPace() {
  clearInterval(timerInterval);
  activePace = null;
  flatSegments = [];
  isPaused = false;
}

function completePace() {
  clearInterval(timerInterval);
  speak('Pace complete. Well done!');
  document.getElementById('complete-name').textContent = activePace?.name || '';
  document.getElementById('complete-time').textContent = 'Total: ' + formatTime(totalElapsedSeconds);
  showScreen('complete');
}

// ---- Display ----

function updateTimerDisplay() {
  const seg = flatSegments[segmentIndex];
  if (!seg) return;

  // Phase label: group info if applicable
  let phaseLabel = '';
  if (seg._groupName && seg._totalRepeats > 1) {
    phaseLabel = `${seg._groupName.toUpperCase()} — REPEAT ${seg._repeat} OF ${seg._totalRepeats}`;
  } else if (seg._groupName) {
    phaseLabel = seg._groupName.toUpperCase();
  }
  document.getElementById('timer-phase-label').textContent = phaseLabel;
  document.getElementById('timer-step-name').textContent = seg.name;
  document.getElementById('timer-clock').textContent = formatTime(secondsLeft);

  // Progress bar
  const elapsed = segmentDuration - secondsLeft;
  document.getElementById('timer-progress-fill').style.width =
    `${segmentDuration > 0 ? (elapsed / segmentDuration) * 100 : 100}%`;

  // Overall dots
  document.querySelectorAll('.overall-dot').forEach((dot, i) => {
    dot.classList.remove('done','active');
    if (i < segmentIndex) dot.classList.add('done');
    else if (i === segmentIndex) dot.classList.add('active');
  });

  // Next
  const next = flatSegments[segmentIndex + 1];
  document.getElementById('timer-next').textContent = next
    ? `Next: ${next.name} · ${formatTime(next.duration)}`
    : 'Final step';
}

function buildOverallDots() {
  const container = document.getElementById('timer-overall-progress');
  container.innerHTML = '';
  const max = Math.min(flatSegments.length, 40);
  for (let i = 0; i < max; i++) {
    const dot = document.createElement('div');
    dot.className = 'overall-dot';
    container.appendChild(dot);
  }
}

function animatePhaseTransition() {
  const body = document.querySelector('.timer-body');
  body.classList.remove('phase-transition');
  void body.offsetWidth;
  body.classList.add('phase-transition');
}

// ============================================================
// 11. SPEECH
// ============================================================

const synth = window.speechSynthesis;

if (synth) {
  synth.onvoiceschanged = () => populateVoicePicker();
  setTimeout(populateVoicePicker, 100);
}

function speak(text) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1; u.pitch = 1.0; u.volume = 1.0;
  if (settings.voiceName) {
    const voice = synth.getVoices().find(v => v.name === settings.voiceName);
    if (voice) u.voice = voice;
  }
  synth.speak(u);
}

function speakSegmentStart(seg) {
  const cue = seg.voiceCues?.[0];
  const text = (cue && cue.text) ? cue.text : seg.name;
  if (text) speak(text);
}

function checkVoiceCues(segIdx, elapsedSeconds) {
  const seg = flatSegments[segIdx];
  if (!seg?.voiceCues) return;
  seg.voiceCues.slice(1).forEach(cue => {
    if (cue.offsetSeconds === elapsedSeconds && cue.text) speak(cue.text);
  });
}

// ============================================================
// 12. SETTINGS
// ============================================================

function loadSettingsUI() {
  document.getElementById('settings-api-url').value = settings.apiUrl || '';
  document.getElementById('settings-api-key').value = settings.apiKey || '';
  updateModeButtons(settings.mode);
  updateThemeButtons(settings.theme);
  populateVoicePicker();
}

function saveSettingsFromUI() {
  settings.apiUrl    = document.getElementById('settings-api-url').value.trim();
  settings.apiKey    = document.getElementById('settings-api-key').value.trim();
  settings.voiceName = document.getElementById('settings-voice').value;
  saveSettings();
  syncPaces();
}

function populateVoicePicker() {
  const select = document.getElementById('settings-voice');
  if (!select || !synth) return;
  const voices = synth.getVoices().filter(v => v.lang.startsWith('en')).sort((a,b) => a.name.localeCompare(b.name));
  if (!voices.length) return;
  const current = settings.voiceName;
  select.innerHTML = '<option value="">Default voice</option>';
  voices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.name === current) opt.selected = true;
    select.appendChild(opt);
  });
}

function updateModeButtons(mode) {
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
function updateThemeButtons(theme) {
  document.querySelectorAll('.theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
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
  statusEl.textContent = 'Testing…'; statusEl.className = 'api-status';
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/ping', { headers: { 'X-API-Key': key } });
    if (res.ok) { statusEl.textContent = '✓ Connected'; statusEl.className = 'api-status ok'; }
    else throw new Error(res.status);
  } catch(e) { statusEl.textContent = `✗ Failed (${e.message})`; statusEl.className = 'api-status error'; }
}

// ============================================================
// 13. EVENT LISTENERS
// ============================================================

// Home
document.getElementById('btn-settings').addEventListener('click', () => { loadSettingsUI(); showScreen('settings'); });
document.getElementById('btn-new-pace').addEventListener('click', showTemplatePicker);

// Templates
document.getElementById('btn-templates-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-blank-pace').addEventListener('click', openBlankBuilder);

// Builder
document.getElementById('btn-builder-back').addEventListener('click', () => {
  const pace = savePaceFromBuilder();
  persistPace(pace);
  showScreen('home');
});

document.getElementById('btn-delete-pace').addEventListener('click', async () => {
  if (!editingPace) return;
  if (confirm(`Delete "${editingPace.name || 'this pace'}"?`)) {
    await deletePace(editingPace.id);
    showScreen('home');
  }
});

document.getElementById('btn-add-step-footer').addEventListener('click', () => {
  syncBuilderState();
  editingPace.items.push(makeBlankStep());
  renderBuilder();
  document.getElementById('builder-content').lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' });
});

document.getElementById('btn-add-group-footer').addEventListener('click', () => {
  syncBuilderState();
  editingPace.items.push(makeBlankGroup());
  renderBuilder();
  document.getElementById('builder-content').lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' });
});

document.getElementById('btn-start-pace').addEventListener('click', () => {
  const pace = savePaceFromBuilder();
  persistPace(pace);
  startPace(pace);
});

// Timer
document.getElementById('btn-end-pace').addEventListener('click', () => {
  if (confirm('End this pace?')) { endPace(); showScreen('home'); }
});
document.getElementById('btn-pause-resume').addEventListener('click', () => {
  if (isPaused) resumeTimer(); else pauseTimer();
});
document.getElementById('btn-restart').addEventListener('click', () => {
  if (confirm('Restart from the beginning?')) restartPaceTimer();
});

// Complete
document.getElementById('btn-complete-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-do-again').addEventListener('click', () => {
  if (activePace) startPace(activePace); else showScreen('home');
});

// Settings
document.getElementById('btn-settings-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-save-settings').addEventListener('click', () => { saveSettingsFromUI(); showScreen('home'); });
document.getElementById('btn-test-api').addEventListener('click', testApiConnection);
document.getElementById('btn-test-voice').addEventListener('click', () => {
  const name = document.getElementById('settings-voice').value;
  const prev = settings.voiceName;
  settings.voiceName = name;
  speak('Step one. Begin! Five, four, three, two, one. Pace complete.');
  settings.voiceName = prev;
});
document.getElementById('mode-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn[data-mode]');
  if (btn) applyMode(btn.dataset.mode);
});
document.getElementById('theme-grid').addEventListener('click', e => {
  const btn = e.target.closest('.theme-swatch');
  if (btn) applyTheme(btn.dataset.theme);
});

// ============================================================
// 14. INIT
// ============================================================

function init() {
  loadSettings();
  applyTheme(settings.theme);
  applyMode(settings.mode);
  paces = loadLocalPaces();
  renderPaceList();
  syncPaces();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();