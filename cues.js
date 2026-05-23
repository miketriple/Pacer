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
  }

  // ── Configuration ────────────────────────────────────────────

  setVoice(name) {
    this._voiceName = name || '';
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
   * @param {number} secondsLeft  Fractional seconds remaining.
   * @param {number} threshold    Speak numbers from this value down to 1.
   */
  countdown(secondsLeft, threshold) {
    const n = Math.ceil(secondsLeft);
    if (n > 0 && n <= threshold) {
      const key = `cd:${n}`;
      if (!this._fired.has(key)) {
        this._fired.add(key);
        this._enqueue(String(n), 'high');
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
    window.speechSynthesis?.cancel();
    this._queue      = [];
    this._busy       = false;
    this._fired.clear();
    this._currentSeg = null;
  }

  // ── Private ──────────────────────────────────────────────────

  _enqueue(text, priority = 'normal') {
    if (!text) return;

    if (priority === 'high') {
      // Cancel whatever is speaking now, drop queued normal-priority items
      window.speechSynthesis?.cancel();
      this._busy  = false;
      this._queue = this._queue.filter(i => i.priority === 'high');
      this._queue.unshift({ text, priority });
    } else {
      this._queue.push({ text, priority });
    }

    this._flush();
  }

  _flush() {
    const synth = window.speechSynthesis;
    if (!synth || this._busy || !this._queue.length) return;

    const { text } = this._queue.shift();
    const u        = new SpeechSynthesisUtterance(text);
    u.rate  = 1.1;
    u.pitch = 1.0;
    u.volume = 1.0;

    if (this._voiceName) {
      const voice = synth.getVoices().find(v => v.name === this._voiceName);
      if (voice) u.voice = voice;
    }

    this._busy = true;
    u.onend   = () => { this._busy = false; this._flush(); };
    u.onerror = () => { this._busy = false; this._flush(); };
    synth.speak(u);
  }
}
