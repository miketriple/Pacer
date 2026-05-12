/* ============================================================
   PACER — app.js  v3
   Guided rhythm for any workflow.
   Templates loaded from templates.json
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
const DEFAULT_STEP_DURATION = 60;

// ============================================================
// 2. TEMPLATE LOADING
// ============================================================

let TEMPLATES = [];

async function loadTemplates() {
  try {
    const res = await fetch('templates.json');
    if (!res.ok) throw new Error(res.status);
    TEMPLATES = await res.json();
  } catch(e) {
    console.warn('Could not load templates.json', e);
    TEMPLATES = [];
  }
}

// ============================================================
// 3. STATE
// ============================================================

let paces               = [];
let editingPace         = null;
let activePace          = null;
let flatSegments        = [];
let segmentIndex        = 0;
let secondsLeft         = 0;
let segmentDuration     = 0;
let timerInterval       = null;
let isPaused            = false;
let totalElapsedSeconds = 0;
const pendingDeletes    = new Set();

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
  const step = {
    type: 'step', id: genId(),
    name: 'Step', duration: DEFAULT_STEP_DURATION,
    color: DEFAULT_COLOR,
    voiceCues: [],
  };
  step.voiceCues = [{ id: genId(), offsetSeconds: 0, text: step.name }];
  return step;
}

function makeBlankGroup() {
  return { type: 'group', id: genId(), name: 'Group', repeats: 3, steps: [makeBlankStep(), makeBlankStep()] };
}

function flattenItems(items) {
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

function paceMeta(pace) {
  const steps = flattenItems(pace.items);
  const total = steps.reduce((a, s) => a + (s.duration || 0), 0);
  const stepCount = steps.length;
  return `${stepCount} step${stepCount !== 1 ? 's' : ''} · ${formatTime(total)}`;
}

function paceColorDots(pace) {
  return flattenItems(pace.items).slice(0, 5)
    .map(s => `<span class="pace-card-dot" style="background:${colorHex(s.color)}"></span>`)
    .join('');
}

function templateColorDots(items) {
  return flattenItems(items).slice(0, 4)
    .map(s => `<span class="template-card-dot" style="background:${colorHex(s.color)}"></span>`)
    .join('');
}

/** Ensure every item has a fresh unique ID (used when cloning templates) */
function regenIds(items) {
  if (!Array.isArray(items)) return;
  items.forEach(item => {
    item.id = genId();
    if (item.type === 'group') regenIds(item.steps);
    if (Array.isArray(item.voiceCues)) item.voiceCues.forEach(c => c.id = genId());
  });
}

// ============================================================
// 5. MIGRATION (old format → new items-based format)
// ============================================================

function migratePace(pace) {
  if (Array.isArray(pace.items)) return pace;
  const items = [];
  if (Array.isArray(pace.segments)) {
    pace.segments.forEach(seg => {
      items.push({
        type: 'step', id: genId(),
        name: seg.label || 'Step',
        duration: seg.duration || 60,
        color: seg.phase === 'work' ? 'red' : seg.phase === 'rest' ? 'blue' :
               seg.phase === 'warmup' ? 'yellow' : seg.phase === 'cooldown' ? 'teal' : DEFAULT_COLOR,
        voiceCues: [{ id: genId(), offsetSeconds: 0, text: seg.label || 'Step' }],
      });
    });
  } else if (pace.type === 'interval') {
    if (pace.warmupDuration > 0)
      items.push({ type:'step', id:genId(), name:'Warm Up', duration:pace.warmupDuration, color:'yellow', voiceCues:[{id:genId(),offsetSeconds:0,text:'Warm up.'}] });
    const gs = [];
    gs.push({ type:'step', id:genId(), name:'Work', duration:pace.workDuration||40, color:'red', voiceCues:[{id:genId(),offsetSeconds:0,text:'Begin!'}] });
    if (pace.restDuration > 0)
      gs.push({ type:'step', id:genId(), name:'Rest', duration:pace.restDuration, color:'blue', voiceCues:[{id:genId(),offsetSeconds:0,text:'Rest.'}] });
    items.push({ type:'group', id:genId(), name:'Round', repeats:pace.rounds||1, steps:gs });
    if (pace.cooldownDuration > 0)
      items.push({ type:'step', id:genId(), name:'Cool Down', duration:pace.cooldownDuration, color:'teal', voiceCues:[{id:genId(),offsetSeconds:0,text:'Cool down.'}] });
  }
  return { ...pace, items, type: 'custom' };
}

// ============================================================
// 6. STORAGE & SYNC
// ============================================================

