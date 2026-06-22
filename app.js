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
import {
  buildNativeChunk,
  startNativeTimerWithSchedule,
  stopNativeTimer,
} from './native.js';

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
  settings: {
    theme: 'venom', mode: 'system', apiUrl: '', apiKey: '', voiceName: '',
  },
};

// Ids of paces deleted locally whose server DELETE hasn't confirmed yet, and
// ids of paces with local edits/creates whose server PUT hasn't confirmed yet.
// Both are persisted (see save/loadSyncState) so an offline change survives a
// reload and can't be silently clobbered by the next successful GET sync.
const pendingDeletes = new Set();
const dirtyPaces     = new Set();

// True while the user is in Edit mode on the home screen.  In this mode,
// pace cards show ↑ ↓ ⎘ controls and tapping a card does NOT open the builder
// (so an accidental tap mid-edit can't start a pace).
let reorderMode = false;

// Circumference of the timer ring (2π·r with r=92 in the SVG viewBox).
// updateTimerDisplay sets stroke-dashoffset between 0 (full ring) and RING_C (empty).
const RING_C = 578.05;

// ============================================================
// 3. RUNTIME — per-pace running state
// ============================================================

/**
 * Per-pace runtime state — everything that exists only while a pace is running.
 * `state` holds persistent app data (paces list, settings); `runtime` holds the
 * ephemeral "a pace is currently active" context.  Keeping these separate makes
 * lifecycle reasoning clearer (one place to reset on endPace), and would be
 * the natural attachment point if multi-pace support were ever added
 * (an array of runtimes instead of one).
 *
 *   pace          — the active Pace object (or null when nothing is running)
 *   timer         — TimerEngine instance (long-lived; created once at startup)
 *   cues          — CueScheduler instance (long-lived; created once at startup)
 *   cueSchedule   — pre-computed [{delayMs, text}] for the current native chunk
 *   chunkStartMs  — wall-clock anchor for shifting cues on pause/resume
 *   pausedAtMs    — wall-clock ms when pause began; 0 when not paused
 *   isUserJumping — true mid-jump so onSegmentStart rebuilds the native chunk
 */
const runtime = {
  pace:          null,
  timer:         null,   // set just below, after CueScheduler exists
  cues:          new CueScheduler(),
  cueSchedule:   null,
  chunkStartMs:  0,
  pausedAtMs:    0,
  isUserJumping: false,
};

// On Android, all TTS goes through PacerTimerService (native Android TTS).
// Injecting no-ops prevents the WebView's speechSynthesis from being called,
// which would otherwise cancel native TTS cues at every segment transition.
if (window.Capacitor?.isNativePlatform()) {
  runtime.cues.setSpeakFn(() => Promise.resolve(), () => Promise.resolve());
}

