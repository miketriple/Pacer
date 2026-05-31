/* ============================================================
   native.js — Capacitor integration layer.
   On Android, PacerTimerService handles all audio cues natively
   so they fire correctly even with the screen locked.
   No bundler required — accesses the plugin via window.Capacitor.Plugins.
   ============================================================ */

/**
 * Pre-compute a flat cue schedule from flatSegments.
 * Returns [{delayMs, text}] sorted by delayMs, ready to pass to
 * startNativeTimerWithSchedule(). All timing is relative to the start of
 * the passed segments (i.e. delayMs=0 means "fire immediately").
 *
 * Manual ("On Tap") steps are skipped — their duration is unknown in advance
 * and they require the user to look at the screen anyway.
 *
 * @param {object[]} flatSegments        - from flattenItems() (or a slice thereof)
 * @param {string}   transitionCountdown - '3', '5', or 'silent'
 * @param {object}   [options]
 * @param {boolean}  [options.addCompletionCue=true] - append "Pace complete" after last step
 * @returns {{ delayMs: number, text: string }[]}
 */
export function buildCueSchedule(flatSegments, transitionCountdown, { addCompletionCue = true } = {}) {
  const cues   = [];
  const thresh = transitionCountdown === 'silent' ? 0 : (Number(transitionCountdown) || 5);
  let   offset = 0;   // running offset in milliseconds from chunk start

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

  if (addCompletionCue) {
    // Completion cue fires 500 ms after the final step ends
    cues.push({ delayMs: offset + 500, text: 'Pace complete. Well done!' });
  }

  return cues.sort((a, b) => a.delayMs - b.delayMs);
}

/**
 * Build the native cue schedule for the first contiguous run of timed steps
 * starting at startIdx in flatSegments.
 *
 * For paces with manual ("On Tap") steps, the schedule stops at the first
 * manual step and the completion cue is suppressed — the caller restarts a
 * new chunk when the user taps through each manual step.
 *
 * @param {object[]} flatSegments        - full flat segment list
 * @param {number}   startIdx            - index to begin from (0 for full pace)
 * @param {string}   transitionCountdown - '3', '5', or 'silent'
 * @returns {{ delayMs: number, text: string }[]}
 */
export function buildNativeChunk(flatSegments, startIdx, transitionCountdown) {
  const remaining       = flatSegments.slice(startIdx);
  const nextManualIdx   = remaining.findIndex(s => (s.duration || 0) === 0);
  const isFinalChunk    = nextManualIdx === -1;   // no more manual steps ahead
  const chunk           = isFinalChunk ? remaining : remaining.slice(0, nextManualIdx);
  return buildCueSchedule(chunk, transitionCountdown, { addCompletionCue: isFinalChunk });
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
