/* ============================================================
   native.js — Capacitor integration layer.
   On Android, PacerTimerService handles all audio cues natively
   so they fire correctly even with the screen locked.
   No bundler required — accesses the plugin via window.Capacitor.Plugins.
   ============================================================ */

/**
 * Pre-compute a flat cue schedule from flatSegments.
 * Returns [{delayMs, text}] sorted by delayMs, ready to pass to
 * startNativeTimerWithSchedule(). All timing is relative to pace start.
 *
 * Manual ("On Tap") steps are skipped — their duration is unknown in advance
 * and they require the user to look at the screen anyway.
 *
 * @param {object[]} flatSegments        - from flattenItems()
 * @param {string}   transitionCountdown - '3', '5', or 'silent'
 * @returns {{ delayMs: number, text: string }[]}
 */
export function buildCueSchedule(flatSegments, transitionCountdown) {
  const cues   = [];
  const thresh = transitionCountdown === 'silent' ? 0 : (Number(transitionCountdown) || 5);
  let   offset = 0;   // running offset in milliseconds from pace start

  for (const seg of flatSegments) {
    const duration = seg.duration || 0;

    if (duration === 0) continue;   // manual step — skip, can't pre-schedule

    // Opening cue (index 0 voiceCue, or step name as fallback)
    const openingText = seg.voiceCues?.[0]?.text || seg.name;
    if (openingText) cues.push({ delayMs: offset, text: openingText });

    // Extra voice cues (index 1+), scheduled by their offset within the segment
    for (const cue of (seg.voiceCues || []).slice(1)) {
      if (cue.text && cue.offsetSeconds * 1000 < duration * 1000) {
        cues.push({ delayMs: offset + cue.offsetSeconds * 1000, text: cue.text });
      }
    }

    // Countdown cues — only when the step is long enough to be meaningful
    if (thresh > 0 && duration > thresh * 2) {
      for (let n = thresh; n >= 1; n--) {
        cues.push({ delayMs: offset + (duration - n) * 1000, text: String(n) });
      }
    }

    offset += duration * 1000;
  }

  // Completion cue fires 500 ms after the final step ends
  cues.push({ delayMs: offset + 500, text: 'Pace complete. Well done!' });

  return cues.sort((a, b) => a.delayMs - b.delayMs);
}

/**
 * Start PacerTimerService with a pre-built cue schedule.
 * The service manages its own wake lock and foreground notification —
 * voice cues will fire even with the screen locked.
 *
 * @param {{ delayMs: number, text: string }[]} schedule
 * @param {string} paceName  Shown in the foreground notification.
 * @returns {Promise<void>}
 */
export async function startNativeTimerWithSchedule(schedule, paceName) {
  const plugin = window.Capacitor?.Plugins?.PacerTimer;
  if (!plugin) {
    console.warn('[PacerTimer] Plugin not available — start skipped');
    return;
  }
  console.log('[PacerTimer] start →', schedule.length, 'cues, pace:', paceName);
  try {
    const result = await plugin.start({
      cues:     schedule,
      paceName: paceName || 'Pacer',
    });
    console.log('[PacerTimer] start ✓', result);
  } catch (err) {
    // Logged here — don't rethrow so callers need no .catch()
    console.error('[PacerTimer] start ✗', err?.message ?? err);
  }
}

/**
 * Stop PacerTimerService and cancel all pending cues.
 * @returns {Promise<void>}
 */
export async function stopNativeTimer() {
  const plugin = window.Capacitor?.Plugins?.PacerTimer;
  if (!plugin) return;
  console.log('[PacerTimer] stop →');
  try {
    await plugin.stop();
    console.log('[PacerTimer] stop ✓');
  } catch (err) {
    console.error('[PacerTimer] stop ✗', err?.message ?? err);
  }
}
