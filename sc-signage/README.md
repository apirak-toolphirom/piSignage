# SC Signage — ระบบจอประชาสัมพันธ์ในวง LAN (แนวทางเดียวกับ piSignage)

ระบบ digital signage แบบ local ไม่มีค่าไลเซนส์ ใช้กล่อง Android เป็นเครื่องเล่น เหมาะกับจอ 5–10 จอในห้องประชุมและห้องเรียน
ลำดับการใช้งานเหมือน piSignage:

```
1. Assets      อัปโหลดรูป / วิดีโอ / HTML (.zip) / ลิงก์เว็บ / สร้างประกาศข้อความ
2. Playlists   เลือก layout (1 โซน – 3 โซน), ใส่ asset ลงโซน main / side / bottom, ตั้งเวลาแต่ละชิ้น, ข้อความวิ่ง
3. Groups      ผูกจอเข้ากลุ่ม (เช่น ห้องประชุม, ห้องเรียน), เลือก playlist + ตารางเวลา, เวลาเปิด/ปิดจอ, การหมุนจอ
               → กด "Deploy" จอในกลุ่มจึงได้รับเนื้อหาใหม่
4. แดชบอร์ด   ดูจอออนไลน์, กำลังเล่นอะไร, ภาพหน้าจอจริง, สั่งรีโหลด
```

```
[ เซิร์ฟเวอร์ (PC / VM / Raspberry Pi) ]  ←— LAN —→  [ กล่อง Android + จอ ] × N
   /admin   หน้าจัดการ                                  แอป SC Signage: เต็มจอ, เปิดเองตอนบูต,
   /player  หน้าเล่นสำหรับจอ                             เก็บสื่อในเครื่อง เล่นต่อได้แม้เน็ตหลุด
```

## เทียบกับ piSignage

| piSignage | SC Signage |
|---|---|
| Assets: รูป, วิดีโอ, ลิงก์, HTML zip, notice | ✔ ครบ + วันเริ่ม/วันหมดอายุของ asset (จอข้ามเองตามวันที่) |
| Layout 1, 2a–2d, 3a–3d, 4a–4d, แนวตั้ง | ✔ ขนาดโซนเท่ากับของ piSignage (+ 2bp แนวตั้ง) |
| Asset หลายโซนต่อแถว (main/side/bottom) | ✔ |
| Ticker ใน playlist | ✔ |
| Groups + ตารางเวลา playlist + Deploy | ✔ (แก้ไขแล้วยังไม่ส่งจอจนกว่าจะ Deploy, มีแถบเตือน "รอ deploy") |
| TV on/off ตามเวลา + วันพิเศษ | ✔ จอดำ/ลดแสง (ปิดทีวีจริงต้องใช้ HDMI-CEC ซึ่งแอปทั่วไปบน Android สั่งไม่ได้) |
| Emergency message / playlist ทุกจอ | ✔ มีผลทันทีไม่ต้อง Deploy |
| Dashboard + snapshot หน้าจอ | ✔ (snapshot เฉพาะแอป Android) |
| Ads playlist, domination, reports, piShell, หลายผู้ใช้ | ✘ ยังไม่มี |
| ค่าไลเซนส์ต่อจอ | ไม่มี |

## 1. ติดตั้งเซิร์ฟเวอร์

เลือกเครื่องที่เปิดตลอดในวง LAN เดียวกับกล่อง (ตั้ง IP คงที่ให้เครื่องนี้)

**แบบ A — Ubuntu/Debian/Raspberry Pi OS (systemd)**

```bash
cd sc-signage/server
sudo ADMIN_PASS=รหัสผ่านของคุณ ./install-ubuntu.sh
```

**แบบ B — Docker**

```bash
cd sc-signage/server
# แก้ ADMIN_PASS ใน docker-compose.yml ก่อน
docker compose up -d
```

**แบบ C — รันเอง (Windows/Linux ที่มี Node.js 18+)**

```bash
cd sc-signage/server
npm install
ADMIN_PASS=รหัสผ่าน node server.js        # Windows: set ADMIN_PASS=รหัสผ่าน && node server.js
```

