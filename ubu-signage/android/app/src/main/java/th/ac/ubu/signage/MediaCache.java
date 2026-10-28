package th.ac.ubu.signage;

import android.content.Context;
import android.net.Uri;
import android.os.StatFs;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Keeps the player working when the network or server is down:
 *  - media files (/media/...) are downloaded once and served from local storage
 *  - the player page itself (/player/...) is served from the last good copy
 */
public class MediaCache {
    private static final String TAG = "UbuCache";
    private static final long MIN_FREE_BYTES = 300L * 1024 * 1024;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");

    private final File mediaDir;
    private final File pageDir;
    private final ExecutorService downloader = Executors.newSingleThreadExecutor();
    private final Set<String> pending = Collections.synchronizedSet(new HashSet<String>());
    private volatile String host = "";
    private volatile int port = -1;

    public MediaCache(Context ctx) {
        mediaDir = new File(ctx.getFilesDir(), "media");
        pageDir = new File(ctx.getFilesDir(), "page");
        mediaDir.mkdirs();
        pageDir.mkdirs();
    }

    public void setServer(String baseUrl) {
        Uri u = Uri.parse(baseUrl);
        host = u.getHost() == null ? "" : u.getHost();
        port = u.getPort();
    }

    private boolean isOurServer(Uri u) {
        return host.equalsIgnoreCase(u.getHost() == null ? "" : u.getHost()) && port == u.getPort();
    }

    // ------------------------------------------------------------ intercept
    public WebResourceResponse intercept(WebResourceRequest req) {
        if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
        Uri u = req.getUrl();
        if (!isOurServer(u)) return null;
        String path = u.getPath() == null ? "" : u.getPath();
        try {
            if (path.startsWith("/media/")) return serveMedia(u, req.getRequestHeaders());
            if (path.equals("/player") || path.startsWith("/player/")) return servePage(u, path);
        } catch (Exception e) {
            Log.w(TAG, "intercept failed for " + u, e);
        }
        return null;
    }

