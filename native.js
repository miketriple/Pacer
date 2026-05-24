/* ============================================================
   native.js — Capacitor integration layer.
   Provides native TTS and Foreground Service via window.Capacitor.
   When running on the web, all exports are no-ops or fall through
   to web equivalents. No bundler required — accesses plugins via
   window.Capacitor.Plugins directly.
   ============================================================ */

/**
 * Returns a speak function backed by the native TTS plugin.
 * Call this only when window.Capacitor?.isNativePlatform() is true.
 * The returned function accepts a text string and returns a Promise
 * that resolves when speech is complete (or the plugin settles).
 * @returns {(text: string) => Promise<void>}
 */
export function createNativeSpeakFn() {
  return (text) => window.Capacitor.Plugins.TextToSpeech.speak({
    text,
    lang:   'en-US',
    rate:   1.1,
    pitch:  1.0,
    volume: 1.0,
  });
}

/**
 * Stop any in-progress native TTS utterance.
 * @returns {Promise<void>}
 */
export function stopNativeTts() {
  return window.Capacitor.Plugins.TextToSpeech?.stop?.() ?? Promise.resolve();
}

/**
 * Start the Android Foreground Service so audio continues with the screen locked.
 * Safe to call on the web — resolves immediately if the plugin is absent.
 * @param {string} body  Notification body text (usually the pace name).
 * @returns {Promise<void>}
 */
export function startForegroundService(body) {
  return window.Capacitor?.Plugins?.ForegroundService?.startForegroundService({
    title:     'Pacer',
    body,
    id:        1,
    smallIcon: 'ic_notification',
  }) ?? Promise.resolve();
}

/**
 * Stop the Android Foreground Service.
 * Safe to call on the web — resolves immediately if the plugin is absent.
 * @returns {Promise<void>}
 */
export function stopForegroundService() {
  return window.Capacitor?.Plugins?.ForegroundService?.stopForegroundService()
    ?? Promise.resolve();
}