เปิด `http://<IP เซิร์ฟเวอร์>:3000/admin/` ผู้ใช้ `admin`

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | 3000 | พอร์ต |
| `ADMIN_USER` / `ADMIN_PASS` | admin / admin1234 | บัญชีหน้า admin (ควรเปลี่ยน) |
| `DATA_DIR` | `server/data` | ที่เก็บ `db.json`, `media/`, `snapshots/` — สำรองโฟลเดอร์นี้โฟลเดอร์เดียวพอ |
| `MAX_UPLOAD_MB` | 2048 | ขนาดไฟล์อัปโหลดสูงสุด |

อัปเกรดจากเวอร์ชันแรก: เซิร์ฟเวอร์แปลงข้อมูลให้เองตอนเปิด (สำรองไว้ที่ `db.json.v1-backup`) — จอเดิมถูกจัดเข้ากลุ่มตามชื่อกลุ่มเดิมและ Deploy ให้อัตโนมัติ

## 2. ติดตั้งแอปบนกล่อง Android

1. ดาวน์โหลด `sc-signage.apk` จากแท็บ **Actions** ของ repo (หรือ Releases ถ้าติด tag `signage-v1.1.0`)
2. ติดตั้งบนกล่อง (เปิด "ติดตั้งแอปจากแหล่งที่ไม่รู้จัก" ก่อน)
3. เปิดแอป → ใส่ที่อยู่เซิร์ฟเวอร์ เช่น `http://192.168.1.10:3000` → บันทึก
4. จอขึ้นในแดชบอร์ด อยู่กลุ่ม "ค่าเริ่มต้น" — กด "แก้ไข" เพื่อตั้งชื่อและย้ายกลุ่ม

ตั้งค่ากล่องให้เหมาะกับงาน signage:

- **ตั้ง SC Signage เป็นหน้า Home** (กดปุ่ม Home แล้วเลือก SC Signage → "ทุกครั้ง") เปิดเองหลังบูตได้ชัวร์ที่สุด
- Android 10 ขึ้นไป: อนุญาต "แสดงทับแอปอื่น" ตามที่แอปถาม ถ้าไม่ได้ตั้งเป็น Home
- ปิด screensaver/โหมดพักของกล่อง, ตั้งเขตเวลา **Asia/Bangkok** (ตารางเวลาคิดตามนาฬิกากล่อง)
- ใช้สาย LAN ถ้าทำได้

ปุ่มรีโมท: **BACK 5 ครั้งเร็วๆ** หรือ **MENU** = หน้าตั้งค่า, **OK** = ข้อมูลจอ (ID, กลุ่ม, กำลังเล่น, deploy ล่าสุด) · จอสัมผัส: แตะมุมซ้ายบน 5 ครั้ง

ไม่มีกล่อง Android? เปิด `http://<server>:3000/player/?id=ชื่อจอ` ในเบราว์เซอร์ของสมาร์ททีวีหรือ PC แบบเต็มจอได้ (ไม่มี snapshot และไม่เก็บสื่อไว้เล่นออฟไลน์)

### กล่อง AIS Playbox (Inspur IPBS9210, Android 7.1)

ทดสอบแล้วใช้ได้ (หน้าเล่น ES5 รันบน WebView 52 ของกล่องได้) — ขั้นตอนเฉพาะรุ่นนี้ผ่าน ADB:

```
adb install -r sc-signage.apk
adb shell pm disable-user --user 0 com.ais.playbox          # ปิด launcher AIS → บูตเข้า SC Signage
adb shell pm disable-user --user 0 com.inspur.httpupgrade   # ตัวอัปเดตเฟิร์มแวร์
adb shell pm disable-user --user 0 com.inspur.tr069         # การจัดการระยะไกลของ AIS
adb shell pm disable-user --user 0 com.wisdomvast.aiskaraoke
adb shell pm disable-user --user 0 com.inspur.clingdlna     # กันคนแคสต์ภาพขึ้นจอ

# กล่องที่ต่อ WiFi จะมีข้อความ "แนะนำให้ใช้สาย LAN" เด้งทับทุกครั้งที่บูต (มาจาก com.android.settings.ais
# ซึ่งปิดจาก ADB ไม่ได้) → เปิดบริการปิดข้อความอัตโนมัติของแอป:
adb shell settings put secure enabled_accessibility_services th.ac.ubu.scsignage/th.ac.ubu.scsignage.AutoDismissService
adb shell settings put secure accessibility_enabled 1
```

