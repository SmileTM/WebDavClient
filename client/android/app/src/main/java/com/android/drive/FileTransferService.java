package com.android.drive;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import android.content.pm.ServiceInfo;

public class FileTransferService extends Service {
    public static final String ACTION_START = "START";
    public static final String ACTION_STOP = "STOP";
    private static final String CHANNEL_ID = "file_ops_v2";
    private static final int NOTIFICATION_ID = 9999;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_START.equals(action)) {
                startForegroundService();
            } else if (ACTION_STOP.equals(action)) {
                stopForegroundService();
            }
        }
        return START_NOT_STICKY;
    }

    private void startForegroundService() {
        boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
        String title = isZh ? "WebDAV 网盘" : "WebDAV Drive";
        String text = isZh ? "文件传输进行中..." : "File transfer in progress...";

        // Create PendingIntent to open app on click
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            launchIntent.setData(Uri.parse("webdav://transfers"));
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(com.android.drive.R.drawable.ic_stat_transfer)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true);
        
        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent);
        }

        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // If targeting Android 14, specific types might be needed in manifest
            // Here we specify dataSync compatible type if available/needed
            try {
                // ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC is API 34 (Android 14)
                // Using reflection or literal value if compiling against older SDK
                // 1 = FOREGROUND_SERVICE_TYPE_DATA_SYNC
                int type = 0;
                if (Build.VERSION.SDK_INT >= 34) {
                    type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                } else {
                    // For Android 10-13, type can be 0 or manifest defined
                    // manifest defaults to all declared types
                    // We can just use standard startForeground
                }
                
                if (type != 0) {
                    startForeground(NOTIFICATION_ID, notification, type);
                } else {
                    startForeground(NOTIFICATION_ID, notification);
                }
            } catch (Exception e) {
                // Fallback for older SDK compilation
                startForeground(NOTIFICATION_ID, notification);
            }
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void stopForegroundService() {
        stopForeground(true);
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "File Operations",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            serviceChannel.setSound(null, null);
            serviceChannel.enableVibration(false);
            serviceChannel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
