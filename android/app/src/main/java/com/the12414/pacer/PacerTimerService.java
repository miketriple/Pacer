package com.the12414.pacer;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Android Foreground Service that runs the Pacer cue schedule natively.
 *
 * Why a Foreground Service?
 *   Android throttles JavaScript timers in a WebView when the screen locks.
 *   This service runs outside the WebView — it receives a pre-computed cue
 *   schedule from JavaScript, dispatches each cue at the right time, and
 *   speaks via Android TTS.  The result: voice cues fire correctly even
 *   with the screen locked.
 *
 * Hybrid cue scheduling (for long-running paces):
 *   Cues within HANDLER_WINDOW_MS of now are posted to a Handler — precise,
 *   low-overhead, reliable while the service is alive.
 *   Cues beyond that horizon are scheduled via AlarmManager.setExactAndAllow-
 *   WhileIdle, which is Doze-safe and survives the OS killing the service
 *   between cues.  When such an alarm fires, the service is (re-)started
 *   with ACTION_SPEAK_CUE and speaks the carried text.
 *
 * Anchored fire times (added for accuracy):
 *   paceStartAnchorMs is recorded the moment ACTION_START arrives.  Every
 *   cue has an immutable absolute fire time = anchor + delayMs.  Scheduling
 *   computes (fireAt - now) per cue, so any delay (TTS init, IPC, GC) is
 *   absorbed naturally — never propagated to other cues.
 *
 * Gap-aware TTS warmup:
 *   TTS engines unload after ~30–60s of silence.  When scheduling cues we
 *   look at the gap from each cue to the previous one; if it exceeds
 *   WARMUP_GAP_MS, we insert a silent playSilentUtterance pulse
 *   WARMUP_LEAD_MS before the cue, warming the engine so the real cue
 *   speaks promptly.  Dense paces get zero warmups; sparse paces get one
 *   per gap.  Warmups do NOT request audio focus, so music is not ducked.
 *
 * Explicit audio focus:
 *   Each real cue requests AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK before
 *   speaking and releases it FOCUS_RELEASE_DELAY_MS after UtteranceProgress-
 *   Listener.onDone.  Back-to-back cues (e.g. "5, 4, 3, 2, 1") cancel any
 *   pending release and hold focus continuously instead of un-ducking
 *   between numbers.
 *
 * WakeLock refresh:
 *   A PARTIAL_WAKE_LOCK is acquired with a 1-hour timeout and re-acquired by
 *   a Handler task every 50 minutes — so paces running for many hours stay
 *   on the CPU even if the OS expires individual lock acquisitions.
 *
 * Android 15+ note:
 *   Apps targeting API 35+ must have an active MediaSession to use the
 *   FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK type.  We create a minimal
 *   MediaSession with STATE_PLAYING when the pace starts and release it
 *   when it stops.
 */
public class PacerTimerService extends Service {

    public static final String ACTION_START       = "START";
    public static final String ACTION_STOP        = "STOP";
    public static final String ACTION_SPEAK_CUE   = "SPEAK_CUE";    // fired by AlarmManager (real cue)
    public static final String ACTION_WARMUP_TTS  = "WARMUP_TTS";   // fired by AlarmManager (silent pre-warm)
    public static final String EXTRA_CUES         = "cues";
    public static final String EXTRA_PACE_NAME    = "paceName";
    public static final String EXTRA_CUE_TEXT     = "cueText";
    public static final String EXTRA_MID_BURST    = "midBurst";   // hint for audio-focus release timing
    public static final String EXTRA_SKIP_IF_BUSY = "skipIfBusy"; // drop this cue if TTS is already speaking
    public static final String EXTRA_SCHEDULE_ID  = "scheduleId"; // run id; alarms with a stale id are dropped

    private static final String CHANNEL_ID      = "pacer_timer";
    private static final int    NOTIFICATION_ID = 1;
    private static final String TAG             = "PacerTimerService";
    /** SharedPreferences marker for the currently-active run id, so a service
     *  reborn by an alarm can tell a current cue from a stale one. */
    private static final String PREFS_NAME      = "pacer_timer_prefs";
    private static final String KEY_RUN_ID      = "currentRunId";

    /** Cues within this horizon use Handler.postDelayed; beyond it, AlarmManager. */
    private static final long   HANDLER_WINDOW_MS    = 10L * 60 * 1000;      // 10 min
    /** WakeLock individual acquisition timeout. */
    private static final long   WAKELOCK_DURATION_MS = 60L * 60 * 1000;      // 1 hour
    /** Period at which we re-acquire the WakeLock so it never lapses mid-pace. */
    private static final long   WAKELOCK_REFRESH_MS  = 50L * 60 * 1000;      // 50 min

