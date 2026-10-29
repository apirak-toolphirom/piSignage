/*
 * SC Signage — ESP32 ตัดไฟทีวีตามตารางเวลา
 * ------------------------------------------------------------------
 * ESP32 ถาม server ว่าตอนนี้ทีวีควรเปิดหรือปิด (ตารางเดียวกับที่ตั้งในหน้า Groups)
 * แล้วสั่งรีเลย์ตัด/ต่อไฟ AC ที่เข้าทีวี
 *
 * endpoint:  GET http://<server>:3000/api/tv/<groupId>?fmt=text   ->  "1" (เปิด) หรือ "0" (ปิด)
 * ใช้ groupId หรือ player id ก็ได้ (หา groupId ได้จากหน้า Groups ของ server หรือใช้ "gdefault")
 *
 * บอร์ด: ESP32 dev board · ไลบรารี: ในตัว ESP32 core ไม่ต้องลงเพิ่ม
 * ------------------------------------------------------------------
 * ⚠ ความปลอดภัย: รีเลย์ตัดไฟ AC 220V — เดินสายไฟฟ้าให้มิดชิด ใส่กล่องหุ้ม
 *   ต่อไฟ AC ที่ขั้ว COM กับ NO (Normally Open) เพื่อให้ "ไฟดับ" เมื่อ ESP32 ไม่ทำงาน
 *   ปิดไฟก่อนต่อสายทุกครั้ง
 */

#include <WiFi.h>
#include <HTTPClient.h>

// ===================== ตั้งค่าตรงนี้ =====================
const char* WIFI_SSID = "ชื่อ-WiFi";
const char* WIFI_PASS = "รหัส-WiFi";

// ที่อยู่ server และกลุ่มของจอนี้ (ดู groupId ในหน้า Groups หรือใช้ "gdefault")
const char* SERVER   = "http://192.168.1.105:3000";
const char* GROUP_ID = "gdefault";

const int   RELAY_PIN       = 26;     // ขาต่อ IN ของโมดูลรีเลย์
const bool  RELAY_ACTIVE_LOW = true;  // โมดูลรีเลย์จีนส่วนใหญ่สั่งงานด้วย LOW — ถ้ารีเลย์ทำงานกลับด้าน เปลี่ยนเป็น false
const int   LED_PIN         = 2;      // ไฟสถานะบนบอร์ด (ติด=ทีวีเปิด)

const unsigned long POLL_MS = 30000;  // ถาม server ทุก 30 วินาที
const int   CONFIRM_COUNT   = 2;      // ต้องได้ค่าเดิมติดกันกี่ครั้งจึงสลับรีเลย์ (กันกระพริบ)
const bool  FAIL_SAFE_ON    = true;   // ติดต่อ server ไม่ได้นานๆ จะให้ทีวี "เปิด" ไว้ (true) หรือคงสถานะเดิม (false)
const int   FAIL_LIMIT      = 10;     // จำนวนครั้งที่ถามไม่สำเร็จติดกันก่อนใช้ fail-safe
// ========================================================

bool tvOn = true;          // สถานะที่สั่งรีเลย์อยู่
int  pendingVal = -1;      // ค่าที่กำลังรอยืนยัน
int  pendingCount = 0;
int  failCount = 0;

void setRelay(bool on) {
  tvOn = on;
  digitalWrite(RELAY_PIN, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(LED_PIN, on ? HIGH : LOW);
  Serial.printf("[relay] TV %s\n", on ? "ON" : "OFF");
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(300); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[wifi] ok, ip=%s\n", WiFi.localIP().toString().c_str());
  else Serial.println("[wifi] failed, will retry");
}

// คืนค่า 1=เปิด 0=ปิด -1=ติดต่อไม่ได้
int fetchTvState() {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  String url = String(SERVER) + "/api/tv/" + GROUP_ID + "?fmt=text";
  http.begin(url);
  http.setTimeout(8000);
  int code = http.GET();
  int result = -1;
  if (code == 200) {
    String body = http.getString();
    body.trim();
    if (body == "1") result = 1;
    else if (body == "0") result = 0;
  } else {
    Serial.printf("[http] GET %s -> %d\n", url.c_str(), code);
  }
  http.end();
  return result;
}

void poll() {
  int v = fetchTvState();

  if (v < 0) {                       // ติดต่อ server ไม่ได้
    failCount++;
    if (FAIL_SAFE_ON && failCount >= FAIL_LIMIT && !tvOn) {
      Serial.println("[fail-safe] server ติดต่อไม่ได้นาน -> เปิดทีวีไว้");
      setRelay(true);
    }
    return;                          // ไม่งั้นคงสถานะเดิมไว้
  }
  failCount = 0;

  bool want = (v == 1);
  if (want == tvOn) { pendingVal = -1; pendingCount = 0; return; }  // ตรงกับที่เป็นอยู่แล้ว

  // ต้องได้ค่าใหม่ซ้ำกันหลายครั้งก่อนสลับจริง (กันกระพริบตอนเวลาคาบเกี่ยว)
  if (v == pendingVal) pendingCount++;
  else { pendingVal = v; pendingCount = 1; }
  if (pendingCount >= CONFIRM_COUNT) {
    setRelay(want);
    pendingVal = -1; pendingCount = 0;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  setRelay(true);                    // เริ่มต้น: ทีวีเปิด แล้วค่อยปรับตามตาราง
  connectWifi();
  poll();
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last >= POLL_MS) {
    last = millis();
    connectWifi();
    poll();
  }
  delay(50);
}