runtime.timer = new TimerEngine({

  onSegmentStart(seg, idx) {
    runtime.cues.arm(seg);
    // Snap the ring to full (offset 0) without transition so it doesn't animate
    // from the previous segment's depleted state; restore the transition one
    // frame later so this segment's ticks deplete it smoothly.
    const ring = document.getElementById('timer-ring-fill');
    ring.style.transition = 'none';
    updateTimerDisplay();                                          // sets ring to full
    requestAnimationFrame(() => { ring.style.transition = ''; }); // restore
    animatePhaseTransition();
    boostRingFx(1.0);                                              // full swell on a step change

    // Native timer: route all audio through Android TTS because Web Speech API
    // is unreliable in the Capacitor WebView.
    if (window.Capacitor?.isNativePlatform() && runtime.pace) {
      const flat     = runtime.timer.flatSegments;
      const prevSeg  = flat[idx - 1];
      const isManual = (seg.duration || 0) === 0;

      if (isManual) {
        // Did we get here by natural advance from a timed step?  If so, the
        // manual step's opening cue (and any extras) were pre-scheduled at the
        // tail of the previous chunk — firing them again here would duplicate
        // the audio.  The chunk has already done its job; we just clear the
        // local cueSchedule reference so pause/resume math has nothing stale.
        const prevWasTimed = idx > 0 && (prevSeg?.duration || 0) > 0;
        if (prevWasTimed && !runtime.isUserJumping) {
          runtime.cueSchedule  = null;
          runtime.chunkStartMs = 0;
          runtime.pausedAtMs   = 0;
        } else {
          // First step of pace, back-to-back manual, or user-jumped to a manual
          // — no preceding chunk pre-scheduled this cue, so fire it from JS now.
          const openingText = seg.voiceCues?.[0]?.text || seg.name;
          const extraCues   = (seg.voiceCues || []).slice(1)
            .filter(c => c.text)
            .map(c => ({ delayMs: c.offsetSeconds * 1000, text: c.text }));
          const cueList = openingText
            ? [{ delayMs: 0, text: openingText }, ...extraCues]
            : extraCues;
          if (cueList.length > 0) {
            runtime.cueSchedule  = cueList;
            runtime.chunkStartMs = Date.now();
            runtime.pausedAtMs   = 0;
            console.log('[Pacer] manual step cue:', openingText);
            startNativeTimerWithSchedule(cueList, runtime.pace?.name || 'Pacer');
          } else {
            runtime.cueSchedule = null;
          }
        }
      } else if (runtime.isUserJumping || (idx > 0 && (prevSeg?.duration || 0) === 0)) {
        // User jumped to a timed step (or naturally advanced from a manual step)
        // — rebuild the native chunk from this position. The pre-scheduled timeline
        // from the previous chunk would now be wrong.
        const tc            = runtime.pace.transitionCountdown ?? '5';
        runtime.cueSchedule  = buildNativeChunk(flat, idx, tc);
        runtime.chunkStartMs = Date.now();
        runtime.pausedAtMs   = 0;
        console.log('[Pacer] rebuilding native chunk at seg', idx,
          '— cues:', runtime.cueSchedule.length, runtime.isUserJumping ? '(user jump)' : '(after manual)');
        stopNativeTimer().then(() =>
          startNativeTimerWithSchedule(runtime.cueSchedule, runtime.pace?.name || 'Pacer')
        );
      }
    }
    runtime.isUserJumping = false;
  },

  onTick(tickData) {
    const { secondsLeft, elapsedInSegment, isManual } = tickData;
    runtime.cues.tick(elapsedInSegment);

    if (!isManual) {
      const tc     = runtime.pace?.transitionCountdown ?? '5';
      const thresh = Number(tc);
      // cues.countdown is self-throttling: it yields to in-progress speech
      // (opening cue or extras) and drops any number whose slot has passed.
      if (tc !== 'silent') {
        runtime.cues.countdown(secondsLeft, thresh);
      }
      // Segment complete — bypass transition and snap the ring to empty so it
      // visually depletes fully before the next segment resets it to full.
      if (secondsLeft <= 0) {
        const ring = document.getElementById('timer-ring-fill');
        ring.style.transition = 'none';
        ring.style.strokeDashoffset = RING_C;
        return;
      }
    }

    updateTimerDisplay(tickData);
  },

  onComplete(totalElapsedSeconds) {
    runtime.cues.speak('Pace complete. Well done!');
    stopRingFx();
    document.getElementById('complete-name').textContent = runtime.pace?.name || '';
    document.getElementById('complete-time').textContent = 'Total: ' + formatTime(totalElapsedSeconds);
    showScreen('complete');
  },

});

/** Reset per-pace runtime fields to "no pace running".  Keeps the long-lived
 *  TimerEngine and CueScheduler instances — only the data fields are zeroed. */
function _resetRuntimeForNoPace() {
  runtime.pace          = null;
  runtime.cueSchedule   = null;
  runtime.chunkStartMs  = 0;
  runtime.pausedAtMs    = 0;
  runtime.isUserJumping = false;
}

// Dev console access — remove before shipping to production
window.__pacer__ = { state, runtime };

// ============================================================
// 4. UI HELPERS  (produce HTML strings — stay in app.js)
// ============================================================

function paceColorDots(pace) {
  return flattenItems(pace.items).slice(0, 5)
    .map(s => `<span class="pace-card-dot" style="background:${colorHex(s.color)}"></span>`)
    .join('');
}

/**
 * Ensure every pace has a numeric `order` field.  Paces missing one are
 * assigned the next sparse integer (existing array order is preserved on first
 * backfill).  Sparse steps of 10 leave room to insert without renumbering.
 */
function ensurePaceOrder(paces) {
  const existingMax = paces.reduce(
    (m, p) => typeof p.order === 'number' ? Math.max(m, p.order) : m,
    0
  );
  let next = existingMax + 10;
  paces.forEach(p => {
    if (typeof p.order !== 'number') {
      p.order = next;
      next += 10;
    }
  });
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
    const paces = JSON.parse(s).map(migratePace);
    ensurePaceOrder(paces);
    return paces;
  } catch (e) { return []; }
}

