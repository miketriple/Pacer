/* ============================================================
   cues.js — Voice cue scheduler.
   Queues speech utterances, prevents duplicates, handles
   high-priority interrupts (countdowns), and cleans up gracefully.
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
    if (text) this._enqueue(text, 'high');
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
   * Countdown numbers YIELD to a protected cue (the opening instruction or a
   * user-set extra) that's still speaking — instructions take priority.  But a
   * countdown does NOT yield to another COUNTDOWN number: "1 second left" is
   * more accurate than "2 seconds left", so the newer, lower number interrupts
   * the older one still playing.  The slot is "use it or lose it": we mark it
   * fired so the next tick moves to the next-lower number rather than retrying
   * this one late.
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
        // Yield only to a protected (non-countdown) cue.  If a previous
        // countdown number is still playing, fall through — _enqueue('high')
        // interrupts it so the more-current number wins.
        if (this._busy && !this._currentIsCountdown) return;
        this._enqueue(String(n), 'high', true);
      }
    }
  }

  // ── Direct speech ────────────────────────────────────────────

  /** Speak arbitrary text at high priority (interrupts normal-priority queue). */
  speak(text) {
    this._enqueue(text, 'high');
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

  _enqueue(text, priority = 'normal', isCountdown = false) {
    if (!text) return;

    if (priority === 'high') {
      // Cancel whatever is speaking now, drop queued normal-priority items
      if (this._stopFn) {
        this._stopFn().catch(() => {});
      } else {
        window.speechSynthesis?.cancel();
      }
      this._busy  = false;
      this._queue = this._queue.filter(i => i.priority === 'high');
      this._queue.unshift({ text, priority, isCountdown });
    } else {
      this._queue.push({ text, priority, isCountdown });
    }

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