    private WebResourceResponse serveMedia(Uri u, Map<String, String> headers) throws IOException {
        String name = u.getLastPathSegment();
        if (name == null || !SAFE_NAME.matcher(name).matches()) return null;
        File f = new File(mediaDir, name);
        if (!f.isFile()) {
            enqueue(u.toString(), name);
            return null; // stream from the network this time
        }
        String mime = mimeOf(name);
        long len = f.length();
        String range = null;
        if (headers != null) {
            for (Map.Entry<String, String> h : headers.entrySet()) {
                if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
            }
        }
        Map<String, String> out = new HashMap<>();
        out.put("Accept-Ranges", "bytes");
        out.put("Access-Control-Allow-Origin", "*");
        out.put("Cache-Control", "max-age=31536000");

        if (range != null) {
            Matcher m = RANGE.matcher(range);
            if (m.find()) {
                long start, end;
                if (m.group(1).isEmpty()) { // suffix range: last N bytes
                    long n = Long.parseLong(m.group(2));
                    start = Math.max(0, len - n);
                    end = len - 1;
                } else {
                    start = Long.parseLong(m.group(1));
                    end = m.group(2).isEmpty() ? len - 1 : Math.min(len - 1, Long.parseLong(m.group(2)));
                }
                if (start >= len || start > end) {
                    out.put("Content-Range", "bytes */" + len);
                    return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", out,
                            new ByteArrayInputStream(new byte[0]));
                }
                InputStream in = new FileInputStream(f);
                skipFully(in, start);
                long count = end - start + 1;
                out.put("Content-Range", "bytes " + start + "-" + end + "/" + len);
                out.put("Content-Length", String.valueOf(count));
                return new WebResourceResponse(mime, null, 206, "Partial Content", out, new Limited(in, count));
            }
        }
        out.put("Content-Length", String.valueOf(len));
        return new WebResourceResponse(mime, null, 200, "OK", out, new FileInputStream(f));
    }

    private WebResourceResponse servePage(Uri u, String path) {
        String name = path.endsWith("/") || path.equals("/player") ? "index.html" : u.getLastPathSegment();
        if (name == null || !SAFE_NAME.matcher(name).matches()) return null;
        File f = new File(pageDir, name);
        String mime = mimeOf(name);
        Map<String, String> out = new HashMap<>();
        out.put("Cache-Control", "no-cache");
        try {
            byte[] body = download(u.toString(), 5000, 10000);
            writeAtomic(f, body);
            return new WebResourceResponse(mime, "utf-8", 200, "OK", out, new ByteArrayInputStream(body));
        } catch (IOException e) {
            if (f.isFile()) {
                try {
                    return new WebResourceResponse(mime, "utf-8", 200, "OK", out, new FileInputStream(f));
                } catch (IOException ignored) { }
            }
            return null; // let WebView show its error; the activity retries
        }
    }

    public boolean hasCachedPage() {
        return new File(pageDir, "index.html").isFile();
    }

    // ------------------------------------------------------------ prefetch
    /** Called from the page with every media URL this screen may play. */
    public void prefetch(String jsonUrls) {
        try {
            JSONArray arr = new JSONArray(jsonUrls);
            Set<String> keep = new HashSet<>();
            for (int i = 0; i < arr.length(); i++) {
                Uri u = Uri.parse(arr.getString(i));
                String name = u.getLastPathSegment();
                if (name == null || !SAFE_NAME.matcher(name).matches() || !isOurServer(u)) continue;
                keep.add(name);
                if (!new File(mediaDir, name).isFile()) enqueue(u.toString(), name);
            }
            // drop files no playlist of this screen uses any more
            File[] files = mediaDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    String n = f.getName();
                    if (n.endsWith(".part")) continue;
                    if (!keep.contains(n) && !pending.contains(n)) f.delete();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "prefetch failed", e);
        }
    }

    public void clear() {
        File[] files = mediaDir.listFiles();
        if (files != null) for (File f : files) f.delete();
        files = pageDir.listFiles();
        if (files != null) for (File f : files) f.delete();
    }

    public long sizeBytes() {
        long total = 0;
        File[] files = mediaDir.listFiles();
        if (files != null) for (File f : files) total += f.length();
        return total;
    }

    private void enqueue(final String url, final String name) {
        if (!pending.add(name)) return;
        downloader.execute(new Runnable() {
            @Override
            public void run() {
                File part = new File(mediaDir, name + ".part");
                try {
                    if (freeBytes() < MIN_FREE_BYTES) {
                        Log.w(TAG, "storage almost full, not caching " + name);
                        return;
                    }
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(30000);
                    if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
                    InputStream in = c.getInputStream();
                    OutputStream os = new FileOutputStream(part);
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    try {
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    } finally {
                        os.close();
                        in.close();
                        c.disconnect();
                    }
                    if (!part.renameTo(new File(mediaDir, name))) throw new IOException("rename failed");
                    Log.i(TAG, "cached " + name);
                } catch (Exception e) {
                    Log.w(TAG, "download failed " + url + ": " + e);
                    part.delete();
                } finally {
                    pending.remove(name);
                }
            }
        });
    }

    // ------------------------------------------------------------ helpers
    private long freeBytes() {
        try {
            StatFs s = new StatFs(mediaDir.getPath());
            return s.getAvailableBytes();
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    private static byte[] download(String url, int connectMs, int readMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setUseCaches(false);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static void writeAtomic(File f, byte[] body) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        FileOutputStream os = new FileOutputStream(tmp);
        try { os.write(body); } finally { os.close(); }
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) throw new IOException("skip failed");
            n -= s;
        }
    }

    private static String mimeOf(String name) {
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
        if (ext.equals("html")) return "text/html";
        if (ext.equals("js")) return "application/javascript";
        if (ext.equals("css")) return "text/css";
        if (ext.equals("mp4") || ext.equals("m4v")) return "video/mp4";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    /** Input stream that stops after a fixed number of bytes (for range responses). */
    private static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long limit) { super(in); left = limit; }

        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override public int available() throws IOException {
            return (int) Math.min(super.available(), left);
        }
    }
}