function saveLocalPaces() {
  localStorage.setItem('pacer_paces', JSON.stringify(state.paces));
}

// ── Pending-sync bookkeeping ─────────────────────────────────

function saveSyncState() {
  localStorage.setItem('pacer_dirty',           JSON.stringify([...dirtyPaces]));
  localStorage.setItem('pacer_pending_deletes',  JSON.stringify([...pendingDeletes]));
}

function loadSyncState() {
  try { JSON.parse(localStorage.getItem('pacer_dirty')          || '[]').forEach(id => dirtyPaces.add(id)); }    catch (e) {}
  try { JSON.parse(localStorage.getItem('pacer_pending_deletes') || '[]').forEach(id => pendingDeletes.add(id)); } catch (e) {}
}

function markDirty(id)  { dirtyPaces.add(id);    saveSyncState(); refreshSyncStatus(); }
function clearDirty(id) { dirtyPaces.delete(id); saveSyncState(); refreshSyncStatus(); }

function unsyncedCount() { return dirtyPaces.size + pendingDeletes.size; }

/** Show a persistent "N changes not synced" indicator when offline edits are
 *  pending, or clear it when everything is synced. */
function refreshSyncStatus() {
  const n = unsyncedCount();
  if (n > 0) setSyncStatus(`${n} change${n !== 1 ? 's' : ''} not synced`, 'error');
  else       setSyncStatus('', '');
}

/** Re-attempt every pending delete and dirty PUT.  Called after a successful
 *  GET sync (we know the network is up). Each success clears its pending flag. */
async function retryPendingSync() {
  for (const id of [...pendingDeletes]) {
    try { await apiRequest('DELETE', `/workouts/${id}`); pendingDeletes.delete(id); } catch (e) {}
  }
  for (const id of [...dirtyPaces]) {
    const pace = state.paces.find(p => p.id === id);
    if (!pace) { dirtyPaces.delete(id); continue; }   // dirty id we no longer hold — drop it
    try { await apiRequest('PUT', `/workouts/${id}`, pace); dirtyPaces.delete(id); } catch (e) {}
  }
  saveSyncState();
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
    const data        = await apiRequest('GET', '/workouts');
    const serverPaces = (data.workouts || data)
      .filter(p => !pendingDeletes.has(p.id))
      .map(migratePace);

    // Merge: the server is the source of truth EXCEPT for paces with unsynced
    // local changes. For a dirty id we keep the LOCAL copy, so a failed PUT (an
    // edit or a brand-new pace made while offline) can't be silently overwritten
    // by the server's older — or missing — version.
    const merged = serverPaces.filter(p => !dirtyPaces.has(p.id));
    for (const id of dirtyPaces) {
      const local = state.paces.find(p => p.id === id);
      if (local) merged.push(local);
      else       dirtyPaces.delete(id);   // dirty id we no longer hold — drop it
    }
    state.paces = merged;
    ensurePaceOrder(state.paces);
    saveLocalPaces();
    renderPaceList();

    // Network is up — push everything that was waiting, then reflect the result.
    await retryPendingSync();
    if (unsyncedCount() === 0) setSyncStatus('Synced', 'ok');
    else                       refreshSyncStatus();
  } catch (e) {
    setSyncStatus('Offline — using local data', 'error');
  }
}

async function persistPace(pace) {
  const idx = state.paces.findIndex(p => p.id === pace.id);
  if (idx >= 0) {
    // Editing an existing pace — preserve its current order so reorder isn't undone.
    if (typeof pace.order !== 'number') pace.order = state.paces[idx].order;
    state.paces[idx] = pace;
  } else {
    // New pace — slot it at the top by giving it a smaller order than any existing.
    if (typeof pace.order !== 'number') {
      const minOrder = state.paces.length
        ? Math.min(...state.paces.map(p => p.order ?? 0))
        : 10;
      pace.order = minOrder - 10;
    }
    state.paces.unshift(pace);
  }
  saveLocalPaces();
  renderPaceList();
  try { await apiRequest('PUT', `/workouts/${pace.id}`, pace); clearDirty(pace.id); }
  catch (e) { markDirty(pace.id); }   // remember the unsynced edit so sync won't clobber it
}

async function deletePace(id) {
  pendingDeletes.add(id);
  dirtyPaces.delete(id);   // a deleted pace shouldn't also linger as a dirty edit
  state.paces = state.paces.filter(p => p.id !== id);
  saveLocalPaces();
  saveSyncState();
  renderPaceList();
  try { await apiRequest('DELETE', `/workouts/${id}`); pendingDeletes.delete(id); saveSyncState(); }
  catch (e) {}
  refreshSyncStatus();
}

