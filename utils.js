/* ============================================================
   utils.js — Generic, domain-free helpers.
   No imports. Safe to test in Node without a DOM.
   ============================================================ */

export function genId() {
  return '_' + Math.random().toString(36).slice(2, 9);
}

export function formatTime(sec) {
  const s = Math.abs(Math.round(sec));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

export function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
