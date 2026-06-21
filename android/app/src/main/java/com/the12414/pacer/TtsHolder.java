package com.the12414.pacer;

import android.content.Context;
import android.media.AudioAttributes;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * App-lifetime holder for a single shared TextToSpeech engine.
 *
 * Why this exists:
 *   Creating a TextToSpeech costs ~0.9 s of init every time (measured via
 *   logcat: onCreate → onInit).  PacerTimerService used to create AND destroy
 *   one per pace, so every pace start had a ~1 s silent gap before the first
 *   cue — even immediately after another pace.  Holding ONE initialized engine
 *   for the whole app process removes that init from every pace.  MainActivity
 *   kicks the init off at launch, so the engine is warm before the first Start.
 *
 *   This is just a binding to the system TTS engine — there is no foreground
 *   service, no wake lock, no notification, and no CPU/battery use while idle.
 *
 * Lifecycle:
 *   init() is idempotent and may be called from MainActivity (at launch) and/or
 *   the service (fallback when an AlarmManager rebirth starts the service while
 *   the activity never ran).  The engine is intentionally never shut down — it
 *   lives until the app process is reclaimed, which also protects a pace that is
 *   still running in the background when the activity is destroyed.
 */
final class TtsHolder {

    private static final String TAG = "PacerTimerService";

    private static TextToSpeech tts;
    private static volatile boolean ready = false;
    private static final List<Runnable> whenReady = new ArrayList<>();

    private TtsHolder() {}

    /** Create and configure the shared engine.  No-op if already created. */
    static synchronized void init(Context context) {
        if (tts != null) return;
        Context app = context.getApplicationContext();
        tts = new TextToSpeech(app, TtsHolder::onInit);
    }

    private static void onInit(int status) {
        if (status != TextToSpeech.SUCCESS) {
            Log.w(TAG, "Shared TTS init failed: status " + status);
            return;
        }
        tts.setLanguage(Locale.US);
        tts.setSpeechRate(1.1f);
        // Navigation-guidance usage so other audio ducks for cues (matches the
        // AudioAttributes the service uses when requesting audio focus).
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        // Prime the synthesis pipeline so the first real cue speaks promptly.
        tts.playSilentUtterance(1, TextToSpeech.QUEUE_FLUSH, "tts-holder-warm");
        Log.d(TAG, "Shared TTS ready");

        List<Runnable> toRun;
        synchronized (TtsHolder.class) {
            ready = true;
            toRun = new ArrayList<>(whenReady);
            whenReady.clear();
        }
        for (Runnable r : toRun) r.run();
    }

    static boolean isReady() { return ready; }

    static TextToSpeech get() { return tts; }

    /** Point the engine's utterance callbacks at the active service's listener
     *  (or null to detach).  No-op until the engine exists. */
    static void setListener(UtteranceProgressListener listener) {
        if (tts != null) tts.setOnUtteranceProgressListener(listener);
    }

    /** Run r now if the engine is ready, otherwise once it becomes ready. */
    static void runWhenReady(Runnable r) {
        boolean runNow;
        synchronized (TtsHolder.class) {
            runNow = ready;
            if (!runNow) whenReady.add(r);
        }
        if (runNow) r.run();
    }
}