/**
 * Create a deep copy of a pace with fresh IDs throughout (steps, group-nested
 * steps, voice cues all get new IDs via regenIds).  The copy's name is
 * suffixed with " (copy)" and its `order` slots directly after the original
 * in the sort order, so the duplicate appears right below the original on
 * the home screen.  Returns the new pace; caller decides whether to
 * persistPace it, open it in the builder, etc.
 */
function duplicatePace(pace) {
  const copy = JSON.parse(JSON.stringify(pace));
  copy.id   = genId();
  regenIds(copy.items);
  copy.name = (pace.name || 'Pace') + ' (copy)';

  // Slot order between the original and the next pace in sort order.
  const sorted    = state.paces.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx       = sorted.findIndex(p => p.id === pace.id);
  const baseOrder = pace.order ?? 0;
  const next      = sorted[idx + 1];
  copy.order = next
    ? (baseOrder + (next.order ?? baseOrder + 20)) / 2
    : baseOrder + 10;

  return copy;
}

/**
 * Swap the `order` field of the pace with `paceId` and its adjacent neighbor in
 * the sorted list (delta = -1 → swap with the one above, +1 → with the one below).
 * Persists locally immediately and fires-and-forgets the server PUTs for both.
 */
async function _swapAdjacentPace(paceId, delta) {
  const sorted = state.paces.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = sorted.findIndex(p => p.id === paceId);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= sorted.length) return;     // already at edge
  const a = sorted[i], b = sorted[j];
  const tmp = a.order; a.order = b.order; b.order = tmp;
  saveLocalPaces();
  renderPaceList();
  // Fire both PUTs concurrently — they're independent and we don't block UI on them.
  // A failure marks the pace dirty so the new order isn't lost on the next sync.
  [a, b].forEach(p => apiRequest('PUT', `/workouts/${p.id}`, p)
    .then(() => clearDirty(p.id))
    .catch(() => markDirty(p.id)));
}

const movePaceUp   = id => _swapAdjacentPace(id, -1);
const movePaceDown = id => _swapAdjacentPace(id, +1);

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

/**
 * Themed replacement for window.confirm(). Returns a Promise that resolves true
 * (confirmed) or false (cancelled / dismissed). Closes on the buttons, a
 * backdrop click, Escape (cancel) or Enter (confirm).
 * @param {string} message
 * @param {{confirmText?:string, cancelText?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
function confirmDialog(message, { confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay   = document.getElementById('confirm-overlay');
    const msgEl     = document.getElementById('confirm-message');
    const okBtn     = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    msgEl.textContent     = message;
    okBtn.textContent     = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.classList.toggle('btn-danger', danger);
    okBtn.classList.toggle('btn-accent', !danger);
    overlay.classList.add('open');
    okBtn.focus();

    function close(result) {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    const onOk       = () => close(true);
    const onCancel   = () => close(false);
    const onBackdrop = e => { if (e.target === overlay) close(false); };
    const onKey      = e => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ============================================================
// 7. HOME SCREEN
// ============================================================

function renderPaceList() {
  const container = document.getElementById('pace-list');
  if (!state.paces.length) {
    reorderMode = false;   // nothing to reorder; reset so toggle is fresh next time
    container.innerHTML = `<div class="pace-empty">
      <div class="pace-empty-title">No paces yet</div>
      Tap <strong>+ New Pace</strong> to build your first guided rhythm.
    </div>`;
    return;
  }

  const toggleLabel = reorderMode ? 'Done' : 'Edit';
  const toggleCls   = reorderMode ? 'pace-reorder-toggle is-active' : 'pace-reorder-toggle';
  container.innerHTML = `
    <div class="pace-group-header">
      <div class="pace-group-title">My Paces</div>
      <button class="${toggleCls}" id="btn-reorder-toggle">${toggleLabel}</button>
    </div>
    <div class="pace-group-body" id="pace-group-body"></div>`;

  const body   = document.getElementById('pace-group-body');
  const sorted = state.paces.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((pace, i) => {
    const card = reorderMode
      ? makeReorderCard(pace, i, sorted.length)
      : makePaceCard(pace);
    body.appendChild(card);
  });

  document.getElementById('btn-reorder-toggle').addEventListener('click', () => {
    reorderMode = !reorderMode;
    renderPaceList();
  });
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

/**
 * Card variant shown while Edit mode is active.  Uses a <div> (not <button>)
 * so the card body isn't tappable — only the ↑ ↓ ⎘ controls are.  Edge arrows
 * (first card's ↑, last card's ↓) are disabled to signal "can't go further".
 */
