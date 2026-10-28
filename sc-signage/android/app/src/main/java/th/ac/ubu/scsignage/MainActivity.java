package th.ac.ubu.scsignage;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen kiosk that shows the SC Signage player page.
 *
 * Remote control: press BACK 5 times quickly (or MENU) to open settings.
 * Touch screens: tap the top-left corner 5 times quickly.
 * OK / Enter shows the screen info overlay.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "sc_signage";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_OVERLAY_ASKED = "overlay_asked";
    private static final long WATCHDOG_MS = 30_000;
    private static final long HEARTBEAT_TIMEOUT_MS = 120_000;
    private static final long DAILY_RELOAD_MS = 24L * 60 * 60 * 1000;
    private static final long SNAPSHOT_MS = 10L * 60 * 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private MediaCache cache;
    private SharedPreferences prefs;
    private String screenId;
    private String appVersion = "?";
    private volatile long lastHeartbeat = 0;
    private long pageLoadedAt = 0;
    private boolean settingsOpen = false;
    private boolean screenOn = true;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private int secretCount = 0;
    private long secretStart = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        cache = new MediaCache(this);
        screenId = makeScreenId();
        try {
            appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) { }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        createWebView();
        showSplash();

        String server = prefs.getString(KEY_SERVER, "");
        if (server.isEmpty()) {
            showMessage("ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์\nกดปุ่ม BACK 5 ครั้ง หรือปุ่ม MENU เพื่อตั้งค่า\n\nID จอนี้: " + screenId);
            handler.postDelayed(new Runnable() { @Override public void run() { openSettings(); } }, 800);
        } else {
            loadPlayer();
        }
        handler.postDelayed(watchdog, WATCHDOG_MS);
        handler.postDelayed(periodicSnapshot, 60_000);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " ScSignage/" + appVersion);

        web.addJavascriptInterface(new Bridge(), "ScAndroid");
        web.setWebChromeClient(new WebChromeClient() {
            // hides the grey "play" placeholder Android draws before a video starts
            @Override public Bitmap getDefaultVideoPoster() {
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return cache.intercept(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // never leave the kiosk for an external app
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoadedAt = SystemClock.elapsedRealtime();
                lastHeartbeat = pageLoadedAt;
                handler.postDelayed(hideSplash, 1500); // ให้หน้าเล่นวาดเสร็จก่อนค่อยเอาโลโก้ออก
            }

            @TargetApi(23)
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) pageFailed();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int code, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < 23) pageFailed(); // older Android uses this callback
            }

            @TargetApi(26)
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // WebView renderer crashed (often low memory on cheap boxes): rebuild it
                handler.post(new Runnable() {
                    @Override public void run() { createWebView(); loadPlayer(); }
                });
                return true;
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void pageFailed() {
        showMessage("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่…\n" + prefs.getString(KEY_SERVER, "")
                + "\n\nID จอนี้: " + screenId);
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, 15_000);
    }

    private final Runnable retry = new Runnable() {
        @Override public void run() { loadPlayer(); }
    };

    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            long now = SystemClock.elapsedRealtime();
            boolean configured = !prefs.getString(KEY_SERVER, "").isEmpty();
            if (configured && !settingsOpen) {
                if (pageLoadedAt > 0 && now - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
                    loadPlayer(); // page hung or JS stopped
                } else if (pageLoadedAt > 0 && now - pageLoadedAt > DAILY_RELOAD_MS) {
                    loadPlayer(); // daily refresh keeps memory use in check
                }
            }
            handler.postDelayed(this, WATCHDOG_MS);
        }
    };

    private void loadPlayer() {
        handler.removeCallbacks(retry);
        String server = prefs.getString(KEY_SERVER, "").trim();
        if (server.isEmpty()) return;
        cache.setServer(server);
        hideMessage();
        pageLoadedAt = 0;
        String url = server + "/player/?id=" + Uri.encode(screenId);
        web.loadUrl(url);
        web.requestFocus();
    }

    // ------------------------------------------------------------ JS bridge
    private class Bridge {
        @JavascriptInterface public void heartbeat() { lastHeartbeat = SystemClock.elapsedRealtime(); }
        @JavascriptInterface public void prefetch(String jsonUrls) { cache.prefetch(jsonUrls); }
        @JavascriptInterface public void snapshot() { handler.post(MainActivity.this::captureSnapshot); }
        @JavascriptInterface public void setScreenOn(final boolean on) { handler.post(() -> applyScreenOn(on)); }
        @JavascriptInterface public String screenId() { return screenId; }
        @JavascriptInterface public String version() { return appVersion; }
    }

    // ------------------------------------------------------------ TV on/off
    /**
     * Group TV-off times: the page already shows black; here we also drop the backlight to minimum.
     * Turning the TV itself off needs HDMI-CEC, which ordinary Android apps cannot control.
     */
    private void applyScreenOn(boolean on) {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = on ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : 0.01f;
        getWindow().setAttributes(lp);
        screenOn = on;
    }

    // ------------------------------------------------------------ snapshots (shown on the dashboard)
    private void captureSnapshot() {
        final int w = root.getWidth(), h = root.getHeight();
        if (w <= 0 || h <= 0 || !screenOn) return;
        final Bitmap full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                // PixelCopy reads what is really on screen, including video
                PixelCopy.request(getWindow(), full, (int result) -> {
                    if (result == PixelCopy.SUCCESS) uploadSnapshot(full);
                    else drawSnapshot(full);
                }, handler);
                return;
            } catch (Exception ignored) { }
        }
        drawSnapshot(full);
    }

    private void drawSnapshot(Bitmap full) {
        try {
            root.draw(new Canvas(full));
            uploadSnapshot(full);
        } catch (Exception ignored) { }
    }

    private void uploadSnapshot(final Bitmap full) {
        final String server = prefs.getString(KEY_SERVER, "");
        if (server.isEmpty()) return;
        io.execute(() -> {
            try {
                int tw = 640, th = Math.max(1, full.getHeight() * tw / Math.max(1, full.getWidth()));
                Bitmap small = Bitmap.createScaledBitmap(full, tw, th, true);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 70, bos);
                small.recycle();
                full.recycle();
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/player/" + Uri.encode(screenId) + "/snapshot").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "image/jpeg");
                OutputStream os = c.getOutputStream();
                os.write(bos.toByteArray());
                os.close();
                c.getResponseCode();
                c.disconnect();
            } catch (Exception ignored) { }
        });
    }

    private final Runnable periodicSnapshot = new Runnable() {
        @Override public void run() {
            if (!settingsOpen && pageLoadedAt > 0) captureSnapshot();
            handler.postDelayed(this, SNAPSHOT_MS);
        }
    };

    // ------------------------------------------------------------ settings
    private void openSettings() {
        if (settingsOpen) return;
        settingsOpen = true;
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);

        TextView info = new TextView(this);
        info.setText(String.format(Locale.US,
                "ID จอนี้: %s\nแคชสื่อในเครื่อง: %.1f MB\nเวอร์ชันแอป: %s\n\nที่อยู่เซิร์ฟเวอร์ (เช่น http://192.168.1.10:3000)",
                screenId, cache.sizeBytes() / 1048576.0, appVersion));
        box.addView(info);

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        String current = prefs.getString(KEY_SERVER, "");
        input.setText(current.isEmpty() ? "http://" : current);
        input.setSelection(input.getText().length());
        box.addView(input);

        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("ตั้งค่า SC Signage")
                .setView(box)
                .setPositiveButton("บันทึก", (d, w) -> saveServer(input.getText().toString()))
                .setNeutralButton("ล้างแคชสื่อ", (d, w) -> {
                    cache.clear();
                    web.clearCache(true);
                    Toast.makeText(this, "ล้างแคชแล้ว", Toast.LENGTH_SHORT).show();
                    loadPlayer();
                })
                .setNegativeButton("ตั้งค่า Android", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_SETTINGS));
                    } catch (Exception e) {
                        Toast.makeText(this, "เปิดการตั้งค่าไม่ได้", Toast.LENGTH_SHORT).show();
                    }
                })
                .create();
        dlg.setOnDismissListener(d -> {
            settingsOpen = false;
            enterImmersive();
        });
        dlg.show();
        input.requestFocus();
    }

    private void saveServer(String raw) {
        String s = raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) {
            Toast.makeText(this, "ที่อยู่ไม่ถูกต้อง", Toast.LENGTH_LONG).show();
            return;
        }
        prefs.edit().putString(KEY_SERVER, s).apply();
        loadPlayer();
        askOverlayPermissionOnce();
    }

    /** Android 10+ only lets an app open itself after boot if it may draw over other apps. */
    @TargetApi(23)
    private void askOverlayPermissionOnce() {
        if (Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(this)) return;
        if (prefs.getBoolean(KEY_OVERLAY_ASKED, false)) return;
        prefs.edit().putBoolean(KEY_OVERLAY_ASKED, true).apply();
        new AlertDialog.Builder(this)
                .setTitle("เปิดแอปอัตโนมัติเมื่อเปิดเครื่อง")
                .setMessage("Android รุ่นนี้ต้องอนุญาต \"แสดงทับแอปอื่น\" ให้ SC Signage ก่อน แอปจึงจะเปิดเองหลังบูตได้\n"
                        + "(หรือตั้ง SC Signage เป็นหน้า Home ของกล่องแทนก็ได้)")
                .setPositiveButton("ไปที่การตั้งค่า", (d, w) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        Toast.makeText(this, "กล่องนี้ไม่มีหน้าตั้งค่านี้ — ตั้งเป็นหน้า Home แทน", Toast.LENGTH_LONG).show();
                    }
                })
                .setNegativeButton("ข้าม", null)
                .show();
    }

    private boolean secretTap() {
        long now = SystemClock.elapsedRealtime();
        if (now - secretStart > 3000) { secretStart = now; secretCount = 0; }
        secretCount++;
        if (secretCount >= 5) { secretCount = 0; openSettings(); return true; }
        return false;
    }

    // ------------------------------------------------------------ input
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (e.getAction() == KeyEvent.ACTION_UP && !settingsOpen) {
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) { secretTap(); return true; }
            if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS) { openSettings(); return true; }
            if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_INFO) {
                web.evaluateJavascript("window.scShowInfo && window.scShowInfo()", null);
                return true;
            }
        }
        if (!settingsOpen && (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE
                || code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS)) {
            return true; // swallow key-down so the kiosk never closes
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev.getAction() == MotionEvent.ACTION_DOWN && !settingsOpen) {
            float w = root.getWidth(), h = root.getHeight();
            if (ev.getX() < w * 0.15f && ev.getY() < h * 0.15f && secretTap()) return true;
        }
        return super.dispatchTouchEvent(ev);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // ignored: kiosk mode (BACK x5 opens settings via dispatchKeyEvent)
    }

    // ------------------------------------------------------------ lifecycle / UI
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        enterImmersive();
    }

    @Override
    protected void onPause() {
        // keep playing: a signage box has nothing else in front of it
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------- หน้าโลโก้ตอนเปิดแอป ----------
    private ImageView splash;

    private void showSplash() {
        splash = new ImageView(this);
        splash.setImageResource(R.drawable.splash_logo);
        splash.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        splash.setBackgroundColor(Color.WHITE);
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // กันค้าง: ถ้าหน้าเล่นโหลดไม่ขึ้น เอาโลโก้ออกใน 30 วินาทีเพื่อให้เห็นข้อความแจ้งปัญหา
        handler.postDelayed(hideSplash, 30_000);
    }

    private final Runnable hideSplash = new Runnable() {
        @Override public void run() {
            if (splash == null) return;
            root.removeView(splash);
            splash = null;
        }
    };

    private TextView message;

    private void showMessage(String text) {
        if (message == null) {
            message = new TextView(this);
            message.setTextColor(Color.WHITE);
            message.setBackgroundColor(Color.BLACK);
            message.setTextSize(22);
            message.setGravity(android.view.Gravity.CENTER);
            root.addView(message, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        message.setText(text);
        message.setVisibility(View.VISIBLE);
        message.bringToFront(); // ข้อความแจ้งปัญหาต้องอยู่เหนือโลโก้
    }

    private void hideMessage() {
        if (message != null) message.setVisibility(View.GONE);
    }

    @SuppressLint("HardwareIds")
    private String makeScreenId() {
        String saved = prefs.getString("screen_id", "");
        if (!saved.isEmpty()) return saved;
        String aid = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (aid == null || aid.length() < 6) aid = Long.toHexString(System.nanoTime());
        String id = "box-" + aid.substring(0, Math.min(8, aid.length())).toLowerCase(Locale.US);
        prefs.edit().putString("screen_id", id).apply();
        return id;
    }
}
