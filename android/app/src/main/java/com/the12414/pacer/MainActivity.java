package com.the12414.pacer;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PacerTimerPlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermission();
        // Warm the shared TTS engine at launch so the first pace's opening cue
        // isn't delayed ~1 s by a cold engine init. The engine is reused for the
        // whole app session (see TtsHolder).
        TtsHolder.init(getApplicationContext());
    }

    /**
     * Android 13+ requires runtime permission for notifications.
     * The foreground service notification (and therefore the wake lock)
     * won't work without it. We ask on first launch.
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        1001
                );
            }
        }
    }
}
