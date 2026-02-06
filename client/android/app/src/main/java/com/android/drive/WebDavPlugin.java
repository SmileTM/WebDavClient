package com.android.drive;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.Arrays;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.BufferedInputStream;
import java.io.RandomAccessFile;
import java.io.ByteArrayOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

import android.os.StatFs;
import android.os.Environment;
import android.util.Base64;
import android.content.Intent;
import android.net.Uri;
import android.Manifest;
import android.provider.Settings;
import android.os.Build;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import androidx.core.app.NotificationCompat;

import java.util.concurrent.ConcurrentHashMap;
import okhttp3.Call;

@CapacitorPlugin(
    name = "WebDavNative",
    permissions = {
        @com.getcapacitor.annotation.Permission(
            alias = "post_notifications",
            strings = {Manifest.permission.POST_NOTIFICATIONS}
        )
    }
)
public class WebDavPlugin extends Plugin {

    private final AtomicInteger activeTransfers = new AtomicInteger(0);
    private final ConcurrentHashMap<String, Call> activeCalls = new ConcurrentHashMap<>();

    private void startTransfer() {
        int count = activeTransfers.getAndIncrement();
        android.util.Log.d("WebDavNative", "startTransfer, count before increment: " + count);
        if (count == 0) {
            Context context = getContext();
            Intent intent = new Intent(context, FileTransferService.class);
            intent.setAction(FileTransferService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        }
    }

    private void endTransfer() {
        int count = activeTransfers.decrementAndGet();
        android.util.Log.d("WebDavNative", "endTransfer, count after decrement: " + count);
        if (count <= 0) {
            activeTransfers.set(0);
            Context context = getContext();
            Intent intent = new Intent(context, FileTransferService.class);
            intent.setAction(FileTransferService.ACTION_STOP);
            context.startService(intent);
            
            // Force cancel notification ID 9999
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.cancel(9999);
        }
    }

    private final OkHttpClient client = new OkHttpClient.Builder()
            .protocols(Arrays.asList(Protocol.HTTP_1_1))
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(0, TimeUnit.SECONDS) // No write timeout for large uploads
            .build();

    private LocalFileServer localServer;

    @Override
    public void load() {
        super.load();
        try {
            localServer = new LocalFileServer();
            localServer.start();
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (localServer != null) {
            localServer.stopServer();
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startBackgroundWork(PluginCall call) {
        startTransfer();
        call.resolve();
    }

    @PluginMethod
    public void stopBackgroundWork(PluginCall call) {
        // Force reset and stop
        activeTransfers.set(0);
        Context context = getContext();
        Intent intent = new Intent(context, FileTransferService.class);
        intent.setAction(FileTransferService.ACTION_STOP);
        context.startService(intent);
        
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(9999);
        
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            // Immediate UI feedback
            boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
            String title = isZh ? "正在取消..." : "Cancelling...";
            doUpdateNotification(9999, title, "", 0, 0);

            Call c = activeCalls.get(id);
            if (c != null) {
                android.util.Log.d("WebDavNative", "Cancelling active call: " + id);
                c.cancel();
                activeCalls.remove(id);
            } else {
                android.util.Log.d("WebDavNative", "Cancel called but ID not found: " + id);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void getServerUrl(PluginCall call) {
        if (localServer != null && localServer.getPort() > 0) {
            JSObject ret = new JSObject();
            ret.put("url", "http://127.0.0.1:" + localServer.getPort());
            call.resolve(ret);
        } else {
            call.reject("Server not running");
        }
    }

    // --- Helper: Read line from BufferedInputStream without consuming extra bytes ---
    private String readLine(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream lineBuf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') lineBuf.write(b);
        }
        if (lineBuf.size() == 0 && b == -1) return null;
        return lineBuf.toString("UTF-8");
    }

    private String formatSpeed(long bytesPerSec) {
        if (bytesPerSec < 1024 * 1024) {
            return String.format(java.util.Locale.US, "%.1f KB/s", bytesPerSec / 1024.0);
        }
        return String.format(java.util.Locale.US, "%.1f MB/s", bytesPerSec / (1024.0 * 1024.0));
    }

    private class LocalFileServer extends Thread {
        private ServerSocket serverSocket;
        private int port;
        private boolean isRunning = true;
        private final ExecutorService executor = Executors.newFixedThreadPool(16);

        public LocalFileServer() throws IOException {
            serverSocket = new ServerSocket(0);
            port = serverSocket.getLocalPort();
        }

        public int getPort() {
            return port;
        }

        public void stopServer() {
            isRunning = false;
            try { serverSocket.close(); } catch (Exception e) {}
            executor.shutdownNow();
        }

        @Override
        public void run() {
            while (isRunning) {
                try {
                    Socket socket = serverSocket.accept();
                    executor.submit(() -> handleClient(socket));
                } catch (IOException e) {
                    if (isRunning) e.printStackTrace();
                }
            }
        }

        private void handleClient(Socket socket) {
            try (InputStream rawIn = socket.getInputStream();
                 OutputStream out = socket.getOutputStream()) {
                
                BufferedInputStream in = new BufferedInputStream(rawIn);
                
                String requestLine = readLine(in);
                if (requestLine == null) return;

                String[] parts = requestLine.split(" ");
                if (parts.length < 2) return;
                
                String method = parts[0].toUpperCase();
                String path = java.net.URLDecoder.decode(parts[1], "UTF-8");
                
                long contentLength = -1;
                long rangeStart = 0;
                long rangeEnd = -1;

                String line;
                while ((line = readLine(in)) != null && !line.isEmpty()) {
                    String lower = line.toLowerCase();
                    if (lower.startsWith("content-length:")) {
                        contentLength = Long.parseLong(line.substring(15).trim());
                    } else if (lower.startsWith("range:")) {
                        Pattern p = Pattern.compile("bytes=(\\d+)-(\\d*)");
                        Matcher m = p.matcher(lower);
                        if (m.find()) {
                            rangeStart = Long.parseLong(m.group(1));
                            if (!m.group(2).isEmpty()) {
                                rangeEnd = Long.parseLong(m.group(2));
                            }
                        }
                    }
                }

                File root;
                if (path.startsWith("/cache/")) {
                    root = getContext().getExternalCacheDir();
                    path = path.substring(7);
                } else {
                    root = Environment.getExternalStorageDirectory();
                }
                
                File file = new File(root, path);
                
                if (!file.getCanonicalPath().startsWith(root.getCanonicalPath())) {
                    out.write("HTTP/1.1 403 Forbidden\r\n\r\n".getBytes());
                    return;
                }

                if ("PUT".equals(method)) {
                    File parent = file.getParentFile();
                    if (!parent.exists()) parent.mkdirs();
                    
                    boolean success = false;
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                         byte[] buffer = new byte[65536];
                         long bytesLeft = contentLength;
                         int read;
                         while (bytesLeft > 0 || contentLength == -1) {
                             int maxRead = (contentLength == -1) ? buffer.length : (int) Math.min(buffer.length, bytesLeft);
                             read = in.read(buffer, 0, maxRead);
                             if (read == -1) break;
                             fos.write(buffer, 0, read);
                             if (contentLength != -1) bytesLeft -= read;
                         }
                         success = true;
                    } catch (Exception e) {
                        e.printStackTrace();
                    } finally {
                        if (!success && file.exists()) {
                            android.util.Log.d("WebDavNative", "Deleting partial PUT file: " + file.getAbsolutePath());
                            file.delete();
                        }
                    }
                    if (success) {
                        out.write("HTTP/1.1 201 Created\r\nAccess-Control-Allow-Origin: *\r\n\r\n".getBytes());
                    } else {
                        out.write("HTTP/1.1 500 Internal Server Error\r\n\r\n".getBytes());
                    }
                } else if ("OPTIONS".equals(method)) {
                    out.write("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, PUT, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n\r\n".getBytes());
                } else {
                    if (!file.exists() || !file.isFile()) {
                        out.write("HTTP/1.1 404 Not Found\r\n\r\n".getBytes());
                        return;
                    }

                    long fileLength = file.length();
                    if (rangeEnd == -1) rangeEnd = fileLength - 1;
                    long finalLength = rangeEnd - rangeStart + 1;

                    StringBuilder headers = new StringBuilder();
                    headers.append("HTTP/1.1 206 Partial Content\r\n");
                    headers.append("Content-Type: application/octet-stream\r\n"); 
                    headers.append("Accept-Ranges: bytes\r\n");
                    headers.append("Content-Length: ").append(finalLength).append("\r\n");
                    headers.append("Content-Range: bytes ").append(rangeStart).append("-").append(rangeEnd).append("/").append(fileLength).append("\r\n");
                    headers.append("Access-Control-Allow-Origin: *\r\n");
                    headers.append("\r\n");
                    out.write(headers.toString().getBytes());

                    try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                        raf.seek(rangeStart);
                        byte[] buffer = new byte[65536];
                        long bytesToRead = finalLength;
                        while (bytesToRead > 0) {
                            int read = raf.read(buffer, 0, (int) Math.min(buffer.length, bytesToRead));
                            if (read == -1) break;
                            out.write(buffer, 0, read);
                            bytesToRead -= read;
                        }
                    }
                }

            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                try { socket.close(); } catch (IOException e) {}
            }
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissionForAlias("post_notifications", call, "notificationPermissionCallback");
            } else {
                call.resolve();
            }
        } else {
            call.resolve();
        }
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                call.resolve();
            } else {
                call.reject("Permission denied");
            }
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void requestManageStoragePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    Uri uri = Uri.fromParts("package", getActivity().getPackageName(), null);
                    intent.setData(uri);
                    getActivity().startActivity(intent);
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Failed to open settings: " + e.getMessage());
                }
            } else {
                call.resolve();
            }
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        try {
            File path = Environment.getExternalStorageDirectory();
            StatFs stat = new StatFs(path.getPath());
            long total = stat.getBlockCountLong() * stat.getBlockSizeLong();
            long free = stat.getAvailableBlocksLong() * stat.getBlockSizeLong();
            long used = total - free;

            JSObject ret = new JSObject();
            ret.put("total", total);
            ret.put("used", used);
            ret.put("free", free);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("items", new com.getcapacitor.JSArray());
            call.resolve(ret);
            return;
        }

