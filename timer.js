/* ============================================================
   timer.js — Timestamp-based timer engine.
   Owns no DOM. Communicates entirely via callbacks.
   Survives mobile backgrounding by anchoring to wall-clock time.
   ============================================================ */

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

  get totalElapsedSeconds() {
    if (!this._running || !this._totalStartTime) return 0;
    return Math.floor((Date.now() - this._totalStartTime - this._totalPausedMs) / 1000);
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
  }

  _startSegment(idx) {
    const seg = this.flatSegments[idx];
    if (!seg) { this._complete(); return; }

    clearInterval(this._interval);
    this._segIndex     = idx;
    this._segDuration  = seg.duration || 0;
    this._segStartTime = Date.now();
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
    this._segIndex++;
    if (this._segIndex >= this.flatSegments.length) {
      this._complete();
    } else {
      // One animation frame before starting the next segment so the browser
      // can paint the 100% / "0:00" final state of the segment that just ended.
      requestAnimationFrame(() => this._startSegment(this._segIndex));
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

    const now    = Date.now();
    let idx      = this._segIndex;
    let anchor   = this._segStartTime;

    // Walk forward through any segments that would have completed
    while (idx < this.flatSegments.length) {
      const seg     = this.flatSegments[idx];
      if (seg.duration === 0) break;                      // manual step — stop here
      const elapsed = (now - anchor) / 1000;
      if (elapsed < seg.duration)  break;                 // still in this segment
      anchor += seg.duration * 1000;
      idx++;
    }

    if (idx >= this.flatSegments.length) {
      this._complete();
      return;
    }

    if (idx !== this._segIndex) {
      // Jumped one or more segments while backgrounded — resume at the right spot
      this._segIndex    = idx;
      this._segDuration = this.flatSegments[idx].duration || 0;
      this._segStartTime = anchor;
      clearInterval(this._interval);
      this.callbacks.onSegmentStart?.(this.flatSegments[idx], idx);
      this._scheduleInterval();
    }
    // If same segment, no action needed — _tick() already reads from wall-clock time
  }
}