ห้ามปิด `com.android.settings.ais` (หน้าตั้งค่า) และ `com.inspur.factory` · เปิดคืนแพ็กเกจใดๆ: `adb shell pm enable <ชื่อแพ็กเกจ>`
โลโก้บูตของเฟิร์มแวร์ (AIS) เปลี่ยนไม่ได้ถ้าไม่ root — แอปจะแสดงโลโก้คณะทันทีที่เปิดจนหน้าเล่นพร้อม

## 3. เตรียมสื่อ

ขนาดโซนตาม layout (จอ 1920×1080):

| โซน | layout 2a/2b | 3a/3b/3c/3d | 4a–4d |
|---|---|---|---|
| main | 1440×1080 | 1440×810 | 1440×810 |
| side | 480×1080 | 480×810 | 480×1080 |
| bottom | — | 1920×270 | 1440×270 |

- รูป: JPG/PNG/WebP · วิดีโอ: MP4 (H.264 + AAC) ไม่เกิน 1080p — กล่องราคาประหยัดหลายรุ่นเล่น 4K/H.265 ไม่ลื่น
  `ffmpeg -i in.mov -c:v libx264 -preset veryfast -crf 23 -vf scale=-2:1080 -c:a aac out.mp4`
- HTML: zip ทั้งโฟลเดอร์ที่มี `index.html` แล้วอัปโหลด — ใช้วิดเจ็ตในโฟลเดอร์ `examples/` ของ repo นี้ได้ (นาฬิกา, countdown ฯลฯ)
- ลิงก์เว็บ: บางเว็บห้ามฝังใน iframe (ขึ้นหน้าว่าง) — ทดสอบด้วย "ดูตัวอย่าง" ในแดชบอร์ด
- ระยะเวลา 0 กับวิดีโอ = เล่นจนจบ · วิดีโอในโซน side/bottom เล่นวนแบบปิดเสียง

## 4. Build APK เอง

GitHub Actions (`.github/workflows/sc-signage-apk.yml`) build ให้อัตโนมัติเมื่อ push โค้ดใน `sc-signage/android/`
หรือเปิด `sc-signage/android` ด้วย Android Studio → Build APK / `gradle assembleRelease`

APK เซ็นด้วยคีย์ใน `android/keystore/` เพื่อให้ติดตั้งเวอร์ชันใหม่ทับได้ ถ้า repo เป็น public แนะนำสร้างคีย์ใหม่
แล้วใส่รหัสผ่านใน GitHub Secrets `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`

## โครงสร้าง

```
sc-signage/
├─ server/
│  ├─ server.js              API, deploy, layout, migration
│  ├─ public/admin/          หน้าจัดการ (แดชบอร์ด / Assets / Playlists / Groups / ตั้งค่า)
│  ├─ public/player/         หน้าเล่น (ES5 รองรับ WebView รุ่นเก่า)
│  └─ install-ubuntu.sh, Dockerfile, docker-compose.yml
└─ android/                  แอป kiosk (Java, Android 5+)
   └─ app/src/main/java/th/ac/ubu/signage/
      ├─ MainActivity.java   WebView เต็มจอ, ตั้งค่า, watchdog, snapshot, ลดแสงตอนปิดจอ
      ├─ MediaCache.java     เก็บสื่อ/หน้าเล่นในเครื่อง (รองรับ Range สำหรับวิดีโอ)
      └─ BootReceiver.java   เปิดแอปเมื่อบูต
```

## API (สำหรับต่อยอด)

ฝั่งจอ (ไม่ต้องล็อกอิน): `GET /api/player/:id` คืนเนื้อหาที่ deploy ให้กลุ่มของจอ, `POST /api/player/:id/snapshot` (image/jpeg)
ฝั่ง admin (Basic Auth) ที่ `/api/admin/…`: `state`, `assets` (multipart `files`), `assets/web`, `assets/notice`, `playlists`, `playlists/:id/copy`,
`groups`, `groups/:id|all/deploy`, `players/:id`, `players/:id|all/reload|snapshot`, `snapshot/:id`, `settings` (emergency)
