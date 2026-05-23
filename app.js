/* ============================================================
   PACER — app.js  v4
   Orchestrates UI, storage, navigation, and builder.
   Domain logic lives in pace.js / utils.js.
   Timer engine in timer.js. Voice cues in cues.js.
   ============================================================ */

import { genId, formatTime, escHtml } from './utils.js';
import {
  STEP_COLORS,
  colorHex,
  makeBlankStep, makeBlankGroup,
  flattenItems, paceMeta,
  regenIds, migratePace, findStepById,
} from './pace.js';
import { TimerEngine  } from './timer.js';
import { CueScheduler } from './cues.js';

// ============================================================
// 1. TEMPLATE LOADING
// ============================================================

let TEMPLATES = [];

async function loadTemplates() {
  try {
    const res = await fetch('templates.json');
    if (!res.ok) throw new Error(res.status);
    TEMPLATES = await res.json();
  } catch (e) {
    console.warn('Could not load templates.json', e);
    TEMPLATES = [];
  }
}

// ============================================================
// 2. STATE
// ============================================================

const state = {
  paces:       [],
  editingPace: null,
  activePace:  null,
  settings: {
    theme: 'venom', mode: 'system', apiUrl: '', apiKey: '', voiceName: '',
  },
};

const pendingDeletes = new Set();

// ============================================================
// 3. SERVICES
// ============================================================

const cues  = new CueScheduler();

const timer = new TimerEngine({

  onSegmentStart(seg, idx) {
    cues.arm(seg);
    // Snap bar to 0% without transition so it doesn't animate back from 100%.
    // Restore the transition one frame later so the new segment's ticks animate normally.
    const fill = document.getElementById('timer-progress-fill');
    fill.style.transition = 'none';
    updateTimerDisplay();                                          // sets width to 0%
    requestAnimationFrame(() => { fill.style.transition = ''; }); // restore
    animatePhaseTransition();
  },

  onTick(tickData) {
    const { secondsLeft, elapsedInSegment, isManual } = tickData;
    cues.tick(elapsedInSegment);

    if (!isManual) {
      const tc     = state.activePace?.transitionCountdown ?? '5';
      const thresh = Number(tc);
      const segDur = timer.flatSegments[timer.segmentIndex]?.duration ?? 0;
      // Only count down when the step is long enough to make it meaningful
      if (tc !== 'silent' && segDur > thresh * 2) {
        cues.countdown(secondsLeft, thresh);
      }
      // Segment complete — bypass transition and snap bar to 100% so it
      // visually reaches the right edge before the next segment resets it.
      if (secondsLeft <= 0) {
        const fill = document.getElementById('timer-progress-fill');
        fill.style.transition = 'none';
        fill.style.width = '100%';
        return;
      }
    }

    updateTimerDisplay(tickData);
  },

  onComplete(totalElapsedSeconds) {
    cues.speak('Pace complete. Well done!');
    document.getElementById('complete-name').textContent = state.activePace?.name || '';
    document.getElementById('complete-time').textContent = 'Total: ' + formatTime(totalElapsedSeconds);
    showScreen('complete');
  },

});

// Dev console access — remove before shipping to production
window.__pacer__ = { state, timer, cues };

// ============================================================
// 4. UI HELPERS  (produce HTML strings — stay in app.js)
// ============================================================

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

// ============================================================
// 5. STORAGE & SYNC
// ============================================================

function loadSettings() {
  try {
    const s = localStorage.getItem('pacer_settings');
    if (s) Object.assign(state.settings, JSON.parse(s));
  } catch (e) {}
}

function saveSettings() {
  localStorage.setItem('pacer_settings', JSON.stringify(state.settings));
}

function loadLocalPaces() {
  try {
    const s = localStorage.getItem('pacer_paces');
    if (!s) return [];
    return JSON.parse(s).map(migratePace);
  } catch (e) { return []; }
}

function saveLocalPaces() {
  localStorage.setItem('pacer_paces', JSON.stringify(state.paces));
}