    /** A silence of this length means the TTS engine may have unloaded; insert a warmup. */
    private static final long   WARMUP_GAP_MS    = 60L * 1000;       // 60 s
    /** How far ahead of a cold cue the silent warmup pulse fires. */
    private static final long   WARMUP_LEAD_MS   = 1500L;            // 1.5 s
    /** Grace before releasing audio focus when MORE cues are coming soon ("mid-burst").
     *  Wide enough to bridge a countdown's ~1 s gaps without un-ducking between numbers. */
    private static final long   FOCUS_RELEASE_DELAY_MS = 1500L;      // 1.5 s
    /** Grace before releasing audio focus when no further cue is coming soon ("last-in-burst").
     *  Music recovers quickly after standalone cues and after the final cue of a burst. */
    private static final long   FOCUS_SHORT_RELEASE_MS = 200L;       // 0.2 s
    /** A pair of cues whose fire times are within this gap are considered the same "burst".
     *  Determines which release grace each cue gets at schedule time. */
    private static final long   BURST_THRESHOLD_MS     = 2000L;      // 2 s

    private String                 pendingCuesJson = null;     // held until TTS is ready
    private String                 pendingCuesPaceName = null; // paceName tied to pendingCuesJson
    private String                 pendingSpeakText = null;    // SPEAK_CUE arrived before TTS ready
    private final Handler          handler         = new Handler(Looper.getMainLooper());
    /** Token tagging all cue (and warmup) Handler callbacks, so scheduleCues can
     *  clear ONLY cue callbacks without also wiping the wake-lock refresh and
     *  audio-focus release tasks that share this handler. */
    private final Object           CUE_TOKEN       = new Object();
    private PowerManager.WakeLock  wakeLock;
    private Runnable               wakeLockRefresh;          // periodic re-acquire task
    private MediaSession           mediaSession;             // required for mediaPlayback type on API 35+
    private AlarmManager           alarmManager;
    private AudioManager           audioManager;
    /** PendingIntents for AlarmManager-scheduled cues, kept so we can cancel them on stop. */
    private final List<PendingIntent> pendingAlarms = new ArrayList<>();
    /** Monotonic counter to give each alarm PendingIntent a unique request code. */
    private int                    nextAlarmReqCode = 1000;

    /** Anchor for absolute cue fire times.  Set at the moment ACTION_START arrives;
     *  every cue's fireAt = paceStartAnchorMs + delayMs.  This is the single source
     *  of truth for cue timing — never shifted by TTS init or scheduling latency. */
    private long                   paceStartAnchorMs = 0;
    /** Elapsed-realtime ms of the most recent speak()/warmupTts() — used by
     *  scheduleCues to detect long silences that would let TTS go cold. */
    private long                   lastSpeakTimeMs   = 0;
    /** Our own "is a cue currently speaking" flag, set synchronously in speak()
     *  and cleared by the UtteranceProgressListener.  Used instead of
     *  tts.isSpeaking() for the skipIfBusy check — isSpeaking() has a >60 ms
     *  race window after speak() where it still reports false, which let
     *  countdown numbers QUEUE_FLUSH-cancel an opening cue on the first
     *  (cold-engine) cycle.  volatile: cleared from a TTS worker thread. */
    private volatile boolean       ourSpeaking       = false;
    /** True once startForeground() has been called in this process lifetime.
     *  Lets a stale alarm tell "I cold-started this service" (must satisfy the
     *  foreground contract before quitting) from "a pace is already running"
     *  (just ignore the stale alarm). */
    private boolean                isForeground      = false;

    // ── Audio focus state (per-utterance ducking) ────────────────
    /** True while we currently hold audio focus (music is ducked). */
    private boolean                audioFocusHeld = false;
    /** The current AudioFocusRequest (API 26+) so we can abandon it precisely. */
    private AudioFocusRequest      currentFocusRequest;
    /** Pending "release audio focus" task; cancelled when another cue starts. */
    private final Runnable         releaseFocusRunnable = this::releaseAudioFocusNow;

