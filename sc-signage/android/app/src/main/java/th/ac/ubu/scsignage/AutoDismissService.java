package th.ac.ubu.scsignage;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

/**
 * กดปิดข้อความเตือนของเฟิร์มแวร์ AIS/Inspur ที่เด้งทับจอ (เช่น "ขอแนะนำให้เปลี่ยนมาเชื่อมต่อด้วยสาย LAN")
 * กล่องรุ่นนี้ปิดตัวแจ้งเตือนจาก ADB ไม่ได้ (Shell cannot change component state) จึงให้แอปกดปุ่มปิดแทน
 *
 * เปิดใช้ครั้งเดียวผ่าน ADB:
 *   adb shell settings put secure enabled_accessibility_services th.ac.ubu.scsignage/th.ac.ubu.scsignage.AutoDismissService
 *   adb shell settings put secure accessibility_enabled 1
 */
public class AutoDismissService extends AccessibilityService {
    private static final String TAG = "ScAutoDismiss";

    /** กดเฉพาะหน้าต่างของแพ็กเกจเหล่านี้ — ไม่ไปกดอะไรในแอปอื่น */
    private static final String[] PACKAGES = {
            "com.android.settings.ais", "com.inspur.", "com.ais.", "net.vimmi.",
    };
    /**
     * ข้อความบนปุ่มที่ใช้ปิด — ใส่เฉพาะปุ่มของข้อความเตือนที่รู้จักแล้วเท่านั้น
     * ห้ามใส่คำกว้างๆ อย่าง "ตกลง"/"OK" เพราะหน้าตั้งค่า AIS ก็ใช้ปุ่มนี้ในกล่องยืนยัน (เช่น รีเซ็ตเครื่อง)
     */
    private static final String[] BUTTONS = {
            "ปิดหน้าจอนี้",
    };

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable scan = new Runnable() {
        @Override public void run() { scanAllWindows(); }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "connected");
        // ข้อความอาจเด้งขึ้นก่อนบริการพร้อม: ไล่ตรวจซ้ำช่วงหลังบูต
        for (long d : new long[]{1000, 4000, 10000, 20000, 40000, 60000}) handler.postDelayed(scan, d);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        CharSequence pkg = event.getPackageName();
        if (pkg != null && !isTarget(pkg.toString())) return;
        AccessibilityNodeInfo src = event.getSource();
        if (src != null && tryDismiss(rootOf(src))) return;
        // บางเฟิร์มแวร์ไม่ส่ง source มากับ event: ตรวจทุกหน้าต่างแทน
        handler.removeCallbacks(scan);
        handler.postDelayed(scan, 300);
    }

    private void scanAllWindows() {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows == null) return;
            for (AccessibilityWindowInfo w : windows) {
                AccessibilityNodeInfo root = w.getRoot();
                if (root != null && root.getPackageName() != null
                        && isTarget(root.getPackageName().toString()) && tryDismiss(root)) return;
            }
        } catch (Exception e) {
            Log.w(TAG, "scan", e);
        }
    }

    private boolean tryDismiss(AccessibilityNodeInfo root) {
        if (root == null || root.getPackageName() == null || !isTarget(root.getPackageName().toString())) return false;
        for (String label : BUTTONS) {
            List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByText(label);
            if (found == null) continue;
            for (AccessibilityNodeInfo n : found) {
                CharSequence t = n.getText();
                // ตรงทั้งคำเท่านั้น (กันไปกดเมนูที่มีคำว่า "ปิด" อยู่ในประโยค)
                if (t == null || !t.toString().trim().equalsIgnoreCase(label)) continue;
                AccessibilityNodeInfo c = n;
                while (c != null && !c.isClickable()) c = c.getParent();
                if (c != null && c.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    Log.i(TAG, "dismissed '" + label + "' in " + root.getPackageName());
                    return true;
                }
            }
        }
        return false;
    }

    private static AccessibilityNodeInfo rootOf(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo r = n;
        for (int i = 0; i < 50; i++) {
            AccessibilityNodeInfo p = r.getParent();
            if (p == null) break;
            r = p;
        }
        return r;
    }

    private static boolean isTarget(String pkg) {
        for (String p : PACKAGES) if (pkg.equals(p) || (p.endsWith(".") && pkg.startsWith(p))) return true;
        return false;
    }

    @Override
    public void onInterrupt() { }
}