        final int LIMIT = 100;
        final long TIME_LIMIT = 5000;
        final long startTime = System.currentTimeMillis();

        File root = Environment.getExternalStorageDirectory();
        String rootPath = root.getAbsolutePath();
        com.getcapacitor.JSArray results = new com.getcapacitor.JSArray();

        java.util.Stack<File> stack = new java.util.Stack<>();
        stack.push(root);

        int count = 0;

        while (!stack.isEmpty()) {
            if (count >= LIMIT || System.currentTimeMillis() - startTime > TIME_LIMIT) break;
            
            File dir = stack.pop();
            File[] files = dir.listFiles();
            if (files == null) continue;

            for (File f : files) {
                if (f.getName().startsWith(".")) continue;
                if (count >= LIMIT || System.currentTimeMillis() - startTime > TIME_LIMIT) break;

                if (f.getName().toLowerCase().contains(query.toLowerCase())) {
                    JSObject item = new JSObject();
                    item.put("name", f.getName());
                    String fullPath = f.getAbsolutePath();
                    String relPath = fullPath.startsWith(rootPath) ? fullPath.substring(rootPath.length()) : fullPath;
                    if (!relPath.startsWith("/")) relPath = "/" + relPath;
                    
                    item.put("path", relPath);
                    item.put("isDirectory", f.isDirectory());
                    item.put("size", f.length());
                    item.put("mtime", f.lastModified());
                    results.put(item);
                    count++;
                }

                if (f.isDirectory()) stack.push(f);
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", results);
        call.resolve(ret);
    }

    @PluginMethod
    public void listDirectory(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Path is required");
            return;
        }

        File root = Environment.getExternalStorageDirectory();
        File dir = new File(root, path);

        if (!dir.exists() || !dir.isDirectory()) {
            call.reject("Directory does not exist");
            return;
        }

        File[] files = dir.listFiles();
        com.getcapacitor.JSArray results = new com.getcapacitor.JSArray();

        if (files != null) {
            for (File f : files) {
                JSObject item = new JSObject();
                item.put("name", f.getName());
                item.put("isDirectory", f.isDirectory());
                item.put("size", f.length());
                item.put("mtime", f.lastModified());
                results.put(item);
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", results);
        call.resolve(ret);
    }

    @PluginMethod
    public void createDirectory(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Path is required");
            return;
        }

        File root = Environment.getExternalStorageDirectory();
        File dir = new File(root, path);

        if (dir.exists()) {
            call.resolve();
            return;
        }

        boolean success = dir.mkdirs();
        if (success) call.resolve();
        else call.reject("Failed to create directory: " + dir.getAbsolutePath());
    }

    @PluginMethod
    public void updateNotification(PluginCall call) {
        int id = call.getInt("id", 1);
        String title = call.getString("title", "File Operation");
        String description = call.getString("description", "Processing...");
        int progress = call.getInt("progress", 0);
        int max = call.getInt("max", 100);
        
        doUpdateNotification(id, title, description, progress, max);
        call.resolve();
    }
    
    private void doUpdateNotification(int id, String title, String description, int progress, int max) {
        Context context = getContext();
        
        // Log for debugging
        android.util.Log.d("WebDavNotification", "Updating notification ID: " + id + " Title: " + title + " Progress: " + progress + "/" + max);

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Use DEFAULT importance to ensure visibility in status bar. 
            // Changed ID to 'file_ops_v2' to force update on existing installs.
            NotificationChannel channel = new NotificationChannel("file_ops_v2", "File Operations", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setSound(null, null); 
            channel.enableVibration(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        // Determine icon based on progress
        int iconResId = com.android.drive.R.drawable.ic_stat_transfer_0;
        if (max > 0) {
            int percent = (int) ((progress * 100.0f) / max);
            if (percent >= 100) iconResId = com.android.drive.R.drawable.ic_stat_transfer_100;
            else if (percent >= 80) iconResId = com.android.drive.R.drawable.ic_stat_transfer_80;
            else if (percent >= 60) iconResId = com.android.drive.R.drawable.ic_stat_transfer_60;
            else if (percent >= 40) iconResId = com.android.drive.R.drawable.ic_stat_transfer_40;
            else if (percent >= 20) iconResId = com.android.drive.R.drawable.ic_stat_transfer_20;
        }

        // Create PendingIntent to open app on click
        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            launchIntent.setData(Uri.parse("webdav://transfers")); // Deep link
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags);
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, "file_ops_v2")
                .setSmallIcon(iconResId) 
                .setContentTitle(title)
                .setContentText(description)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        
        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent);
        }

