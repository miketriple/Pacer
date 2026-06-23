/* ============================================================
   timer.js — Timestamp-based timer engine.
   Owns no DOM. Communicates entirely via callbacks.
   Survives mobile backgrounding by anchoring to wall-clock time.
   ============================================================ */

/**
 * Pure timeline math (no DOM, no clock reads) shared by the engine's normal
 * advance and its background-recovery. Given the absolute start of segment
 * `fromIndex`, walk forward through any timed segments that `now` has already
 * passed and return the segment `now` falls in, plus that segment's *exact*
 * absolute start. Stops at a manual (duration 0) segment — those have no fixed
 * length — and `index === segments.length` means the timeline is exhausted
 * (caller should complete). Anchoring starts to this fixed timeline is what keeps
 * the UI in lockstep with the audio schedule instead of drifting by accumulated
 * polling latency.
 */
export function resolveActiveSegment(fromIndex, fromStartTime, segments, now) {
  let index = fromIndex;
  let startTime = fromStartTime;
  while (index < segments.length) {
    const dur = segments[index]?.duration || 0;
    if (dur === 0) break;                      // manual step — can't auto-advance past it
    if (now < startTime + dur * 1000) break;   // now is within this segment
    startTime += dur * 1000;
    index++;
  }
  return { index, startTime };
}

export class TimerEngine {
  /**
   * @param {object} callbacks
   * @param {function} callbacks.onSegmentStart  (seg, index) => void
   * @param {function} callbacks.onTick          ({ secondsLeft, elapsedInSegment, segmentIndex, isManual }) => void
   * @param {function} callbacks.onComplete      (totalElapsedSeconds) => void
   */
  constructor(callbacks = {}) {
    this.callbacks    = callbacks;
    this.flatSegments = [];
    this._interval    = null;
    this._visHandler  = null;
    this._reset();
  }

  // ── Public API ───────────────────────────────────────────────

  start(flatSegments) {
    this.stop();
    this.flatSegments    = flatSegments;
    this._totalStartTime = Date.now();
    this._totalPausedMs  = 0;
    this._isPaused       = false;
    this._attachVisibility();
    this._startSegment(0);
  }

  pause() {
    if (!this._running || this._isPaused) return;
    this._isPaused = true;
    this._pausedAt = Date.now();
    clearInterval(this._interval);
  }

  resume() {
    if (!this._isPaused) return;
    const pausedMs       = Date.now() - this._pausedAt;
    this._totalPausedMs += pausedMs;
    this._segStartTime  += pausedMs;   // shift anchor so elapsed stays correct
    this._lastPauseMs    = pausedMs;   // diagnostic
    this._isPaused       = false;
    this._pausedAt       = null;
    this._scheduleInterval();
  }

  restart() {
    const segments = this.flatSegments;
    this.stop();
    this.start(segments);
  }

  stop() {
    clearInterval(this._interval);
    this._detachVisibility();
    this._reset();
  }

  /** Advance a manual ("On Tap") step to the next segment. */
  advanceManual() {
    clearInterval(this._interval);
    this._segIndex++;
    if (this._segIndex >= this.flatSegments.length) this._complete();
    else this._startSegment(this._segIndex);
  }

  /**
   * Restart the current segment from the beginning. Auto-resumes if paused
   * (caller is responsible for syncing the pause-button UI).
   */
  restartSegment() {
    if (!this._running) return;
    clearInterval(this._interval);
    this._isPaused = false;
    this._pausedAt = null;
    this._startSegment(this._segIndex);
  }

  /** Jump to the start of the previous segment. No-op at the first segment. */
  previousSegment() {
    if (!this._running || this._segIndex <= 0) return;
    clearInterval(this._interval);
    this._isPaused = false;
    this._pausedAt = null;
    this._startSegment(this._segIndex - 1);
  }

  /**
   * Jump to the start of the next segment.
   * If already past the last segment, calls onComplete (caller can confirm + endPace).
   */
  nextSegment() {
    if (!this._running) return;
    clearInterval(this._interval);
    this._isPaused = false;
    this._pausedAt = null;
    this._segIndex++;
    if (this._segIndex >= this.flatSegments.length) this._complete();
    else this._startSegment(this._segIndex);
  }

  // ── Getters ──────────────────────────────────────────────────

  get isPaused()      { return this._isPaused; }
  get segmentIndex()  { return this._segIndex;  }
  get isRunning()     { return this._running; }
  get segDuration()   { return this._segDuration; }
  get isManual()      { return this._running && this._segDuration === 0; }

  /** Seconds elapsed in the current segment (frozen while paused). */
  get elapsedInSegment() {
    if (!this._segStartTime) return 0;
    const ref = (this._isPaused && this._pausedAt) ? this._pausedAt : Date.now();
    return Math.max(0, (ref - this._segStartTime) / 1000);
  }

  get totalElapsedSeconds() {
    if (!this._running || !this._totalStartTime) return 0;
    return Math.floor((Date.now() - this._totalStartTime - this._totalPausedMs) / 1000);
  }

