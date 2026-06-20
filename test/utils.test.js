/* ============================================================
   utils.test.js — tests for the generic helpers in utils.js.
   Run with:  npm test     (or: node --test test/)
   ============================================================ */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { formatTime, escHtml, genId } from '../utils.js';

test('formatTime — formats seconds as mm:ss with zero-padding', () => {
  assert.equal(formatTime(0),    '00:00');
  assert.equal(formatTime(5),    '00:05');
  assert.equal(formatTime(59),   '00:59');
  assert.equal(formatTime(60),   '01:00');
  assert.equal(formatTime(65),   '01:05');
  assert.equal(formatTime(600),  '10:00');
  assert.equal(formatTime(3599), '59:59');
});

test('formatTime — rounds fractional seconds and handles negatives', () => {
  assert.equal(formatTime(65.4), '01:05');   // rounds down
  assert.equal(formatTime(65.6), '01:06');   // rounds up
  assert.equal(formatTime(-65),  '01:05');   // abs value
});

test('escHtml — escapes the five HTML-significant characters', () => {
  assert.equal(escHtml('<b>'),       '&lt;b&gt;');
  assert.equal(escHtml('a & b'),     'a &amp; b');
  assert.equal(escHtml('"quoted"'),  '&quot;quoted&quot;');
  assert.equal(escHtml("it's"),      'it&#39;s');
});

test('escHtml — null/undefined become empty string', () => {
  assert.equal(escHtml(null),      '');
  assert.equal(escHtml(undefined), '');
});

test('genId — returns a distinct underscore-prefixed id each call', () => {
  const a = genId();
  const b = genId();
  assert.match(a, /^_[a-z0-9]+$/);
  assert.notEqual(a, b);
});