    // ── Lifecycle ────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "onCreate");
        TtsHolder.init(this);   // fallback init (e.g. alarm rebirth where the activity never ran)
        alarmManager = (AlarmManager) getSystemService(ALARM_SERVICE);
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        warnIfExactAlarmsBlocked();
        createNotificationChannel();
        acquireWakeLock();
    }

    /**
     * On Android 12+ (API 31), SCHEDULE_EXACT_ALARM must be granted in system
     * Settings before setExactAndAllowWhileIdle will work.  We log a clear
     * warning if it's missing so far-horizon cues can be diagnosed quickly.
     */
    private void warnIfExactAlarmsBlocked() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarmManager != null
                && !alarmManager.canScheduleExactAlarms()) {
            Log.w(TAG, "Exact alarms NOT permitted — grant in Settings → Apps → " +
                       "Special app access → Alarms & reminders.  Cues > " +
                       (HANDLER_WINDOW_MS / 60000) + " min may fire late or be skipped.");
        }
    }

    // ── Run-id staleness ─────────────────────────────────────────
    // Each pace run is stamped with an id (paceStartAnchorMs).  Every alarm
    // carries it; a service reborn by an alarm drops any alarm whose id doesn't
    // match the active run.  This is robust regardless of whether AlarmManager's
    // cancellation matched the old alarms, so old cues can't fire over a new pace.

    /** Persist the active run id so a service reborn by an alarm can compare. */
    private void persistRunId(long id) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putLong(KEY_RUN_ID, id).apply();
    }

    /** The currently-active run id: the in-memory anchor if a pace is running in
     *  this process, else the persisted value (for a freshly-reborn service). */
    private long currentRunId() {
        if (paceStartAnchorMs > 0) return paceStartAnchorMs;
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getLong(KEY_RUN_ID, 0);
    }

    /** True if the alarm is a leftover from a previous run (or no pace is active),
     *  so it should fire nothing. */
    private boolean isStaleAlarm(Intent intent) {
        long alarmRunId = intent.getLongExtra(EXTRA_SCHEDULE_ID, 0);
        long current    = currentRunId();
        return current == 0 || alarmRunId != current;
    }

    /** When an alarm rebirths the service (no in-memory anchor yet), adopt the
     *  alarm's run id as our anchor so subsequent in-process logic is consistent.
     *  Only called after isStaleAlarm() confirmed the alarm belongs to this run. */
    private void adoptRunIfReborn(Intent intent) {
        if (paceStartAnchorMs == 0) {
            paceStartAnchorMs = intent.getLongExtra(EXTRA_SCHEDULE_ID, 0);
        }
    }

    /**
     * Deal with a stale alarm.  If it cold-started this service (we aren't
     * foreground yet), we were launched via getForegroundService and MUST call
     * startForeground() before quitting — so we satisfy the contract briefly,
     * then shut down.  If a pace is already running, we simply ignore it.
     */
    private void handleStaleAlarm(Intent intent) {
        if (!isForeground) {
            String paceName = intent.getStringExtra(EXTRA_PACE_NAME);
            startForegroundCompat(paceName != null ? paceName : "Pacer");
            stopEverything();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            Log.w(TAG, "onStartCommand: null intent — returning NOT_STICKY");
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        Log.d(TAG, "onStartCommand action=" + action);

        if (ACTION_START.equals(action)) {
            // Anchor the absolute cue clock to RIGHT NOW — before any other work,
            // so TTS init / IPC / GC delays can't shift it.  This is the single
            // source of truth for all cue fire times in this pace, and doubles as
            // this run's id: every alarm carries it, and a reborn service drops
            // any alarm whose id doesn't match the persisted current run.
            paceStartAnchorMs = SystemClock.elapsedRealtime();
            persistRunId(paceStartAnchorMs);

            String paceName = intent.getStringExtra(EXTRA_PACE_NAME);
            if (paceName == null) paceName = "Pacer";

            // Create a MediaSession BEFORE startForeground so Android 15+ accepts
            // the FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK type without throwing.
            setupMediaSession();
            startForegroundCompat(paceName);

            String cuesJson = intent.getStringExtra(EXTRA_CUES);
            if (cuesJson != null) {
                if (TtsHolder.isReady()) {
                    attachTtsListener();
                    scheduleCues(cuesJson, paceName);
                } else {
                    // Shared engine still initialising (only possible if a pace
                    // starts within ~1 s of a cold app launch) — flush when ready.
                    Log.d(TAG, "TTS not ready yet — deferring " + cuesJson.length() + " bytes of cues");
                    pendingCuesJson     = cuesJson;
                    pendingCuesPaceName = paceName;
                    TtsHolder.runWhenReady(this::onTtsReadyFlush);
                }
            } else {
                Log.w(TAG, "No cues JSON in intent");
            }

        } else if (ACTION_WARMUP_TTS.equals(action)) {
            // Fired by an AlarmManager warmup alarm.  May have rebirthed the service.
            if (isStaleAlarm(intent)) {
                Log.d(TAG, "Dropping stale WARMUP alarm");
                handleStaleAlarm(intent);
                return START_NOT_STICKY;
            }
            adoptRunIfReborn(intent);
            String paceName = intent.getStringExtra(EXTRA_PACE_NAME);
            if (paceName == null) paceName = "Pacer";
            setupMediaSession();
            startForegroundCompat(paceName);
            // If TTS is already warm, a quick silent pulse keeps it that way.
            // If not (rare cold rebirth), init is already underway — that IS the
            // warmup, so there's nothing more to do.
            if (TtsHolder.isReady()) { attachTtsListener(); warmupTts(); }

        } else if (ACTION_SPEAK_CUE.equals(action)) {
            // Fired by an AlarmManager alarm for a far-horizon cue.  The service
            // may have been killed and just re-spawned by the OS to handle this —
            // so make sure we're in foreground with the right notification first.
            if (isStaleAlarm(intent)) {
                Log.d(TAG, "Dropping stale SPEAK_CUE: " + intent.getStringExtra(EXTRA_CUE_TEXT));
                handleStaleAlarm(intent);
                return START_NOT_STICKY;
            }
            adoptRunIfReborn(intent);
            String paceName = intent.getStringExtra(EXTRA_PACE_NAME);
            if (paceName == null) paceName = "Pacer";
            setupMediaSession();
            startForegroundCompat(paceName);

            String text = intent.getStringExtra(EXTRA_CUE_TEXT);
            boolean midBurst   = intent.getBooleanExtra(EXTRA_MID_BURST,   false);
            boolean skipIfBusy = intent.getBooleanExtra(EXTRA_SKIP_IF_BUSY, false);
            if (text != null) {
                if (TtsHolder.isReady()) {
                    attachTtsListener();
                    speak(text, midBurst, skipIfBusy);
                } else {
                    // Shared engine still initialising — speak once it's ready.
                    Log.d(TAG, "TTS not ready — deferring SPEAK_CUE: " + text);
                    pendingSpeakText = text;
                    TtsHolder.runWhenReady(this::onTtsReadyFlush);
                }
            } else {
                Log.w(TAG, "SPEAK_CUE intent missing " + EXTRA_CUE_TEXT);
            }

        } else if (ACTION_STOP.equals(action)) {
            stopEverything();
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        handler.removeCallbacksAndMessages(null);
        // NOTE: do NOT shut down the TTS engine — it is shared and app-lifetime
        // (TtsHolder). Shutting it down here would re-introduce the per-pace cold
        // init, and would also kill audio for a pace still running in the
        // background when the activity is destroyed.
        releaseWakeLock();
        releaseMediaSession();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ── Cue scheduling ──────────────────────────────────────────

    /**
     * Parse the JSON cue schedule and dispatch each cue at its absolute fire
     * time (anchored to paceStartAnchorMs).  Inserts a silent TTS warmup pulse
     * before any cue that follows a long quiet stretch.
     *
     * Each cue's fireAt = paceStartAnchorMs + delayMs.  Scheduling computes
     * (fireAt - now) so any delay (TTS init, scheduling latency) is absorbed
     * locally — never propagated to other cues.
     */
    private void scheduleCues(String cuesJson, String paceName) {
        handler.removeCallbacksAndMessages(CUE_TOKEN);   // clear prior cues only — NOT wake-lock refresh
        cancelAllAlarms();
        ourSpeaking = false;   // fresh chunk — clear any stuck flag from a prior chunk's tts.stop()
        try {
            JSONArray arr = new JSONArray(cuesJson);
            int handlerCount = 0, alarmCount = 0, warmupCount = 0;

            // Starting reference for the gap-warmup check: the most recent moment
            // the TTS engine was active.  Set in onInit when TTS becomes ready and
            // updated by every speak()/warmupTts() — so it always reflects "the
            // engine was warm at this time."  If never set (defensive), fall back
            // to the pace anchor.
            long previousFireAt = lastSpeakTimeMs > 0 ? lastSpeakTimeMs : paceStartAnchorMs;
            long now            = SystemClock.elapsedRealtime();

            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj         = arr.getJSONObject(i);
                long         delayMs     = obj.getLong("delayMs");
                final String text        = obj.getString("text");
                final boolean skipIfBusy = obj.optBoolean("skipIfBusy", false);

                // The cue's true moment in time.  Immutable; the source of truth.
                long fireAt = paceStartAnchorMs + delayMs;

                // If TTS may have gone cold since the previous fire, queue a silent
                // pulse WARMUP_LEAD_MS before this cue.  Skip if the warmup would
                // land before the previous fire (no room to fit it in).
                long gapMs = fireAt - previousFireAt;
                if (gapMs > WARMUP_GAP_MS) {
                    long warmupAt = fireAt - WARMUP_LEAD_MS;
                    if (warmupAt > previousFireAt) {
                        scheduleAt(warmupAt, ACTION_WARMUP_TTS, null, paceName, now, /*midBurst*/ false, /*skipIfBusy*/ false);
                        warmupCount++;
                    }
                }

                // Burst hint: is another cue coming soon?  If the next cue is within
                // BURST_THRESHOLD_MS, this cue gets the long focus-release grace so
                // music stays ducked through the gap.  Otherwise this is a "last in
                // burst" cue and gets a short release so music recovers quickly.
                boolean midBurst = false;
                if (i + 1 < arr.length()) {
                    long nextFireAt = paceStartAnchorMs + arr.getJSONObject(i + 1).getLong("delayMs");
                    midBurst = (nextFireAt - fireAt) < BURST_THRESHOLD_MS;
                }

                // The real cue
                if (scheduleAt(fireAt, ACTION_SPEAK_CUE, text, paceName, now, midBurst, skipIfBusy)) {
                    alarmCount++;
                } else {
                    handlerCount++;
                }

                previousFireAt = fireAt;
            }
            Log.d(TAG, "Scheduled " + arr.length() + " cues — " + handlerCount + " Handler, "
                       + alarmCount + " AlarmManager, " + warmupCount + " warmups inserted");
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse cue schedule: " + e.getMessage());
        }
    }

    /**
     * Schedule one event to fire at an absolute elapsed-realtime moment.
     * Returns true if scheduled via AlarmManager (far horizon), false for Handler.
     *
     * @param fireAt      absolute SystemClock.elapsedRealtime() moment to fire at
     * @param action      ACTION_SPEAK_CUE or ACTION_WARMUP_TTS (only used for AlarmManager path)
     * @param text        cue text (null for warmup); only used for AlarmManager path
     * @param paceName    for re-establishing the foreground notification if the alarm rebirths the service
     * @param now         reference "now" (captured once per scheduleCues call for consistency)
     * @param midBurst    true if another cue is coming within BURST_THRESHOLD_MS; controls focus grace
     * @param skipIfBusy  true for countdown numbers — drop this cue if TTS is already speaking
     */
    private boolean scheduleAt(long fireAt, String action, String text, String paceName, long now, boolean midBurst, boolean skipIfBusy) {
        long delayFromNow = Math.max(0, fireAt - now);
        if (delayFromNow < HANDLER_WINDOW_MS) {
            // postAtTime with CUE_TOKEN tags these so scheduleCues can clear cue
            // callbacks without touching the wake-lock refresh / focus-release tasks.
            long triggerAtUptime = SystemClock.uptimeMillis() + delayFromNow;
            if (ACTION_WARMUP_TTS.equals(action)) {
                handler.postAtTime(this::warmupTts, CUE_TOKEN, triggerAtUptime);
            } else {
                final String t = text;
                final boolean mid = midBurst;
                final boolean skip = skipIfBusy;
                handler.postAtTime(() -> speak(t, mid, skip), CUE_TOKEN, triggerAtUptime);
            }
            return false;
        }
        scheduleAlarmAt(fireAt, action, text, paceName, midBurst, skipIfBusy);
        return true;
    }

    /**
     * Set an AlarmManager alarm for an absolute elapsed-realtime moment.
     * Used for both real cues (ACTION_SPEAK_CUE) and warmup pulses (ACTION_WARMUP_TTS).
     */
    private void scheduleAlarmAt(long fireAtElapsedRealtime, String action, String text, String paceName, boolean midBurst, boolean skipIfBusy) {
        if (alarmManager == null) return;
        Intent i = new Intent(this, PacerTimerService.class).setAction(action);
        if (text != null) i.putExtra(EXTRA_CUE_TEXT, text);
        i.putExtra(EXTRA_PACE_NAME, paceName);
        i.putExtra(EXTRA_MID_BURST, midBurst);
        i.putExtra(EXTRA_SKIP_IF_BUSY, skipIfBusy);
        i.putExtra(EXTRA_SCHEDULE_ID, paceStartAnchorMs);   // stamp this run so stale alarms can be dropped

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? PendingIntent.getForegroundService(this, nextAlarmReqCode++, i, flags)
                : PendingIntent.getService(this, nextAlarmReqCode++, i, flags);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, fireAtElapsedRealtime, pi);
            } else {
                alarmManager.setExact(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, fireAtElapsedRealtime, pi);
            }
            pendingAlarms.add(pi);
        } catch (SecurityException e) {
            // SCHEDULE_EXACT_ALARM denied — real cues fall back to inexact so they
            // still fire; warmups are best-effort and skipped if denied.
            if (ACTION_SPEAK_CUE.equals(action)) {
                Log.w(TAG, "Exact alarm denied — falling back to inexact for: " + text);
                alarmManager.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, fireAtElapsedRealtime, pi);
                pendingAlarms.add(pi);
            } else {
                Log.w(TAG, "Warmup alarm denied — skipping");
            }
        }
    }

    /**
     * Cancel every scheduled SPEAK_CUE and WARMUP_TTS alarm.  Handles two cases:
     *   1. Normal: pendingAlarms tracks PendingIntents from this service instance.
     *   2. After rebirth: pendingAlarms is empty, but alarms from a prior
     *      service lifetime may still be queued.  AlarmManager.cancel(pi) cancels
     *      every alarm whose Intent filterEquals — and filterEquals ignores extras
     *      and request codes — so one matching PendingIntent clears them all.
     */
    private void cancelAllAlarms() {
        if (alarmManager == null) return;

        for (PendingIntent pi : pendingAlarms) alarmManager.cancel(pi);
        pendingAlarms.clear();

        // Safety net: cancel any alarms that survived a service rebirth.
        cancelAlarmsByAction(ACTION_SPEAK_CUE);
        cancelAlarmsByAction(ACTION_WARMUP_TTS);
    }

    private void cancelAlarmsByAction(String action) {
        if (alarmManager == null) return;
        Intent matchAll = new Intent(this, PacerTimerService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent matcher = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? PendingIntent.getForegroundService(this, 0, matchAll, flags)
                : PendingIntent.getService(this, 0, matchAll, flags);
        alarmManager.cancel(matcher);
    }

    private void speak(String text, boolean midBurst, boolean skipIfBusy) {
        TextToSpeech tts = TtsHolder.get();
        if (tts == null || !TtsHolder.isReady()) {
            Log.w(TAG, "speak skipped — tts not ready: " + text);
            return;
        }
        // skipIfBusy: countdown numbers yield to whatever is already speaking
        // (opening cue, extra cue, previous countdown number).  Dropping rather
        // than queuing preserves the countdown's time-meaning — "3 seconds
        // left" should not speak when there are 2.4 seconds left.  We check our
        // own flag, not tts.isSpeaking(), because the latter lags speak() by
        // >60 ms on a cold engine and would let the number cancel the cue.
        if (skipIfBusy && ourSpeaking) {
            Log.d(TAG, "speak: " + text + " skipped (busy — yields to higher-priority cue)");
            return;
        }
        Log.d(TAG, "speak: " + text + (midBurst ? " [mid-burst]" : " [last-in-burst]"));
        // EVERY cue holds the busy flag while it speaks — including countdown
        // numbers.  A countdown only fires when nothing is speaking; if a prior
        // number (or a protected cue) is still going, this number skips rather
        // than fire late or interrupt.  Protected cues (skipIfBusy=false) bypass
        // the skip check above, so they still QUEUE_FLUSH-interrupt a countdown.
        // Set synchronously, before tts.speak(), so an immediately-following
        // countdown sees the busy state with no race window.
        ourSpeaking = true;
        // Duck other audio (music, podcasts) for the duration of this cue.
        requestAudioFocus();
        // QUEUE_FLUSH interrupts any in-progress utterance so countdown numbers
        // never pile up behind a long cue.  The utterance-ID prefix carries
        // metadata to the UtteranceProgressListener:
        //   "cue-mid-"  → another cue is coming soon; use the long release grace
        //   "cue-last-" → no near-term follow-up; release focus quickly
        //   "warmup-"   → silent pulse; no focus release at all
        String tag = (midBurst ? "cue-mid-" : "cue-last-") + System.nanoTime();
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, tag);
        lastSpeakTimeMs = SystemClock.elapsedRealtime();
    }

    /**
     * Play a 50 ms silent pulse to keep the TTS engine warm.  No audio focus
     * is requested, so music is not ducked.  If TTS is already mid-speech,
     * the engine is already warm and we skip — nothing useful to do.
     */
    private void warmupTts() {
        TextToSpeech tts = TtsHolder.get();
        if (tts == null || !TtsHolder.isReady()) return;
        if (tts.isSpeaking()) return;     // engine already warm — nothing to do
        Log.d(TAG, "warmup");
        tts.playSilentUtterance(50, TextToSpeech.QUEUE_ADD, "warmup-" + System.nanoTime());
        lastSpeakTimeMs = SystemClock.elapsedRealtime();
    }

    // ── Shared TTS engine wiring ─────────────────────────────────

    /**
     * Utterance callbacks for the shared engine.  Created once per service
     * instance and pointed at the shared engine (via attachTtsListener) when the
     * service starts.  Engine configuration (language, rate, audio attributes)
     * lives in TtsHolder; this listener only carries the per-utterance state the
     * service owns: the ourSpeaking busy flag, audio-focus release, and logging.
     */
    private final UtteranceProgressListener ttsListener = new UtteranceProgressListener() {
        @Override public void onStart(String utteranceId) { /* no-op (was the audio-begins diagnostic) */ }

        @Override public void onDone(String utteranceId) {
            ourSpeaking = false;   // direct (volatile) so a following cue sees it at once
            handler.post(() -> handleUtteranceEnd(utteranceId));
        }

        @Override @Deprecated public void onError(String utteranceId) {
            ourSpeaking = false;
            handler.post(() -> handleUtteranceEnd(utteranceId));
        }

        @Override public void onError(String utteranceId, int errorCode) {
            ourSpeaking = false;
            handler.post(() -> handleUtteranceEnd(utteranceId));
        }

        @Override public void onStop(String utteranceId, boolean interrupted) {
            // interrupted=true means QUEUE_FLUSH from the next speak() — that call
            // already set ourSpeaking=true and handled focus, so we must NOT clear
            // the flag here (doing so would let a skipIfBusy cue wrongly fire over
            // the new utterance).
            if (interrupted) return;
            ourSpeaking = false;
            handler.post(() -> handleUtteranceEnd(utteranceId));
        }
    };

    /** Point the shared engine's utterance callbacks at THIS service instance. */
    private void attachTtsListener() {
        TtsHolder.setListener(ttsListener);
    }

    /**
     * Run when the shared engine becomes ready after a pace or cue arrived while
     * it was still initialising — only possible if a pace starts within ~1 s of a
     * cold app launch.  Attaches our listener and flushes whatever was deferred.
     */
    private void onTtsReadyFlush() {
        attachTtsListener();
        if (pendingCuesJson != null) {
            Log.d(TAG, "TTS ready — flushing deferred cue schedule");
            final String json     = pendingCuesJson;
            final String paceName = pendingCuesPaceName != null ? pendingCuesPaceName : "Pacer";
            pendingCuesJson     = null;
            pendingCuesPaceName = null;
            handler.post(() -> scheduleCues(json, paceName));
        }
        if (pendingSpeakText != null) {
            final String t = pendingSpeakText;
            pendingSpeakText = null;
            Log.d(TAG, "TTS ready — speaking deferred cue: " + t);
            handler.post(() -> speak(t, /*midBurst*/ false, /*skipIfBusy*/ false));
        }
    }

    // ── MediaSession ─────────────────────────────────────────────

    /**
     * Create and activate a MediaSession in STATE_PLAYING.
     * Android 15+ (API 35) requires an active MediaSession for the
     * FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK foreground service type.
     * Without it, startForeground() throws SecurityException and the
     * service crashes before the notification is ever shown.
     */
    private void setupMediaSession() {
        releaseMediaSession();   // clean up any stale session first
        try {
            mediaSession = new MediaSession(this, TAG);
            PlaybackState state = new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY
                              | PlaybackState.ACTION_PAUSE
                              | PlaybackState.ACTION_STOP)
                    .setState(PlaybackState.STATE_PLAYING,
                              PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                    .build();
            mediaSession.setPlaybackState(state);
            mediaSession.setActive(true);
            Log.d(TAG, "MediaSession created and active");
        } catch (Exception e) {
            Log.e(TAG, "Failed to create MediaSession: " + e.getMessage());
            mediaSession = null;
        }
    }

    private void releaseMediaSession() {
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
                mediaSession.release();
                Log.d(TAG, "MediaSession released");
            } catch (Exception e) {
                Log.w(TAG, "Error releasing MediaSession: " + e.getMessage());
            }
            mediaSession = null;
        }
    }

    // ── Wake lock ────────────────────────────────────────────────

    /**
     * PARTIAL_WAKE_LOCK keeps the CPU running with the screen off.  Acquired
     * with a finite timeout (belt-and-suspenders against leaks) and re-acquired
     * by a periodic Handler task so it never lapses mid-pace, no matter how
     * long the pace runs.
     */
    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Pacer::TimerWakeLock");
        }
        wakeLock.acquire(WAKELOCK_DURATION_MS);
        Log.d(TAG, "WakeLock acquired for " + (WAKELOCK_DURATION_MS / 60000) + " min");
        scheduleWakeLockRefresh();
    }

    /** Re-acquire the WakeLock periodically so it outlives its individual timeout. */
    private void scheduleWakeLockRefresh() {
        if (wakeLockRefresh != null) handler.removeCallbacks(wakeLockRefresh);
        wakeLockRefresh = () -> {
            if (wakeLock != null) {
                wakeLock.acquire(WAKELOCK_DURATION_MS);
                Log.d(TAG, "WakeLock refreshed");
            }
            handler.postDelayed(wakeLockRefresh, WAKELOCK_REFRESH_MS);
        };
        handler.postDelayed(wakeLockRefresh, WAKELOCK_REFRESH_MS);
    }

    private void releaseWakeLock() {
        if (wakeLockRefresh != null) {
            handler.removeCallbacks(wakeLockRefresh);
            wakeLockRefresh = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            Log.d(TAG, "WakeLock released");
        }
        wakeLock = null;
    }

    // ── Foreground notification ──────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Pacer Timer", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Pacer pace timer running");
            ch.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
            Log.d(TAG, "Notification channel created/verified");
        }
    }

    private Notification buildNotification(String paceName) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Pacer")
                .setContentText(paceName)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    /**
     * Call startForeground() with the foreground service type on Android 10+
     * (required for API 34+ when mediaPlayback type is declared in the manifest).
     */
    private void startForegroundCompat(String paceName) {
        Notification n = buildNotification(paceName);
        isForeground = true;   // we are committing to foreground (satisfies the start contract)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            Log.d(TAG, "startForeground succeeded for: " + paceName);
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed: " + e.getClass().getSimpleName()
                    + " — " + e.getMessage());
            // Fallback: try without the type parameter (works on API < 34)
            try {
                startForeground(NOTIFICATION_ID, n);
                Log.d(TAG, "startForeground (fallback, no type) succeeded");
            } catch (Exception e2) {
                Log.e(TAG, "startForeground fallback also failed: " + e2.getMessage());
            }
        }
    }

    // ── Shutdown ─────────────────────────────────────────────────

    private void stopEverything() {
        Log.d(TAG, "stopEverything");
        handler.removeCallbacksAndMessages(null);
        cancelAllAlarms();
        paceStartAnchorMs = 0;
        persistRunId(0);   // no active run — any later stale alarm will be dropped
        isForeground = false;
        // Stop any in-progress speech, but do NOT shut the shared engine down —
        // it stays warm for the next pace (TtsHolder).
        TextToSpeech shared = TtsHolder.get();
        if (shared != null) shared.stop();
        ourSpeaking = false;
        releaseAudioFocusNow();
        releaseWakeLock();
        releaseMediaSession();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            //noinspection deprecation
            stopForeground(true);
        }
        stopSelf();
    }

    // ── Audio focus (per-utterance ducking) ──────────────────────

    /**
     * Request transient audio focus with the "may duck" hint, telling music
     * players to lower their volume for the duration of our cue.  Cancels any
     * pending release so consecutive cues (countdowns) hold focus continuously.
     */
    private void requestAudioFocus() {
        handler.removeCallbacks(releaseFocusRunnable);
        if (audioFocusHeld) return;             // already held — keep it
        if (audioManager == null) return;

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            currentFocusRequest = new AudioFocusRequest.Builder(
                            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(false)
                    .build();
            result = audioManager.requestAudioFocus(currentFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                    null, AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
        audioFocusHeld = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        if (audioFocusHeld) Log.d(TAG, "Audio focus granted (ducking)");
        else                Log.w(TAG, "Audio focus denied — music will not duck");
    }

    /** Called from the UtteranceProgressListener when a real cue finishes.
     *  The utterance-ID prefix carries the grace hint set at schedule time:
     *  "cue-mid-" keeps the long grace so music stays ducked through to the
     *  next cue; "cue-last-" uses a short grace so music recovers promptly. */
    private void handleUtteranceEnd(String utteranceId) {
        if (utteranceId == null || utteranceId.startsWith("warmup")) return;     // warmup — no focus to release
        long grace = utteranceId.startsWith("cue-mid-")
                ? FOCUS_RELEASE_DELAY_MS
                : FOCUS_SHORT_RELEASE_MS;
        scheduleFocusRelease(grace);
    }

    /** Schedule the audio focus release after the given grace.  Re-callable;
     *  the previous pending release is cancelled first so consecutive cues
     *  hold focus continuously. */
    private void scheduleFocusRelease(long graceMs) {
        handler.removeCallbacks(releaseFocusRunnable);
        handler.postDelayed(releaseFocusRunnable, graceMs);
    }

    /** Actually drop audio focus.  Music resumes its normal volume. */
    private void releaseAudioFocusNow() {
        handler.removeCallbacks(releaseFocusRunnable);
        if (!audioFocusHeld || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && currentFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(currentFocusRequest);
            currentFocusRequest = null;
        } else {
            audioManager.abandonAudioFocus(null);
        }
        audioFocusHeld = false;
        Log.d(TAG, "Audio focus released");
    }
}