        if (max > 0) {
            builder.setProgress(max, progress, false);
        } else {
            builder.setProgress(0, 0, true);
        }

        manager.notify(id, builder.build());
    }

    @PluginMethod
    public void cancelNotification(PluginCall call) {
        int id = call.getInt("id", 1);
        Context context = getContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void upload(PluginCall call) {
        startTransfer();
        String tempIdForFinally = null;
        try {
            String url = call.getString("url");
            String method = call.getString("method", "PUT");
            JSObject headers = call.getObject("headers");
            String sourcePath = call.getString("sourcePath");
            String tempId = call.getString("id");
            
            android.util.Log.d("WebDavNative", "Initial ID from call: " + tempId);
            if (headers != null) {
                 android.util.Log.d("WebDavNative", "Headers present. Keys: " + headers.keys());
                 try {
                     String headerId = headers.getString("X-Capacitor-Id");
                     android.util.Log.d("WebDavNative", "ID from header: " + headerId);
                     if (tempId == null) tempId = headerId;
                 } catch (Exception e) {
                     android.util.Log.e("WebDavNative", "Error reading header ID", e);
                 }
            } else {
                 android.util.Log.d("WebDavNative", "Headers are NULL");
            }

            if (tempId == null && headers != null) {
                tempId = headers.getString("X-Capacitor-Id");
            }
            tempIdForFinally = tempId;
            final String callbackId = tempId;

            if (url == null || sourcePath == null) {
                call.reject("URL and sourcePath are required");
                return;
            }

            android.util.Log.d("WebDavNative", "Upload sourcePath: " + sourcePath);
            android.util.Log.d("WebDavNative", "Upload Input Keys: " + call.getData().keys());

            File file = new File(sourcePath);
            if (!file.exists()) {
                // Not a valid absolute path, try relative to External Storage
                File root = Environment.getExternalStorageDirectory();
                String relative = sourcePath.startsWith("/") ? sourcePath.substring(1) : sourcePath;
                file = new File(root, relative);
                
                if (!file.exists()) {
                    // Try Cache Dir
                    File cache = getContext().getExternalCacheDir();
                    file = new File(cache, relative);
                }
            }

            android.util.Log.d("WebDavNative", "Resolved upload file: " + file.getAbsolutePath() + " (Exists: " + file.exists() + ")");

            if (!file.exists()) {
                call.reject("File not found: " + file.getAbsolutePath());
                return;
            }

            final File fileFinal = file;

            Request.Builder requestBuilder = new Request.Builder().url(url);

            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    String value = headers.getString(key);
                    if (value != null) requestBuilder.addHeader(key, value);
                }
            }

            final MediaType mediaTypeFinal;
            if (headers != null && headers.has("Content-Type")) {
                mediaTypeFinal = MediaType.parse(headers.getString("Content-Type"));
            } else {
                mediaTypeFinal = MediaType.parse("application/octet-stream");
            }

            RequestBody requestBody = new RequestBody() {
                @Override
                public MediaType contentType() { return mediaTypeFinal; }
                @Override
                public long contentLength() { return fileFinal.length(); }
                @Override
                public void writeTo(BufferedSink sink) throws IOException {
                    long fileLength = fileFinal.length();
                    byte[] buffer = new byte[65536];
                    long uploaded = 0;

                    try (InputStream in = new java.io.FileInputStream(fileFinal)) {
                        int read;
                        long lastUpdate = 0;
                        long lastBytes = 0;
                        while ((read = in.read(buffer)) != -1) {
                            // Check for cancellation
                            if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                                throw new IOException("Cancelled");
                            }

                            sink.write(buffer, 0, read);
                            uploaded += read;
                            
                            long now = System.currentTimeMillis();
                            if (now - lastUpdate > 500) {
                                 JSObject ret = new JSObject();
                                 ret.put("uploaded", uploaded);
                                 ret.put("total", fileLength);
                                 if (callbackId != null) ret.put("id", callbackId);
                                 
                                 notifyListeners("uploadProgress", ret);
                                 
                                 // Calculate Speed
                                 long diffBytes = uploaded - lastBytes;
                                 long diffTime = now - lastUpdate;
                                 long speed = diffTime > 0 ? (diffBytes * 1000 / diffTime) : 0;
                                 String speedStr = formatSpeed(speed);
                                 
                                 boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                                 String title = isZh ? "正在上传" : "Uploading";
                                 String desc = fileFinal.getName() + " (" + speedStr + ")";
                                 
                                 doUpdateNotification(9999, title, desc, (int)(uploaded/1024), (int)(fileLength/1024));
                                 
                                 lastUpdate = now;
                                 lastBytes = uploaded;
                            }
                        }
                    }
                }
            };

            requestBuilder.method(method, requestBody);

            Call callObj = client.newCall(requestBuilder.build());
            if (callbackId != null) activeCalls.put(callbackId, callObj);

            try (Response response = callObj.execute()) {
                 if (response.isSuccessful()) {
                     call.resolve();
                 } else {
                     call.reject("Upload failed: " + response.code() + " " + response.message());
                 }
            } catch (IOException e) {
                call.reject("Network error: " + e.getMessage());
            }
        } finally {
            if (tempIdForFinally != null) activeCalls.remove(tempIdForFinally);
            endTransfer();
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        startTransfer();
        String idForFinally = null;
        File file = null;
        try {
            String url = call.getString("url");
            String destPath = call.getString("destPath");
            JSObject headers = call.getObject("headers");
            final String callbackId = call.getString("id");
            idForFinally = callbackId;

            if (url == null || destPath == null) {
                call.reject("URL and destPath are required");
                return;
            }

            android.util.Log.d("WebDavNative", "Download destPath: " + destPath);

            File root = Environment.getExternalStorageDirectory();
            
            if (destPath.startsWith(root.getAbsolutePath())) {
                file = new File(destPath);
            } else {
                String relativePath = destPath.startsWith("/") ? destPath.substring(1) : destPath;
                file = new File(root, relativePath);
            }

            android.util.Log.d("WebDavNative", "Resolved download file: " + file.getAbsolutePath());

            // Ensure parent directory exists
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                boolean created = parent.mkdirs();
                android.util.Log.d("WebDavNative", "Created parent dir: " + parent.getAbsolutePath() + " = " + created);
            }

            Request.Builder requestBuilder = new Request.Builder().url(url).get();

            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    String value = headers.getString(key);
                    if (value != null) requestBuilder.addHeader(key, value);
                }
            }

            Call callObj = client.newCall(requestBuilder.build());
            if (callbackId != null) activeCalls.put(callbackId, callObj);

            try (Response response = callObj.execute()) {
                if (!response.isSuccessful()) {
                    call.reject("Download failed: " + response.code() + " " + response.message());
                    return;
                }

                if (response.body() == null) {
                    call.reject("Empty response body");
                    return;
                }

                long contentLength = response.body().contentLength();
                long downloaded = 0;
                
                try (InputStream in = response.body().byteStream();
                     FileOutputStream out = new FileOutputStream(file)) {
                    
                    byte[] buffer = new byte[65536];
                    int read;
                    long lastUpdate = 0;
                    long lastBytes = 0;

                    while ((read = in.read(buffer)) != -1) {
                        // Check for cancellation
                        if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                            throw new IOException("Cancelled");
                        }

                        out.write(buffer, 0, read);
                        downloaded += read;
                        
                        long now = System.currentTimeMillis();
                        if (now - lastUpdate > 500) {
                            JSObject ret = new JSObject();
                            ret.put("downloaded", downloaded);
                            ret.put("total", contentLength);
                            if (callbackId != null) ret.put("id", callbackId);
                            
                            notifyListeners("downloadProgress", ret);
                            
                            // Calculate Speed
                            long diffBytes = downloaded - lastBytes;
                            long diffTime = now - lastUpdate;
                            long speed = diffTime > 0 ? (diffBytes * 1000 / diffTime) : 0;
                            String speedStr = formatSpeed(speed);
                            
                            boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                            String title = isZh ? "正在下载" : "Downloading";
                            
                            if (contentLength > 0) {
                                 doUpdateNotification(9999, title, file.getName() + " (" + speedStr + ")", (int)(downloaded/1024), (int)(contentLength/1024));
                            } else {
                                 doUpdateNotification(9999, title, file.getName() + " (" + speedStr + ")", 0, 0);
                            }
                            
                            lastUpdate = now;
                            lastBytes = downloaded;
                        }
                    }
                    out.flush();
                }
                
                call.resolve();

            } catch (Exception e) {
                // IMPORTANT: Delete partial file on failure/cancellation
                if (file != null && file.exists()) {
                    android.util.Log.d("WebDavNative", "Deleting partial download file: " + file.getAbsolutePath());
                    file.delete();
                }
                call.reject("Download error: " + e.getMessage());
            }
        } finally {
            if (idForFinally != null) activeCalls.remove(idForFinally);
            endTransfer();
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");
        boolean bodyIsBase64 = call.getBoolean("bodyIsBase64", false);
        String responseType = call.getString("responseType", "text");
        String reqId = call.getString("id");

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        Request.Builder requestBuilder = new Request.Builder().url(url);

        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.getString(key);
                if (value != null) requestBuilder.addHeader(key, value);
            }
            if (reqId == null) {
                reqId = headers.getString("X-Capacitor-Id");
            }
        }
        final String callbackId = reqId;

        RequestBody requestBody = null;
        if (body != null) {
            MediaType mediaType = MediaType.parse("text/xml; charset=utf-8"); 
            if (headers != null && headers.has("Content-Type")) {
                 mediaType = MediaType.parse(headers.getString("Content-Type"));
            }
            if (bodyIsBase64) {
                try {
                    byte[] decoded = Base64.decode(body, Base64.DEFAULT);
                    requestBody = RequestBody.create(decoded, mediaType);
                } catch (IllegalArgumentException e) {
                    call.reject("Invalid Base64 body");
                    return;
                }
            } else {
                requestBody = RequestBody.create(body, mediaType);
            }
        }
        
        boolean allowsBody = method.equals("POST") || method.equals("PUT") || method.equals("PATCH") || method.equals("PROPFIND") || method.equals("PROPPATCH") || method.equals("LOCK");
        if (allowsBody) {
             if (requestBody == null) requestBody = RequestBody.create("", null);
             requestBuilder.method(method, requestBody);
        } else {
             requestBuilder.method(method, null);
        }

        Call callObj = client.newCall(requestBuilder.build());
        if (callbackId != null) activeCalls.put(callbackId, callObj);

        try (Response response = callObj.execute()) {
            JSObject ret = new JSObject();
            ret.put("status", response.code());
            if (response.body() != null) {
                if ("base64".equals(responseType)) {
                    byte[] bytes = response.body().bytes();
                    String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    ret.put("data", base64);
                } else {
                    ret.put("data", response.body().string());
                }
            } else {
                ret.put("data", "");
            }
            call.resolve(ret);
        } catch (IOException e) {
            call.reject(e.getMessage());
        } catch (Exception e) {
             call.reject(e.getMessage());
        } finally {
            if (callbackId != null) activeCalls.remove(callbackId);
        }
    }
}