async function apiRequest(method, path, body = null) {
  if (!state.settings.apiUrl || !state.settings.apiKey) throw new Error('API not configured');
  const url  = state.settings.apiUrl.replace(/\/$/, '') + path;
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': state.settings.apiKey } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function syncPaces() {
  if (!state.settings.apiUrl || !state.settings.apiKey) return;
  setSyncStatus('Syncing…');
  try {
    const data    = await apiRequest('GET', '/workouts');
    state.paces   = (data.workouts || data)
      .filter(p => !pendingDeletes.has(p.id))
      .map(migratePace);
    saveLocalPaces();
    setSyncStatus('Synced', 'ok');
    renderPaceList();
  } catch (e) {
    setSyncStatus('Offline — using local data', 'error');
  }
}

async function persistPace(pace) {
  const idx = state.paces.findIndex(p => p.id === pace.id);
  if (idx >= 0) state.paces[idx] = pace; else state.paces.unshift(pace);
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('PUT', `/workouts/${pace.id}`, pace); } catch (e) {}
}

async function deletePace(id) {
  pendingDeletes.add(id);
  state.paces = state.paces.filter(p => p.id !== id);
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('DELETE', `/workouts/${id}`); pendingDeletes.delete(id); } catch (e) {}
}

function setSyncStatus(msg, cls = '') {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'sync-status' + (cls ? ' ' + cls : '');
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
  if (!state.paces.length) {
    container.innerHTML = `<div class="pace-empty">
      <div class="pace-empty-title">No paces yet</div>
      Tap <strong>+ New Pace</strong> to build your first guided rhythm.
    </div>`;
    return;
  }
  container.innerHTML = `<div class="pace-group-title">My Paces</div>
    <div class="pace-group-body" id="pace-group-body"></div>`;
  const body = document.getElementById('pace-group-body');
  state.paces.forEach(pace => body.appendChild(makePaceCard(pace)));
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

  if (!TEMPLATES.length) {
    container.innerHTML = '<p class="screen-hint">No templates available.</p>';
    showScreen('templates');
    return;
  }

  TEMPLATES.forEach(cat => {
    const catEl = document.createElement('div');
    catEl.className = 'template-category';

    const catHeader = document.createElement('button');
    catHeader.className = 'template-cat-header';
    catHeader.innerHTML = `<span class="template-cat-title">${escHtml(cat.category)}</span><span class="template-cat-chevron">▶</span>`;
    catEl.appendChild(catHeader);

    const catBody = document.createElement('div');
    catBody.className = 'template-cat-body collapsed';

    (cat.subcategories || []).forEach(sub => {
      const subEl = document.createElement('div');
      subEl.className = 'template-subcategory';

      const subHeader = document.createElement('button');
      subHeader.className = 'template-sub-header';
      subHeader.innerHTML = `<span class="template-sub-title">${escHtml(sub.name)}</span><span class="template-sub-chevron">▶</span>`;
      subEl.appendChild(subHeader);

      const subBody  = document.createElement('div');
      subBody.className = 'template-sub-body collapsed';
      const cards    = document.createElement('div');
      cards.className = 'template-cards';

      (sub.templates || []).forEach(tpl => {
        const btn = document.createElement('button');
        btn.className = 'template-card';
        btn.innerHTML = `
          <div class="template-card-dots">${templateColorDots(tpl.items || [])}</div>
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
    id:    genId(),
    name:  tpl.name,
    items: JSON.parse(JSON.stringify(tpl.items || [])),
    isNew: true,
  };
  regenIds(pace.items);
  openBuilder(pace);
}

// ============================================================
// 9. BUILDER
// ============================================================

function syncCountdownUI() {
  const val = String(state.editingPace.transitionCountdown ?? '5');
  document.querySelectorAll('#countdown-opts .countdown-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === val);
  });
}

function openBuilder(pace) {
  state.editingPace       = JSON.parse(JSON.stringify(pace));
  state.editingPace.items = state.editingPace.items || [];
  document.getElementById('builder-pace-name').value = state.editingPace.name || '';
  document.getElementById('btn-delete-pace').style.visibility =
    (state.editingPace.isNew || !state.paces.find(p => p.id === state.editingPace.id)) ? 'hidden' : 'visible';
  syncCountdownUI();
  renderBuilder();
  showScreen('builder');
}

function openBlankBuilder() {
  state.editingPace = { id: genId(), name: '', items: [], isNew: true, transitionCountdown: '5' };
  document.getElementById('builder-pace-name').value = '';
  document.getElementById('btn-delete-pace').style.visibility = 'hidden';
  syncCountdownUI();
  renderBuilder();
  showScreen('builder');
}

function renderBuilder() {
  const container = document.getElementById('builder-content');
  container.innerHTML = '';
  const items = state.editingPace.items || [];

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'builder-empty';
    empty.innerHTML = 'No steps yet.<br>Tap <strong>+ Step</strong> or <strong>+ Group</strong> below to begin.';
    container.appendChild(empty);
    return;
  }

  items.forEach((item, idx) => {
    if (item.type === 'step')       container.appendChild(buildStepCard(item, idx, null));
    else if (item.type === 'group') container.appendChild(buildGroupCard(item, idx));
  });
}

// ---- Step Card ----

function buildStepCard(step, itemIdx, groupIdx) {
  const inGroup = groupIdx !== null;
  const card    = document.createElement('div');
  card.className  = inGroup ? 'step-card group-step' : 'step-card';
  card.dataset.id = step.id;

  const isManual  = step.duration === 0;
  const mins      = Math.floor((step.duration || 0) / 60);
  const secs      = (step.duration || 0) % 60;
  const startCue  = step.voiceCues?.[0] ?? null;
  const extraCues = (step.voiceCues || []).slice(1);
  const isSilent  = !startCue || !startCue.text;

  const extraCuesHtml = extraCues.map((cue, ci) => `
    <div class="extra-cue-row" data-cue-idx="${ci + 1}">
      <input type="number" class="extra-cue-offset" value="${cue.offsetSeconds || 0}" min="0" aria-label="Offset seconds">
      <span class="extra-cue-label">s —</span>
      <input type="text" class="extra-cue-text" value="${escHtml(cue.text || '')}" placeholder="What to say…">
      <button class="extra-cue-del" aria-label="Remove">×</button>
    </div>`).join('');

  const totalItems = inGroup
    ? (state.editingPace.items[groupIdx]?.steps?.length ?? 0)
    : state.editingPace.items.length;

  card.innerHTML = `
    <div class="step-card-main">
      <span class="step-color-dot" style="background:${colorHex(step.color)}" title="Change color"></span>
      <input type="text" class="step-name-input" value="${escHtml(step.name)}" placeholder="Step name…" maxlength="40">
    </div>
    <div class="step-end-row">
      <span class="step-end-label">End Step:</span>
      <div class="step-end-toggle">
        <button class="step-end-btn ${isManual ? '' : 'active'}" data-end="duration">Duration</button>
        <button class="step-end-btn ${isManual ? 'active' : ''}" data-end="ontap">On Tap</button>
      </div>
      <div class="step-duration-wrap ${isManual ? 'hidden' : ''}">
        <input type="number" class="step-time-input" data-part="min" value="${mins}" min="0" max="99" aria-label="Minutes">
        <span class="step-colon">:</span>
        <input type="number" class="step-time-input" data-part="sec" value="${String(secs).padStart(2, '0')}" min="0" max="59" aria-label="Seconds">
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
        <button class="step-action-btn" data-action="dup"  aria-label="Duplicate"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
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

  // Wire events
  const nameInput    = card.querySelector('.step-name-input');
  const voiceInput   = card.querySelector('.step-voice-input');
  const voiceClear   = card.querySelector('.step-voice-clear');
  const voiceIcon    = card.querySelector('.step-voice-icon');
  const colorDot     = card.querySelector('.step-color-dot');
  const colorPicker  = card.querySelector('.color-picker');
  const durationWrap = card.querySelector('.step-duration-wrap');

  nameInput.addEventListener('input', () => { step.name = nameInput.value; });

  card.querySelectorAll('.step-end-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('.step-end-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.end === 'ontap') {
        step.duration = 0;
        durationWrap.classList.add('hidden');
      } else {
        if (!step.duration) step.duration = 60;
        const m = Math.floor(step.duration / 60);
        const s = step.duration % 60;
        card.querySelector('[data-part="min"]').value = m;
        card.querySelector('[data-part="sec"]').value = String(s).padStart(2, '0');
        durationWrap.classList.remove('hidden');
      }
    });
  });

  card.querySelectorAll('.step-time-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const m = parseInt(card.querySelector('[data-part="min"]').value) || 0;
      const s = Math.min(59, parseInt(card.querySelector('[data-part="sec"]').value) || 0);
      step.duration = m * 60 + s;
    });
  });

  if (!step.voiceCues)    step.voiceCues    = [];
  if (!step.voiceCues[0]) step.voiceCues[0] = { id: genId(), offsetSeconds: 0, text: step.name };

  voiceInput.addEventListener('input', () => {
    step.voiceCues[0].text = voiceInput.value;
    voiceIcon.classList.toggle('silent', !voiceInput.value.trim());
  });
  voiceClear.addEventListener('click', () => {
    voiceInput.value       = '';
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
    const parent  = card.parentElement;
    const newCard = buildStepCard(step, itemIdx, groupIdx);
    parent.replaceChild(newCard, card);
    newCard.querySelector('.step-extra-cues')?.lastElementChild?.querySelector('.extra-cue-text')?.focus();
  });

  card.querySelectorAll('.step-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncBuilderState();
      const action = btn.dataset.action;
      if (inGroup) handleStepAction(action, state.editingPace.items[groupIdx].steps, itemIdx);
      else         handleStepAction(action, state.editingPace.items, itemIdx);
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
  switch (action) {
    case 'up':   if (idx > 0)              [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]; break;
    case 'down': if (idx < arr.length - 1) [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]; break;
    case 'dup':  arr.splice(idx + 1, 0, JSON.parse(JSON.stringify(arr[idx]))); regenIds([arr[idx + 1]]); break;
    case 'del':  if (arr.length > 1) arr.splice(idx, 1); break;
  }
}

