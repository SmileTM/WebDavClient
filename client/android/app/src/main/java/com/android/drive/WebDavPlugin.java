package com.android.drive;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import java.io.File;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import android.os.StatFs;
import android.os.Environment;
import android.util.Base64;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.os.Build;

import java.net.ServerSocket;
import java.net.Socket;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.io.FileInputStream;

@CapacitorPlugin(name = "WebDavNative")
public class WebDavPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
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

    private class LocalFileServer extends Thread {
        private ServerSocket serverSocket;
        private int port;
        private boolean isRunning = true;

        public LocalFileServer() throws IOException {
            serverSocket = new ServerSocket(0);
            port = serverSocket.getLocalPort();
        }

        public int getPort() {
            return port;
        }

        @Override
        public void run() {
            while (isRunning) {
                try {
                    Socket socket = serverSocket.accept();
                    new Thread(() -> handleClient(socket)).start();
                } catch (IOException e) {
                    if (isRunning) e.printStackTrace();
                }
            }
        }

        private void handleClient(Socket socket) {
            try (InputStream in = socket.getInputStream();
                 OutputStream out = socket.getOutputStream()) {
                
                BufferedReader reader = new BufferedReader(new InputStreamReader(in));
                String requestLine = reader.readLine();
                if (requestLine == null) return;

                String[] parts = requestLine.split(" ");
                if (parts.length < 2) return;
                
                String path = parts[1];
                
                long rangeStart = 0;
                long rangeEnd = -1;
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("range:")) {
                        Pattern p = Pattern.compile("bytes=(\\d+)-(\\d*)");
                        Matcher m = p.matcher(line.toLowerCase());
                        if (m.find()) {
                            rangeStart = Long.parseLong(m.group(1));
                            if (!m.group(2).isEmpty()) {
                                rangeEnd = Long.parseLong(m.group(2));
                            }
                        }
                    }
                }

                path = java.net.URLDecoder.decode(path, "UTF-8");
                File root = Environment.getExternalStorageDirectory();
                File file = new File(root, path);

                if (!file.getCanonicalPath().startsWith(root.getCanonicalPath()) || !file.exists() || !file.isFile()) {
                    String response = "HTTP/1.1 404 Not Found\r\n\r\n";
                    out.write(response.getBytes());
                    return;
                }

                long fileLength = file.length();
                if (rangeEnd == -1) rangeEnd = fileLength - 1;
                long contentLength = rangeEnd - rangeStart + 1;

                StringBuilder headers = new java.lang.StringBuilder();
                headers.append("HTTP/1.1 206 Partial Content\r\n");
                headers.append("Content-Type: video/mp4\r\n"); 
                headers.append("Accept-Ranges: bytes\r\n");
                headers.append("Content-Length: ").append(contentLength).append("\r\n");
                headers.append("Content-Range: bytes ").append(rangeStart).append("-").append(rangeEnd).append("/").append(fileLength).append("\r\n");
                headers.append("Access-Control-Allow-Origin: *\r\n");
                headers.append("\r\n");
                out.write(headers.toString().getBytes());

                try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                    raf.seek(rangeStart);
                    byte[] buffer = new byte[8192];
                    long bytesToRead = contentLength;
                    while (bytesToRead > 0) {
                        int read = raf.read(buffer, 0, (int) Math.min(buffer.length, bytesToRead));
                        if (read == -1) break;
                        out.write(buffer, 0, read);
                        bytesToRead -= read;
                    }
                }

            } catch (Exception e) {
            } finally {
                try { socket.close(); } catch (IOException e) {}
            }
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
            long blockSize = stat.getBlockSizeLong();
            long totalBlocks = stat.getBlockCountLong();
            long availableBlocks = stat.getAvailableBlocksLong();

            long total = totalBlocks * blockSize;
            long free = availableBlocks * blockSize;
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

        // Use a simple stack for iteration to avoid recursion depth issues or complex inner class
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

                if (f.isDirectory()) {
                    stack.push(f);
                }
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                call.reject("Manage All Files permission is required");
                return;
            }
        }

        File root = Environment.getExternalStorageDirectory();
        File dir = new File(root, path);

        if (dir.exists()) {
            call.resolve();
            return;
        }

        boolean success = dir.mkdirs();
        if (success) {
            call.resolve();
        } else {
            call.reject("Failed to create directory: " + dir.getAbsolutePath());
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

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        Request.Builder requestBuilder = new Request.Builder()
                .url(url);

        // Set Headers
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.getString(key);
                if (value != null) {
                    requestBuilder.addHeader(key, value);
                    if (!key.equalsIgnoreCase("Authorization")) {
                        android.util.Log.d("WebDavNative", "Header: " + key + " = " + value);
                    } else {
                        android.util.Log.d("WebDavNative", "Header: Authorization = [HIDDEN]");
                    }
                }
            }
        }

        // Handle Body & Method
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
        
        // OkHttp requires a body for some methods
        boolean allowsBody = method.equals("POST") || method.equals("PUT") || method.equals("PATCH") || method.equals("PROPFIND") || method.equals("PROPPATCH") || method.equals("LOCK");
        
        if (allowsBody) {
             if (requestBody == null) {
                 requestBody = RequestBody.create("", null); 
             }
             requestBuilder.method(method, requestBody);
        } else {
             requestBuilder.method(method, null);
        }

        // Execute
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
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
        }
    }
}