function makeReorderCard(pace, idx, total) {
  const card = document.createElement('div');
  card.className = 'pace-card pace-card-reorder';
  card.innerHTML = `
    <div class="pace-card-dots">${paceColorDots(pace)}</div>
    <div class="pace-card-info">
      <div class="pace-card-name">${escHtml(pace.name || 'Untitled Pace')}</div>
      <div class="pace-card-meta">${paceMeta(pace)}</div>
    </div>
    <div class="pace-reorder-arrows">
      <button class="reorder-arrow" data-action="up"   aria-label="Move up"  ${idx === 0          ? 'disabled' : ''}>↑</button>
      <button class="reorder-arrow" data-action="down" aria-label="Move down"${idx === total - 1  ? 'disabled' : ''}>↓</button>
      <button class="reorder-arrow" data-action="dup"  aria-label="Duplicate"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    </div>`;
  card.querySelector('[data-action="up"]')  .addEventListener('click', () => movePaceUp(pace.id));
  card.querySelector('[data-action="down"]').addEventListener('click', () => movePaceDown(pace.id));
  card.querySelector('[data-action="dup"]') .addEventListener('click', () => {
    persistPace(duplicatePace(pace));
  });
  return card;
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

  const totalGroups = state.editingPace.items.length;
  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <input type="text" class="group-name-input" value="${escHtml(group.name)}" placeholder="Group name…" maxlength="40">
    <div class="group-repeats-wrap">
      <input type="number" class="group-repeats-input" value="${group.repeats}" min="1" max="99" aria-label="Repeats">
      <span class="group-repeats-x">×</span>
      <span class="group-repeats-label">repeats</span>
    </div>
    <div class="step-secondary-actions">
      <button class="step-action-btn" data-action="up"   ${groupIdx === 0 ? 'disabled' : ''}                aria-label="Move group up">↑</button>
      <button class="step-action-btn" data-action="down" ${groupIdx === totalGroups - 1 ? 'disabled' : ''}  aria-label="Move group down">↓</button>
      <button class="step-action-btn" data-action="dup"  aria-label="Duplicate group"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
      <button class="step-action-btn danger" data-action="del" aria-label="Delete group" title="Remove group">×</button>
    </div>`;
  card.appendChild(header);

  header.querySelector('.group-name-input').addEventListener('input', e => { group.name = e.target.value; });
  header.querySelector('.group-repeats-input').addEventListener('change', e => { group.repeats = parseInt(e.target.value) || 1; });

  // Group-level actions reuse handleStepAction since it operates generically on
  // any items array.  Delete keeps its own handler to preserve the confirmation
  // dialog (a group can hold many steps; an accidental click is more costly).
  header.querySelectorAll('.step-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (action === 'del') {
        if (await confirmDialog(`Remove group "${group.name || 'Group'}"?`, { confirmText: 'Remove', danger: true })) {
          syncBuilderState();
          state.editingPace.items.splice(groupIdx, 1);
          renderBuilder();
        }
        return;
      }
      syncBuilderState();
      handleStepAction(action, state.editingPace.items, groupIdx);
      renderBuilder();
    });
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

  runtime.pace = pace;
  runtime.cues.setVoice(state.settings.voiceName);
  document.getElementById('timer-pace-name').textContent = pace.name || 'Pacer';
  buildOverallDots(flat.length);
  showScreen('timer');
  _setTimerPausedVisual(false);  // begin the reactive ring loop; clear any lingering paused visual
  runtime.timer.start(flat);

  if (window.Capacitor?.isNativePlatform()) {
    // Build a cue schedule for the first contiguous timed chunk (stops before the
    // first manual step). The onSegmentStart handler restarts a new chunk each time
    // the user taps through a manual step back into timed steps.
    const tc          = pace.transitionCountdown ?? '5';
    runtime.cueSchedule = buildNativeChunk(flat, 0, tc);
    runtime.chunkStartMs = Date.now();
    runtime.pausedAtMs    = 0;
    console.log('[Pacer] starting native timer — segments:', flat.length,
      ', first chunk cues:', runtime.cueSchedule.length);
    if (runtime.cueSchedule.length > 0) {
      startNativeTimerWithSchedule(runtime.cueSchedule, pace.name || 'Pacer');
    }
  }
}

function updateTimerDisplay(tickData = null) {
  const idx = runtime.timer.segmentIndex;
  const seg = runtime.timer.flatSegments[idx];
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

  // Voice-cue text below the ring — shown only when it adds information beyond
  // the step name (so an identical name + opening cue isn't duplicated).
  const cueText = (seg.voiceCues?.[0]?.text || '').trim();
  document.getElementById('timer-cue-text').textContent =
    (cueText && cueText !== (seg.name || '').trim()) ? cueText : '';

  const clockEl  = document.getElementById('timer-clock');
  const subEl    = document.getElementById('timer-clock-sub');
  const manualBtn = document.getElementById('btn-manual-next');
  const ringFill = document.getElementById('timer-ring-fill');

  if (isManual) {
    // Count UP and show the "Done — Next Step" button. The ring becomes a short
    // arc that orbits slowly (.is-manual) — an honest "active, no fixed end"
    // signal, rather than a static full ring (which read as done/stalled).
    clockEl.textContent = formatTime(elapsedInSeg);
    subEl.textContent   = 'elapsed';
    ringFill.classList.add('is-manual');
    ringFill.style.strokeDashoffset = 0;
    if (manualBtn) manualBtn.style.display = 'flex';
  } else {
    if (manualBtn) manualBtn.style.display = 'none';
    ringFill.classList.remove('is-manual');
    // Ceil keeps the clock at "N" for the full Nth second — changes on clean
    // whole-second boundaries rather than at 0.5 s marks. The ring uses raw
    // float elapsed so it depletes smoothly and independently.
    const displaySeconds = Math.max(0, Math.ceil(secondsLeft));
    clockEl.textContent  = formatTime(displaySeconds);
    subEl.textContent    = 'of ' + formatTime(seg.duration);
    const frac = seg.duration > 0 ? Math.min(1, elapsedInSeg / seg.duration) : 1;
    ringFill.style.strokeDashoffset = RING_C * frac;   // 0 = full, RING_C = empty
  }

  document.querySelectorAll('.overall-dot').forEach((dot, i) => {
    dot.classList.remove('done', 'active');
    if (i < idx)        dot.classList.add('done');
    else if (i === idx) dot.classList.add('active');
  });

  const next = runtime.timer.flatSegments[idx + 1];
  document.getElementById('timer-next').textContent = next
    ? `Up next · ${next.name}${next.duration > 0 ? ' · ' + formatTime(next.duration) : ' · On Tap'}`
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
  // Settle only the changing labels (step name + cue text) on a new segment,
  // leaving the ring, time, dots and frame perfectly constant — so short steps
  // update in place instead of blinking the whole UI.
  ['timer-step-name', 'timer-cue-text'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('step-change');
    void el.offsetWidth;            // force reflow so the animation restarts
    el.classList.add('step-change');
  });
}

// ── Reactive wavy decoration rings ────────────────────────────
// Two faint wavy rings around the timer: subtle and calm at rest, but each
// spoken cue or step change injects "energy" that swells the wave amplitude and
// brightens them for a beat, then decays back to calm. A single RAF loop drives
// both rings, and runs only while the timer screen is active.
const ringFx = {
  raf: 0,
  t: 0,        // time accumulator (≈ seconds) for slow drift + resting breath
  energy: 0,   // 0 calm → 1 energized; spikes on events, decays each frame
  rings: [
    { id: 'decor-wave-1', r: 99,  waves: 7, baseAmp: 1.4, boostAmp: 5.5, baseOp: .14, boostOp: .55, drift:  0.16, breath: 0.9 },
    { id: 'decor-wave-2', r: 103, waves: 9, baseAmp: 1.1, boostAmp: 4.0, baseOp: .10, boostOp: .40, drift: -0.11, breath: 1.3 },
  ],
};

// Build a closed wavy-ring path: radius oscillates as amp·sin(waves·θ + phase).
function wavePath(r, waves, amp, phase) {
  const STEPS = 84, c = 105;
  let d = 'M';
  for (let i = 0; i <= STEPS; i++) {
    const a  = (i / STEPS) * Math.PI * 2;
    const rr = r + amp * Math.sin(waves * a + phase);
    d += `${i ? 'L' : ''}${(c + rr * Math.cos(a)).toFixed(1)},${(c + rr * Math.sin(a)).toFixed(1)}`;
  }
  return d + 'Z';
}

function ringFxFrame() {
  ringFx.t += 0.016;
  ringFx.energy = ringFx.energy < 0.002 ? 0 : ringFx.energy * 0.93;   // ease back to calm
  const e = ringFx.energy;
  for (const ring of ringFx.rings) {
    const el = document.getElementById(ring.id);
    if (!el) continue;
    const breathe = 0.5 * Math.sin(ringFx.t * ring.breath);            // gentle life at rest
    const amp     = ring.baseAmp + breathe + (ring.boostAmp - ring.baseAmp) * e;
    el.setAttribute('d', wavePath(ring.r, ring.waves, amp, ringFx.t * ring.drift));
    el.parentElement.style.opacity = (ring.baseOp + (ring.boostOp - ring.baseOp) * e).toFixed(3);
  }
  ringFx.raf = requestAnimationFrame(ringFxFrame);
}

function startRingFx() { if (!ringFx.raf) ringFxFrame(); }            // self-schedules the loop
function stopRingFx()  { if (ringFx.raf) { cancelAnimationFrame(ringFx.raf); ringFx.raf = 0; } }
function boostRingFx(amount) { ringFx.energy = Math.min(1, ringFx.energy + amount); }

/**
 * Set the play/pause button to show either ⏸ (currently playing → tap to pause)
 * or ▶ (currently paused → tap to resume), with matching aria-label and tooltip.
 */
// Inline SVG icons — Unicode pause/play glyphs render as colored emoji on
// some Android system fonts no matter what variation selector we use, so we
// draw the shapes ourselves to guarantee a flat monochrome look.
const _PAUSE_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect x="6" y="4" width="4" height="16" rx="1.5"/>'
  + '<rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>';
const _PLAY_SVG  = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M7 4 L20 12 L7 20 Z"/></svg>';

function _setPauseBtnIcon(isPaused) {
  const btn = document.getElementById('btn-pause-resume');
  const label = isPaused ? 'Resume' : 'Pause';
  btn.innerHTML = isPaused ? _PLAY_SVG : _PAUSE_SVG;
  // .is-paused gives the play icon an accent fill so it visually invites a tap;
  // the pause icon stays neutral while the pace is running.
  btn.classList.toggle('is-paused', isPaused);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title',      label);
}

/**
 * Mirror the paused state visually so it reads at a glance: freeze the decoration
 * waves (stop their RAF loop and dim them) and let CSS desaturate the ring.
 * Reversed on resume, and on any jump that auto-unpauses the timer.
 */
function _setTimerPausedVisual(isPaused) {
  document.getElementById('screen-timer').classList.toggle('is-paused', isPaused);
  if (isPaused) {
    stopRingFx();
    document.querySelectorAll('.decor-ring-svg').forEach(el => { el.style.opacity = '0.05'; });
  } else {
    startRingFx();
  }
}

function pauseTimer() {
  runtime.timer.pause();
  _setPauseBtnIcon(true);
  document.getElementById('timer-clock').classList.add('paused');
  _setTimerPausedVisual(true);
  if (window.Capacitor?.isNativePlatform()) {
    runtime.pausedAtMs = Date.now();   // record when pause began for epoch adjustment on resume
    stopNativeTimer();
  }
}

function resumeTimer() {
  runtime.timer.resume();
  _setPauseBtnIcon(false);
  document.getElementById('timer-clock').classList.remove('paused');
  _setTimerPausedVisual(false);
  if (window.Capacitor?.isNativePlatform() && runtime.cueSchedule) {
    // Shift runtime.chunkStartMs forward by the pause duration so that
    // Date.now() - runtime.chunkStartMs continues to equal "timer-elapsed ms"
    // even after any number of pauses.
    if (runtime.pausedAtMs > 0) {
      runtime.chunkStartMs += Date.now() - runtime.pausedAtMs;
      runtime.pausedAtMs = 0;
    }
    const elapsedMs = Date.now() - runtime.chunkStartMs;
    // Re-start the service with only the cues that haven't fired yet, shifted to "from now".
    const remaining = runtime.cueSchedule
      .filter(c => c.delayMs > elapsedMs)
      .map(c => ({ ...c, delayMs: c.delayMs - elapsedMs }));
    runtime.chunkStartMs = Date.now();   // reset — remaining cues are now relative to now
    startNativeTimerWithSchedule(remaining, runtime.pace?.name || 'Pacer');
  }
}

/**
 * Sync the pause-button label and clock styling after a jump that may have
 * unpaused the timer. (TimerEngine's restartSegment/previousSegment/nextSegment
 * auto-unpause; this brings the UI back into agreement.)
 */
function _syncPlayingUi() {
  _setPauseBtnIcon(false);
  document.getElementById('timer-clock').classList.remove('paused');
  _setTimerPausedVisual(false);
}

/** Restart the current step from its beginning. */
function restartCurrentStep() {
  if (!runtime.pace) return;
  runtime.cues.stop();
  runtime.isUserJumping = true;
  runtime.timer.restartSegment();
  _syncPlayingUi();
}

/** Jump to the start of the previous step. No-op on the first step. */
function previousStep() {
  if (!runtime.pace || runtime.timer.segmentIndex <= 0) return;
  runtime.cues.stop();
  runtime.isUserJumping = true;
  runtime.timer.previousSegment();
  _syncPlayingUi();
}

/** Jump to the start of the next step. On the last step, confirm + end the pace. */
async function nextStep() {
  if (!runtime.pace) return;
  if (runtime.timer.segmentIndex >= runtime.timer.flatSegments.length - 1) {
    if (await confirmDialog('End this pace?', { confirmText: 'End', danger: true })) {
      endPace(); showScreen('home');
    }
    return;
  }
  runtime.cues.stop();
  runtime.isUserJumping = true;
  runtime.timer.nextSegment();
  _syncPlayingUi();
}

function endPace() {
  runtime.timer.stop();
  runtime.cues.stop();
  stopRingFx();
  _resetRuntimeForNoPace();
  if (window.Capacitor?.isNativePlatform()) {
    stopNativeTimer();
  }
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
  runtime.cues.setVoice(state.settings.voiceName);
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

document.getElementById('btn-save-pace').addEventListener('click', () => {
  // Same persist call the back button uses — the back button autosaves, this
  // gives the user an explicit "yes, it's saved" action with visual feedback.
  persistPace(savePaceFromBuilder());
  const btn = document.getElementById('btn-save-pace');
  btn.classList.add('is-saved');
  setTimeout(() => btn.classList.remove('is-saved'), 1200);
});

document.getElementById('btn-duplicate-pace').addEventListener('click', () => {
  if (!state.editingPace) return;
  // Save the original first so any pending edits aren't lost in the original.
  const original = savePaceFromBuilder();
  persistPace(original);
  // Build the copy, persist it, and switch the builder focus to it so the user
  // is immediately editing the duplicate.
  const copy = duplicatePace(original);
  persistPace(copy);
  openBuilder(copy);
});

document.getElementById('btn-delete-pace').addEventListener('click', async () => {
  if (!state.editingPace) return;
  if (await confirmDialog(`Delete "${state.editingPace.name || 'this pace'}"?`, { confirmText: 'Delete', danger: true })) {
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

document.getElementById('btn-end-pace').addEventListener('click', async () => {
  if (await confirmDialog('End this pace?', { confirmText: 'End', danger: true })) {
    endPace(); showScreen('home');
  }
});
document.getElementById('btn-manual-next').addEventListener('click', () => runtime.timer.advanceManual());
document.getElementById('btn-pause-resume').addEventListener('click', () => {
  if (runtime.timer.isPaused) resumeTimer(); else pauseTimer();
});
document.getElementById('btn-prev-step')   .addEventListener('click', previousStep);
document.getElementById('btn-restart-step').addEventListener('click', restartCurrentStep);
document.getElementById('btn-next-step')   .addEventListener('click', nextStep);

document.getElementById('btn-complete-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-do-again').addEventListener('click', () => {
  if (runtime.pace) startPace(runtime.pace); else showScreen('home');
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

/** Silence the web CueScheduler on native — PacerTimerService handles all audio. */
async function initPlatform() {
  if (!window.Capacitor?.isNativePlatform()) return;
  if (!window.Capacitor?.Plugins?.PacerTimer) {
    console.warn('PacerTimer plugin not found — falling back to web TTS');
    return;
  }
  runtime.cues.setSpeakFn(() => Promise.resolve());
}

async function init() {
  loadSettings();
  loadSyncState();   // restore pending deletes / dirty-pace ids before any sync
  applyTheme(state.settings.theme);
  applyMode(state.settings.mode);
  state.paces = loadLocalPaces();
  renderPaceList();
  refreshSyncStatus();
  await loadTemplates();
  await initPlatform();
  runtime.cues.setVoice(state.settings.voiceName);
  runtime.cues.setOnSpeak(() => boostRingFx(0.55));   // each cue swells the decoration rings
  syncPaces();
  // Skip Service Worker inside Capacitor — it uses its own asset serving layer.
  if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform()) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