// ---- Group Card ----

function buildGroupCard(group, groupIdx) {
  const card = document.createElement('div');
  card.className  = 'group-card';
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
      state.editingPace.items.splice(groupIdx, 1);
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
  addBtn.className   = 'add-to-group-btn';
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

// ---- Sync builder DOM → state ----

function syncBuilderState() {
  state.editingPace.name = document.getElementById('builder-pace-name').value.trim();

  document.querySelectorAll('.step-card[data-id]').forEach(card => {
    const step    = findStepById(state.editingPace.items, card.dataset.id);
    if (!step) return;
    const nameEl  = card.querySelector('.step-name-input');
    const minEl   = card.querySelector('[data-part="min"]');
    const secEl   = card.querySelector('[data-part="sec"]');
    const voiceEl = card.querySelector('.step-voice-input');
    if (nameEl) step.name = nameEl.value;
    if (minEl && secEl) {
      const onTap   = card.querySelector('.step-end-btn[data-end="ontap"]')?.classList.contains('active');
      step.duration = onTap ? 0 : (parseInt(minEl.value) || 0) * 60 + Math.min(59, parseInt(secEl.value) || 0);
    }
    if (voiceEl && step.voiceCues?.[0]) step.voiceCues[0].text = voiceEl.value;
  });

  document.querySelectorAll('.group-card[data-id]').forEach(card => {
    const group  = state.editingPace.items.find(i => i.id === card.dataset.id);
    if (!group) return;
    const nameEl = card.querySelector('.group-name-input');
    const repEl  = card.querySelector('.group-repeats-input');
    if (nameEl) group.name    = nameEl.value;
    if (repEl)  group.repeats = parseInt(repEl.value) || 1;
  });
}

function savePaceFromBuilder() {
  syncBuilderState();
  state.editingPace.name = state.editingPace.name || 'My Pace';
  delete state.editingPace.isNew;
  return state.editingPace;
}

// ============================================================
// 10. TIMER
// ============================================================

function startPace(pace) {
  const flat = flattenItems(pace.items);
  if (!flat.length) { alert('This pace has no steps.'); return; }

  state.activePace = pace;
  cues.setVoice(state.settings.voiceName);
  document.getElementById('timer-pace-name').textContent = pace.name || 'Pacer';
  buildOverallDots(flat.length);
  showScreen('timer');
  timer.start(flat);
}

function updateTimerDisplay(tickData = null) {
  const idx = timer.segmentIndex;
  const seg = timer.flatSegments[idx];
  if (!seg) return;

  const isManual     = seg.duration === 0;
  const secondsLeft  = tickData ? tickData.secondsLeft      : (isManual ? 0 : seg.duration);
  const elapsedInSeg = tickData ? tickData.elapsedInSegment : 0;

  let phaseLabel = '';
  if (seg._groupName && seg._totalRepeats > 1) {
    phaseLabel = `${seg._groupName.toUpperCase()} — REPEAT ${seg._repeat} OF ${seg._totalRepeats}`;
  } else if (seg._groupName) {
    phaseLabel = seg._groupName.toUpperCase();
  }
  document.getElementById('timer-phase-label').textContent = phaseLabel;
  document.getElementById('timer-step-name').textContent   = seg.name || '';

  const clockEl    = document.getElementById('timer-clock');
  const manualBtn  = document.getElementById('btn-manual-next');
  const pauseBtn   = document.getElementById('btn-pause-resume');
  const progressEl = document.getElementById('timer-progress-fill');

  if (isManual) {
    clockEl.textContent    = formatTime(elapsedInSeg);
    clockEl.style.fontSize = 'clamp(28px, 8vw, 42px)';
    clockEl.classList.remove('paused');
    if (manualBtn) manualBtn.style.display = 'flex';
    if (pauseBtn)  pauseBtn.style.display  = 'none';
    progressEl.style.width = '0%';
  } else {
    clockEl.style.fontSize = '';
    if (manualBtn) manualBtn.style.display = 'none';
    if (pauseBtn)  pauseBtn.style.display  = '';
    // Ceil keeps the clock at "N" for the full Nth second — changes at clean
    // whole-second boundaries rather than at 0.5-second marks (Math.round).
    // The bar uses raw float elapsed so it moves smoothly and independently.
    const displaySeconds   = Math.max(0, Math.ceil(secondsLeft));
    clockEl.textContent    = formatTime(displaySeconds);
    progressEl.style.width =
      `${seg.duration > 0 ? Math.min(100, (elapsedInSeg / seg.duration) * 100) : 100}%`;
  }

  document.querySelectorAll('.overall-dot').forEach((dot, i) => {
    dot.classList.remove('done', 'active');
    if (i < idx)        dot.classList.add('done');
    else if (i === idx) dot.classList.add('active');
  });

  const next = timer.flatSegments[idx + 1];
  document.getElementById('timer-next').textContent = next
    ? `Next: ${next.name}${next.duration > 0 ? ' · ' + formatTime(next.duration) : ' · On Tap'}`
    : 'Final step';
}

function buildOverallDots(count) {
  const container = document.getElementById('timer-overall-progress');
  container.innerHTML = '';
  const max = Math.min(count, 40);
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

function pauseTimer() {
  timer.pause();
  document.getElementById('btn-pause-resume').textContent = 'Resume';
  document.getElementById('timer-clock').classList.add('paused');
}

function resumeTimer() {
  timer.resume();
  document.getElementById('btn-pause-resume').textContent = 'Pause';
  document.getElementById('timer-clock').classList.remove('paused');
}

function restartPaceTimer() {
  cues.stop();
  timer.restart();
  document.getElementById('btn-pause-resume').textContent = 'Pause';
  document.getElementById('timer-clock').classList.remove('paused');
}

function endPace() {
  timer.stop();
  cues.stop();
  state.activePace = null;
}

// ============================================================
// 11. SETTINGS
// ============================================================

function loadSettingsUI() {
  document.getElementById('settings-api-url').value = state.settings.apiUrl || '';
  document.getElementById('settings-api-key').value = state.settings.apiKey || '';
  updateModeButtons(state.settings.mode);
  updateThemeButtons(state.settings.theme);
  populateVoicePicker();
}

function saveSettingsFromUI() {
  state.settings.apiUrl    = document.getElementById('settings-api-url').value.trim();
  state.settings.apiKey    = document.getElementById('settings-api-key').value.trim();
  state.settings.voiceName = document.getElementById('settings-voice').value;
  saveSettings();
  cues.setVoice(state.settings.voiceName);
  syncPaces();
}

function populateVoicePicker() {
  const synth  = window.speechSynthesis;
  const select = document.getElementById('settings-voice');
  if (!select || !synth) return;
  const voices  = synth.getVoices().filter(v => v.lang.startsWith('en')).sort((a, b) => a.name.localeCompare(b.name));
  if (!voices.length) return;
  const current = state.settings.voiceName;
  select.innerHTML = '<option value="">Default voice</option>';
  voices.forEach(v => {
    const opt       = document.createElement('option');
    opt.value       = v.name;
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
  state.settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeButtons(theme);
  saveSettings();
}

function applyMode(mode) {
  state.settings.mode = mode;
  document.documentElement.setAttribute('data-mode', mode);
  updateModeButtons(mode);
  saveSettings();
}

async function testApiConnection() {
  const url      = document.getElementById('settings-api-url').value.trim();
  const key      = document.getElementById('settings-api-key').value.trim();
  const statusEl = document.getElementById('api-status');
  statusEl.textContent = 'Testing…';
  statusEl.className   = 'api-status';
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/ping', { headers: { 'X-API-Key': key } });
    if (res.ok) { statusEl.textContent = '✓ Connected'; statusEl.className = 'api-status ok'; }
    else throw new Error(res.status);
  } catch (e) {
    statusEl.textContent = `✗ Failed (${e.message})`;
    statusEl.className   = 'api-status error';
  }
}

// ============================================================
// 12. EVENT LISTENERS
// ============================================================

document.getElementById('btn-settings').addEventListener('click', () => { loadSettingsUI(); showScreen('settings'); });
document.getElementById('btn-new-pace').addEventListener('click', showTemplatePicker);

document.getElementById('btn-templates-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-blank-pace').addEventListener('click', openBlankBuilder);

document.getElementById('btn-builder-back').addEventListener('click', () => {
  persistPace(savePaceFromBuilder());
  showScreen('home');
});

document.getElementById('btn-delete-pace').addEventListener('click', async () => {
  if (!state.editingPace) return;
  if (confirm(`Delete "${state.editingPace.name || 'this pace'}"?`)) {
    const id = state.editingPace.id;
    state.editingPace = null;
    showScreen('home');
    await deletePace(id);
  }
});

document.querySelectorAll('#countdown-opts .countdown-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!state.editingPace) return;
    state.editingPace.transitionCountdown = btn.dataset.value;
    syncCountdownUI();
  });
});