function loadSettings() {
  try { const s = localStorage.getItem('pacer_settings'); if (s) Object.assign(settings, JSON.parse(s)); } catch(e){}
}
function saveSettings() { localStorage.setItem('pacer_settings', JSON.stringify(settings)); }

function loadLocalPaces() {
  try {
    const s = localStorage.getItem('pacer_paces');
    if (!s) return [];
    return JSON.parse(s).map(migratePace);
  } catch(e) { return []; }
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
    paces = (data.workouts || data)
      .filter(p => !pendingDeletes.has(p.id))
      .map(migratePace);
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
  pendingDeletes.add(id);
  paces = paces.filter(p => p.id !== id);
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('DELETE', `/workouts/${id}`); pendingDeletes.delete(id); } catch(e){}
}

function setSyncStatus(msg, cls = '') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
  if (cls === 'ok') setTimeout(() => { el.textContent = ''; el.className = 'sync-status'; }, 3000);
}

// ============================================================
// 7. NAVIGATION
// ============================================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id)?.classList.add('active');
}

// ============================================================
// 8. HOME SCREEN
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
// 9. TEMPLATE PICKER
// ============================================================

function showTemplatePicker() {
  const container = document.getElementById('template-list');
  container.innerHTML = '';

  if (!TEMPLATES.length) {
    container.innerHTML = '<p class="screen-hint">No templates available.</p>';
    showScreen('templates');
    return;
  }

  TEMPLATES.forEach(cat => {
    const catEl = document.createElement('div');
    catEl.className = 'template-category';

    // Category header — starts EXPANDED
    const catHeader = document.createElement('button');
    catHeader.className = 'template-cat-header';
    catHeader.innerHTML = `<span class="template-cat-title">${escHtml(cat.category)}</span><span class="template-cat-chevron">▼</span>`;
    catEl.appendChild(catHeader);

    const catBody = document.createElement('div');
    catBody.className = 'template-cat-body'; // no 'collapsed' — starts open

    (cat.subcategories || []).forEach(sub => {
      const subEl = document.createElement('div');
      subEl.className = 'template-subcategory';

      // Subcategory header — starts COLLAPSED
      const subHeader = document.createElement('button');
      subHeader.className = 'template-sub-header';
      subHeader.innerHTML = `<span class="template-sub-title">${escHtml(sub.name)}</span><span class="template-sub-chevron">▶</span>`;
      subEl.appendChild(subHeader);

      const subBody = document.createElement('div');
      subBody.className = 'template-sub-body collapsed'; // starts collapsed
      const cards = document.createElement('div');
      cards.className = 'template-cards';

      (sub.templates || []).forEach(tpl => {
        const btn = document.createElement('button');
        btn.className = 'template-card';
        const dots = templateColorDots(tpl.items || []);
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

      subBody.appendChild(cards);
      subEl.appendChild(subBody);

      subHeader.addEventListener('click', () => {
        const collapsed = subBody.classList.toggle('collapsed');
        subHeader.querySelector('.template-sub-chevron').textContent = collapsed ? '▶' : '▼';
      });

      catBody.appendChild(subEl);
    });

    catHeader.addEventListener('click', () => {
      const collapsed = catBody.classList.toggle('collapsed');
      catHeader.querySelector('.template-cat-chevron').textContent = collapsed ? '▶' : '▼';
    });

    catEl.appendChild(catBody);
    container.appendChild(catEl);
  });

  showScreen('templates');
}

function openBuilderFromTemplate(tpl) {
  const pace = {
    id: genId(),
    name: tpl.name,
    items: JSON.parse(JSON.stringify(tpl.items || [])),
    isNew: true,
  };
  regenIds(pace.items);
  openBuilder(pace);
}

// ============================================================
// 10. BUILDER
// ============================================================

function openBuilder(pace) {
  editingPace = JSON.parse(JSON.stringify(pace));
  editingPace.items = editingPace.items || [];
  document.getElementById('builder-pace-name').value = editingPace.name || '';
  document.getElementById('btn-delete-pace').style.visibility =
    (editingPace.isNew || !paces.find(p => p.id === editingPace.id)) ? 'hidden' : 'visible';
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

  const mins = Math.floor((step.duration || 0) / 60);
  const secs = (step.duration || 0) % 60;
  const startCue = step.voiceCues?.[0] ?? null;
  const extraCues = (step.voiceCues || []).slice(1);
  const isSilent = !startCue || !startCue.text;

  const extraCuesHtml = extraCues.map((cue, ci) => `
    <div class="extra-cue-row" data-cue-idx="${ci + 1}">
      <input type="number" class="extra-cue-offset" value="${cue.offsetSeconds || 0}" min="0" aria-label="Offset seconds">
      <span class="extra-cue-label">s —</span>
      <input type="text" class="extra-cue-text" value="${escHtml(cue.text || '')}" placeholder="What to say…">
      <button class="extra-cue-del" aria-label="Remove">×</button>
    </div>`).join('');

  const totalItems = inGroup
    ? (editingPace.items[groupIdx]?.steps?.length ?? 0)
    : editingPace.items.length;

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
        <span class="step-voice-icon ${isSilent ? 'silent' : ''}" title="Voice cue">🔊</span>
        <input type="text" class="step-voice-input" value="${escHtml(startCue?.text || '')}" placeholder="silent…" maxlength="120">
        <button class="step-voice-clear" title="Clear cue">×</button>
      </div>
      <div class="step-secondary-actions">
        <button class="step-action-btn" data-action="up"   ${itemIdx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="step-action-btn" data-action="down" ${itemIdx === totalItems - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="step-action-btn" data-action="dup"  aria-label="Duplicate">⊕</button>
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
  const nameInput  = card.querySelector('.step-name-input');
  const voiceInput = card.querySelector('.step-voice-input');
  const voiceClear = card.querySelector('.step-voice-clear');
  const voiceIcon  = card.querySelector('.step-voice-icon');
  const colorDot   = card.querySelector('.step-color-dot');
  const colorPicker = card.querySelector('.color-picker');

  nameInput.addEventListener('input', () => { step.name = nameInput.value; });

  card.querySelectorAll('.step-time-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const m = parseInt(card.querySelector('[data-part="min"]').value) || 0;
      const s = Math.min(59, parseInt(card.querySelector('[data-part="sec"]').value) || 0);
      step.duration = m * 60 + s;
    });
  });

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

  colorDot.addEventListener('click', () => colorPicker.classList.toggle('hidden'));
  colorPicker.addEventListener('click', e => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    step.color = sw.dataset.color;
    colorDot.style.background = colorHex(step.color);
    colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === step.color));
    colorPicker.classList.add('hidden');
  });

  const extraCuesContainer = card.querySelector('.step-extra-cues');
  if (extraCuesContainer) wireExtraCues(extraCuesContainer, step);

  card.querySelector('.add-voice-cue-btn').addEventListener('click', () => {
    step.voiceCues.push({ id: genId(), offsetSeconds: 30, text: '' });
    const parent = card.parentElement;
    const newCard = buildStepCard(step, itemIdx, groupIdx);
    parent.replaceChild(newCard, card);
    newCard.querySelector('.step-extra-cues')?.lastElementChild?.querySelector('.extra-cue-text')?.focus();
  });

  card.querySelectorAll('.step-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncBuilderState();
      const action = btn.dataset.action;
      if (inGroup) {
        handleStepAction(action, editingPace.items[groupIdx].steps, itemIdx);
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
    const actualIdx = ri + 1;
    row.querySelector('.extra-cue-offset').addEventListener('change', e => {
      if (step.voiceCues[actualIdx]) step.voiceCues[actualIdx].offsetSeconds = parseInt(e.target.value) || 0;
    });
    row.querySelector('.extra-cue-text').addEventListener('input', e => {
      if (step.voiceCues[actualIdx]) step.voiceCues[actualIdx].text = e.target.value;
    });
    row.querySelector('.extra-cue-del').addEventListener('click', () => {
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
    <button class="step-action-btn danger" aria-label="Delete group" title="Remove group">×</button>`;
  card.appendChild(header);

  header.querySelector('.group-name-input').addEventListener('input', e => { group.name = e.target.value; });
  header.querySelector('.group-repeats-input').addEventListener('change', e => { group.repeats = parseInt(e.target.value) || 1; });
  header.querySelector('.step-action-btn.danger').addEventListener('click', () => {
    if (confirm(`Remove group "${group.name || 'Group'}"?`)) {
      syncBuilderState();
      editingPace.items.splice(groupIdx, 1);
      renderBuilder();
    }
  });

  const body = document.createElement('div');
  body.className = 'group-body';
  if (!group.steps || group.steps.length === 0) {
    body.innerHTML = '<div class="group-empty">No steps. Add one below.</div>';
  } else {
    group.steps.forEach((step, stepIdx) => body.appendChild(buildStepCard(step, stepIdx, groupIdx)));
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

// ---- Sync builder state back to editingPace ----

function syncBuilderState() {
  editingPace.name = document.getElementById('builder-pace-name').value.trim();

  document.querySelectorAll('.step-card[data-id]').forEach(card => {
    const step = findStepById(editingPace.items, card.dataset.id);
    if (!step) return;
    const nameEl  = card.querySelector('.step-name-input');
    const minEl   = card.querySelector('[data-part="min"]');
    const secEl   = card.querySelector('[data-part="sec"]');
    const voiceEl = card.querySelector('.step-voice-input');
    if (nameEl) step.name = nameEl.value;
    if (minEl && secEl) step.duration = (parseInt(minEl.value)||0)*60 + Math.min(59,parseInt(secEl.value)||0);
    if (voiceEl && step.voiceCues?.[0]) step.voiceCues[0].text = voiceEl.value;
  });

  document.querySelectorAll('.group-card[data-id]').forEach(card => {
    const group = editingPace.items.find(i => i.id === card.dataset.id);
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
      const found = (item.steps || []).find(s => s.id === id);
      if (found) return found;
    }
  }
  return null;
}

function savePaceFromBuilder() {
  syncBuilderState();
  editingPace.name = editingPace.name || 'My Pace';
  delete editingPace.isNew;
  return editingPace;
}

// ============================================================
// 11. TIMER ENGINE
// ============================================================

function startPace(pace) {
  activePace          = pace;
  flatSegments        = flattenItems(pace.items);
  segmentIndex        = 0;
  isPaused            = false;
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
  segmentDuration = seg.duration || 0;
  secondsLeft     = seg.duration || 0;

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
  activePace   = null;
  flatSegments = [];
  isPaused     = false;
}

function completePace() {
  clearInterval(timerInterval);
  speak('Pace complete. Well done!');
  document.getElementById('complete-name').textContent = activePace?.name || '';
  document.getElementById('complete-time').textContent = 'Total: ' + formatTime(totalElapsedSeconds);
  showScreen('complete');
}

function updateTimerDisplay() {
  const seg = flatSegments[segmentIndex];
  if (!seg) return;

  let phaseLabel = '';
  if (seg._groupName && seg._totalRepeats > 1) {
    phaseLabel = `${seg._groupName.toUpperCase()} — REPEAT ${seg._repeat} OF ${seg._totalRepeats}`;
  } else if (seg._groupName) {
    phaseLabel = seg._groupName.toUpperCase();
  }
  document.getElementById('timer-phase-label').textContent = phaseLabel;
  document.getElementById('timer-step-name').textContent = seg.name || '';
  document.getElementById('timer-clock').textContent = formatTime(secondsLeft);

  const elapsed = segmentDuration - secondsLeft;
  document.getElementById('timer-progress-fill').style.width =
    `${segmentDuration > 0 ? Math.min(100, (elapsed / segmentDuration) * 100) : 100}%`;

  document.querySelectorAll('.overall-dot').forEach((dot, i) => {
    dot.classList.remove('done','active');
    if (i < segmentIndex) dot.classList.add('done');
    else if (i === segmentIndex) dot.classList.add('active');
  });

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
  if (!body) return;
  body.classList.remove('phase-transition');
  void body.offsetWidth;
  body.classList.add('phase-transition');
}

// ============================================================
// 12. SPEECH
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
// 13. SETTINGS
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
  document.querySelectorAll('.seg-btn[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
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
// 14. EVENT LISTENERS
// ============================================================

document.getElementById('btn-settings').addEventListener('click', () => { loadSettingsUI(); showScreen('settings'); });
document.getElementById('btn-new-pace').addEventListener('click', showTemplatePicker);

document.getElementById('btn-templates-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-blank-pace').addEventListener('click', openBlankBuilder);

document.getElementById('btn-builder-back').addEventListener('click', () => {
  const pace = savePaceFromBuilder();
  persistPace(pace);
  showScreen('home');
});

document.getElementById('btn-delete-pace').addEventListener('click', async () => {
  if (!editingPace) return;
  if (confirm(`Delete "${editingPace.name || 'this pace'}"?`)) {
    const id = editingPace.id;
    editingPace = null;
    showScreen('home');
    await deletePace(id);
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

document.getElementById('btn-end-pace').addEventListener('click', () => {
  if (confirm('End this pace?')) { endPace(); showScreen('home'); }
});
document.getElementById('btn-pause-resume').addEventListener('click', () => {
  if (isPaused) resumeTimer(); else pauseTimer();
});
document.getElementById('btn-restart').addEventListener('click', () => {
  if (confirm('Restart from the beginning?')) restartPaceTimer();
});

document.getElementById('btn-complete-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-do-again').addEventListener('click', () => {
  if (activePace) startPace(activePace); else showScreen('home');
});

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
// 15. INIT
// ============================================================

async function init() {
  loadSettings();
  applyTheme(settings.theme);
  applyMode(settings.mode);
  paces = loadLocalPaces();
  renderPaceList();
  await loadTemplates();  // load templates.json before anything needs them
  syncPaces();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();