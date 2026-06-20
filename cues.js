/* ============================================================
   cues.js — Voice cue scheduler.
   Queues speech utterances, prevents duplicates, handles
   protected/countdown priority, and cleans up gracefully.
   ============================================================ */

export class CueScheduler {
  constructor() {
    this._voiceName  = '';
    this._queue      = [];
    this._busy       = false;
    this._fired      = new Set();   // cue keys already spoken this segment
    this._currentSeg = null;
    this._speakFn    = null;        // injectable native TTS function (text) => Promise<void>
    this._stopFn     = null;        // injectable native TTS stop function () => Promise<void>
    this._speechToken = 0;          // identifies the active utterance; stale completions are ignored
    this._currentIsCountdown = false; // is the currently-speaking utterance a countdown number?
  }

  // ── Configuration ────────────────────────────────────────────

  setVoice(name) {
    this._voiceName = name || '';
  }

  /**
   * Inject a native speak function.
   * When set, the scheduler uses fn(text) instead of speechSynthesis.
   * fn must return a Promise that resolves when speech is complete.
   * Pass null to revert to web speechSynthesis.
   * @param {((text: string) => Promise<void>) | null} fn
   * @param {(() => Promise<void>) | null} stopFn  Called to cancel in-progress speech.
   */
  setSpeakFn(fn, stopFn = null) {
    this._speakFn = fn ?? null;
    this._stopFn  = stopFn ?? null;
  }

  // ── Segment lifecycle ────────────────────────────────────────

  /**
   * Call when a new segment starts.
   * Clears the fired-cue record and speaks the opening cue immediately.
   */
  arm(seg) {
    this._fired.clear();
    this._currentSeg = seg;
    const cue  = seg.voiceCues?.[0];
    const text = cue?.text ? cue.text : seg.name;
    if (text) this._enqueue(text);   // opening cue — protected
  }

  /**
   * Call on every timer tick with elapsed seconds in the current segment.
   * Fires any additional voice cues whose offset has been reached.
   * Uses >= so ticks missed while backgrounded catch up automatically.
   */
  tick(elapsedSeconds) {
    if (!this._currentSeg?.voiceCues) return;
    for (const cue of this._currentSeg.voiceCues.slice(1)) {
      const key = cue.id ?? `${cue.offsetSeconds}:${cue.text}`;
      if (!this._fired.has(key) && elapsedSeconds >= cue.offsetSeconds && cue.text) {
        this._fired.add(key);
        this._enqueue(cue.text);
      }
    }
  }

  /**
   * Call from onTick to speak countdown numbers (e.g. "5, 4, 3, 2, 1").
   * Each number is spoken at most once per segment via the fired-cue set.
   *
   * A countdown number fires ONLY when nothing is currently speaking.  If
   * anything is in progress — a protected cue OR another countdown number — this
   * number is skipped (and marked fired so the next tick moves to the next-lower
   * number).  A countdown spoken late would be misleading, so we drop it rather
   * than play it behind schedule or interrupt another number.
   *
   * @param {number} secondsLeft  Fractional seconds remaining.
   * @param {number} threshold    Speak numbers from this value down to 1.
   */
  countdown(secondsLeft, threshold) {
    const n = Math.ceil(secondsLeft);
    if (n > 0 && n <= threshold) {
      const key = `cd:${n}`;
      if (!this._fired.has(key)) {
        this._fired.add(key);
        if (this._busy) return;   // anything speaking → skip; never late, never interrupting
        this._enqueue(String(n), true);
      }
    }
  }

  // ── Direct speech ────────────────────────────────────────────

  /** Speak arbitrary text as a protected cue (e.g. the completion announcement). */
  speak(text) {
    this._enqueue(text);
  }

  /** Cancel everything and silence the synthesiser. */
  stop() {
    if (this._stopFn) {
      this._stopFn().catch(() => {});
    } else {
      window.speechSynthesis?.cancel();
    }
    this._speechToken++;   // invalidate any in-flight utterance's pending completion
    this._queue      = [];
    this._busy       = false;
    this._fired.clear();
    this._currentSeg = null;
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Queue a cue for speech under the protected/countdown priority model:
   *
   *   Protected cue (opening, extra, completion — isCountdown=false): takes
   *   priority. If a COUNTDOWN number is currently speaking, cancel it so this
   *   cue takes over. If a PROTECTED cue is speaking, queue behind it (FIFO) —
   *   protected cues never cut each other off.
   *
   *   Countdown number (isCountdown=true): only ever reaches here when
   *   countdown() has confirmed silence, so it simply speaks. Countdowns never
   *   interrupt and never sit queued behind anything.
   */
  _enqueue(text, isCountdown = false) {
    if (!text) return;

    if (!isCountdown && this._busy && this._currentIsCountdown) {
      // Protected cue supersedes a countdown number that's mid-word.
      if (this._stopFn) this._stopFn().catch(() => {});
      else              window.speechSynthesis?.cancel();
      this._busy = false;   // the cancelled utterance's stale completion is ignored via _speechToken
    }

    this._queue.push({ text, isCountdown });
    this._flush();
  }

  _flush() {
    if (this._busy || !this._queue.length) return;

    const { text, isCountdown } = this._queue.shift();
    this._busy = true;
    this._currentIsCountdown = isCountdown;
    // Token guards against stale completion callbacks.  When a high-priority cue
    // cancels an in-flight utterance, that utterance's onend/onerror (or the
    // native promise) still fires asynchronously afterward.  Without this guard
    // it would clobber _busy=false even though a newer utterance is now active —
    // which let countdown numbers enqueue and play late behind the new cue
    // (Chrome's documented cancel/onend race, confirmed in the box-breathing logs).
    const myToken = ++this._speechToken;
    const done    = () => { if (myToken === this._speechToken) { this._busy = false; this._flush(); } };

    if (this._speakFn) {
      // Native TTS path — chains via Promise resolution
      this._speakFn(text).then(done, done);
      return;
    }

    // Web Speech API path
    const synth = window.speechSynthesis;
    if (!synth) { this._busy = false; return; }

    const u  = new SpeechSynthesisUtterance(text);
    u.rate   = 1.1;
    u.pitch  = 1.0;
    u.volume = 1.0;

    if (this._voiceName) {
      const voice = synth.getVoices().find(v => v.name === this._voiceName);
      if (voice) u.voice = voice;
    }

    u.onend   = done;
    u.onerror = done;
    synth.speak(u);
  }
}