document.getElementById('btn-add-step-footer').addEventListener('click', () => {
  syncBuilderState();
  state.editingPace.items.push(makeBlankStep());
  renderBuilder();
  document.getElementById('builder-content').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('btn-add-group-footer').addEventListener('click', () => {
  syncBuilderState();
  state.editingPace.items.push(makeBlankGroup());
  renderBuilder();
  document.getElementById('builder-content').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

document.getElementById('btn-start-pace').addEventListener('click', () => {
  const pace = savePaceFromBuilder();
  persistPace(pace);
  startPace(pace);
});

document.getElementById('btn-end-pace').addEventListener('click', () => {
  if (confirm('End this pace?')) { endPace(); showScreen('home'); }
});
document.getElementById('btn-manual-next').addEventListener('click', () => timer.advanceManual());
document.getElementById('btn-pause-resume').addEventListener('click', () => {
  if (timer.isPaused) resumeTimer(); else pauseTimer();
});
document.getElementById('btn-restart').addEventListener('click', () => {
  if (confirm('Restart from the beginning?')) restartPaceTimer();
});

document.getElementById('btn-complete-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-do-again').addEventListener('click', () => {
  if (state.activePace) startPace(state.activePace); else showScreen('home');
});

document.getElementById('btn-settings-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-save-settings').addEventListener('click', () => { saveSettingsFromUI(); showScreen('home'); });
document.getElementById('btn-test-api').addEventListener('click', testApiConnection);

document.getElementById('btn-test-voice').addEventListener('click', () => {
  // Bypass the scheduler for preview — lets us test without affecting timer state
  const synth = window.speechSynthesis;
  if (!synth) return;
  const name = document.getElementById('settings-voice').value;
  synth.cancel();
  const u = new SpeechSynthesisUtterance('Step one. Begin! Five, four, three, two, one. Pace complete.');
  u.rate = 1.1; u.pitch = 1.0; u.volume = 1.0;
  if (name) {
    const voice = synth.getVoices().find(v => v.name === name);
    if (voice) u.voice = voice;
  }
  synth.speak(u);
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
// 13. INIT
// ============================================================

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => populateVoicePicker();
  setTimeout(populateVoicePicker, 100);
}

async function init() {
  loadSettings();
  applyTheme(state.settings.theme);
  applyMode(state.settings.mode);
  state.paces = loadLocalPaces();
  renderPaceList();
  await loadTemplates();
  cues.setVoice(state.settings.voiceName);
  syncPaces();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
