package com.the12414.pacer;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for PacerTimerService.
 * Exposed to JavaScript as window.Capacitor.Plugins.PacerTimer.
 *
 * Methods:
 *   start({ cues: [{delayMs, text}], paceName })  — start service with cue schedule
 *   stop()                                         — cancel all pending cues and stop service
 */
@CapacitorPlugin(name = "PacerTimer")
public class PacerTimerPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        JSArray cues = call.getArray("cues");
        if (cues == null) {
            call.reject("Missing cues array");
            return;
        }
        String paceName = call.getString("paceName", "Pacer");

        Intent intent = new Intent(getContext(), PacerTimerService.class);
        intent.setAction(PacerTimerService.ACTION_START);
        intent.putExtra(PacerTimerService.EXTRA_CUES, cues.toString());
        intent.putExtra(PacerTimerService.EXTRA_PACE_NAME, paceName);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), PacerTimerService.class);
        intent.setAction(PacerTimerService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