  /**
   * Dev diagnostic snapshot for UI-vs-audio sync analysis (not used in normal
   * operation). activeMs = active (un-paused) ms since pace start; segMs = active
   * ms into the current segment; lastPauseMs = the most recent resume's shift.
   */
  get debugInfo() {
    const now = Date.now();
    const inPause = (this._isPaused && this._pausedAt) ? now - this._pausedAt : 0;
    return {
      seg:         this._segIndex,
      segMs:       this._segStartTime   ? Math.round(now - this._segStartTime - inPause) : 0,
      activeMs:    this._totalStartTime ? Math.round(now - this._totalStartTime - this._totalPausedMs - inPause) : 0,
      lastPauseMs: Math.round(this._lastPauseMs || 0),
      paused:      this._isPaused,
    };
  }

  // ── Private ──────────────────────────────────────────────────

  _reset() {
    this._running        = false;
    this._isPaused       = false;
    this._segIndex       = 0;
    this._segStartTime   = null;
    this._segDuration    = 0;
    this._totalStartTime = null;
    this._totalPausedMs  = 0;
    this._pausedAt       = null;
    this._lastPauseMs    = 0;   // diagnostic: ms shifted by the most recent resume
  }

  /**
   * @param {number} idx
   * @param {number} [startTime]  Absolute wall-clock start for this segment. A
   *   natural advance passes the previous segment's exact end (anchor + duration)
   *   so the UI rides the same fixed timeline as the native audio and never
   *   accumulates polling/`setInterval` slip. Defaults to "now" for fresh anchors
   *   (pace start, manual advance, user jumps, background recovery).
   */
  _startSegment(idx, startTime = Date.now()) {
    const seg = this.flatSegments[idx];
    if (!seg) { this._complete(); return; }

    clearInterval(this._interval);
    this._segIndex     = idx;
    this._segDuration  = seg.duration || 0;
    this._segStartTime = startTime;
    this._running      = true;

    this.callbacks.onSegmentStart?.(seg, idx);
    this._scheduleInterval();
  }

  /** 250 ms heartbeat — finer than 1 s for smoother progress + accurate boundary crossing. */
  _scheduleInterval() {
    const seg = this.flatSegments[this._segIndex];
    this._interval = setInterval(
      () => (seg?.duration === 0 ? this._tickManual() : this._tick()),
      250,
    );
  }

  _tick() {
    if (this._isPaused) return;
    const elapsedInSegment = (Date.now() - this._segStartTime) / 1000;
    const secondsLeft      = Math.max(0, this._segDuration - elapsedInSegment);

    this.callbacks.onTick?.({
      secondsLeft,
      elapsedInSegment,
      segmentIndex: this._segIndex,
      isManual: false,
    });

    if (secondsLeft <= 0) this._advance();
  }

  _tickManual() {
    if (this._isPaused) return;
    const elapsedInSegment = (Date.now() - this._segStartTime) / 1000;

    this.callbacks.onTick?.({
      secondsLeft:      0,
      elapsedInSegment,
      segmentIndex: this._segIndex,
      isManual: true,
    });
  }

  _advance() {
    clearInterval(this._interval);
    // Anchor the next segment to this one's exact end — not Date.now() at
    // detection time — so polling latency can't compound into UI-vs-audio drift.
    const nextStartTime = this._segStartTime + this._segDuration * 1000;
    this._segIndex++;
    if (this._segIndex >= this.flatSegments.length) {
      this._complete();
    } else {
      // One animation frame before starting the next segment so the browser
      // can paint the 100% / "0:00" final state of the segment that just ended.
      requestAnimationFrame(() => this._startSegment(this._segIndex, nextStartTime));
    }
  }

  _complete() {
    // Read totalElapsedSeconds BEFORE _running flips to false — the getter
    // short-circuits to 0 when !this._running, so reading after the flip
    // would hand onComplete an incorrect 0.
    const total = this.totalElapsedSeconds;
    clearInterval(this._interval);
    this._running = false;
    this._detachVisibility();
    this.callbacks.onComplete?.(total);
  }

  // ── Background / Foreground Recovery ────────────────────────

  _attachVisibility() {
    this._visHandler = () => this._onVisibilityChange();
    document.addEventListener('visibilitychange', this._visHandler);
  }

  _detachVisibility() {
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
  }

  /**
   * When the app returns to the foreground, walk forward through segments
   * using wall-clock time to find where we actually are now.
   * Any timed segments that completed while backgrounded are skipped;
   * the engine resumes from the correct position with accurate timestamps.
   */
  _onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    if (!this._running || this._isPaused) return;

    // Walk forward (same absolute-timeline math the normal advance uses) to find
    // where wall-clock time actually places us after being backgrounded.
    const { index, startTime } = resolveActiveSegment(
      this._segIndex, this._segStartTime, this.flatSegments, Date.now());

    if (index >= this.flatSegments.length) {
      this._complete();
      return;
    }

    if (index !== this._segIndex) {
      // Jumped one or more segments while backgrounded — resume at the right spot,
      // anchored to the segment's true start so it stays in lockstep with audio.
      this._startSegment(index, startTime);
    }
    // Same segment → _tick() already reads wall-clock from _segStartTime.
  }
}
