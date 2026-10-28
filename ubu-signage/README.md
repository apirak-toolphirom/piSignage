# UBU Signage — ระบบจอประชาสัมพันธ์ในวง LAN

ระบบ digital signage แบบ local ไม่มีค่าไลเซนส์ ใช้กล่อง Android เป็นเครื่องเล่น เหมาะกับจอ 5–10 จอในห้องประชุมและห้องเรียน

```
[ เซิร์ฟเวอร์ (PC / VM / Raspberry Pi) ]  ←— LAN —→  [ กล่อง Android + จอ ] × N
   /admin  จัดการสื่อ, playlist, ตารางเวลา              แอป UBU Signage (เต็มจอ, เปิดเองตอนบูต)
   /player หน้าเล่นสำหรับจอ                             เก็บสื่อไว้ในเครื่อง เล่นต่อได้แม้เน็ตหลุด
```

## ความสามารถ

- อัปโหลดรูป/วิดีโอ (ลากวางได้หลายไฟล์) และเพิ่มหน้าเว็บเป็นสไลด์
- Playlist: กำหนดเวลาแสดงแต่ละชิ้น, พอดีจอ/เต็มจอ, ปิดเสียงวิดีโอ, เรียงลำดับ
- ตารางเวลาต่อจอ: เลือกวันในสัปดาห์ ช่วงเวลา และช่วงวันที่ (เช่น งานประชุมเฉพาะวัน) — รายการบนสุดมีสิทธิ์ก่อน นอกเวลาใช้ playlist หลัก
- จัดกลุ่มจอ (เช่น "ห้องประชุม", "ห้องเรียน") และคัดลอกการตั้งค่าไปทั้งกลุ่ม
- ข้อความวิ่งด้านล่าง: ข้อความรวมทุกจอ หรือเฉพาะจอ
- หมุนจอ 90/180/270° สำหรับจอแนวตั้ง
- ดูสถานะออนไลน์ของแต่ละจอ, สั่งรีโหลดจอจากหน้า admin
- จอใหม่ลงทะเบียนเองอัตโนมัติเมื่อแอปเชื่อมต่อครั้งแรก
- ออฟไลน์: กล่องเก็บ playlist ล่าสุดและไฟล์สื่อไว้ในเครื่อง ถ้าเซิร์ฟเวอร์หรือเน็ตล่มก็ยังเล่นต่อ
- แอปมี watchdog: หน้าเล่นค้างหรือ WebView crash จะโหลดใหม่เอง และรีเฟรชทุก 24 ชม.

## 1. ติดตั้งเซิร์ฟเวอร์

เลือกเครื่องที่เปิดตลอดในวง LAN เดียวกับกล่อง (ตั้ง IP คงที่ให้เครื่องนี้)

**แบบ A — Ubuntu/Debian/Raspberry Pi OS (systemd)**

```bash
cd ubu-signage/server
sudo ADMIN_PASS=รหัสผ่านของคุณ ./install-ubuntu.sh
```

**แบบ B — Docker**

```bash
cd ubu-signage/server
# แก้ ADMIN_PASS ใน docker-compose.yml ก่อน
docker compose up -d
```

**แบบ C — รันเอง (Windows/Linux ที่มี Node.js 18+)**

```bash
cd ubu-signage/server
npm install
ADMIN_PASS=รหัสผ่าน node server.js        # Windows: set ADMIN_PASS=รหัสผ่าน && node server.js
```

เปิด `http://<IP เซิร์ฟเวอร์>:3000/admin` ผู้ใช้ `admin`

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | 3000 | พอร์ต |
| `ADMIN_USER` / `ADMIN_PASS` | admin / admin1234 | บัญชีหน้า admin (ควรเปลี่ยน) |
| `DATA_DIR` | `server/data` | ที่เก็บ `db.json` และไฟล์สื่อ — สำรองโฟลเดอร์นี้โฟลเดอร์เดียวพอ |
| `MAX_UPLOAD_MB` | 2048 | ขนาดไฟล์อัปโหลดสูงสุด |

## 2. ติดตั้งแอปบนกล่อง Android

1. ดาวน์โหลด `ubu-signage.apk` จากแท็บ **Actions** ของ repo (หรือจาก Releases ถ้าติด tag `signage-v1.0.0`)
2. ติดตั้งบนกล่อง (เปิด "ติดตั้งแอปจากแหล่งที่ไม่รู้จัก" ก่อน)
3. เปิดแอป → ใส่ที่อยู่เซิร์ฟเวอร์ เช่น `http://192.168.1.10:3000` → บันทึก
4. จอจะขึ้นในหน้า admin แท็บ "จอ" — ตั้งชื่อ กลุ่ม และเลือก playlist

ตั้งค่ากล่องให้เหมาะกับงาน signage:

- **ตั้ง UBU Signage เป็นหน้า Home** (กดปุ่ม Home แล้วเลือก UBU Signage → "ทุกครั้ง") วิธีนี้เปิดเองหลังบูตได้ชัวร์ที่สุด
- Android 10 ขึ้นไป: อนุญาต "แสดงทับแอปอื่น" ตามที่แอปถาม ถ้าไม่ได้ตั้งเป็น Home
- ปิดโหมดพักหน้าจอ/screensaver ของกล่อง
- ตั้งเขตเวลาเป็น **Asia/Bangkok** — ตารางเวลาคิดตามนาฬิกาของกล่อง
- ใช้สาย LAN ถ้าทำได้ เสถียรกว่า Wi-Fi

ปุ่มรีโมท: กด **BACK 5 ครั้งเร็วๆ** หรือ **MENU** = เปิดหน้าตั้งค่า, **OK** = แสดงข้อมูลจอ (ID, สถานะ) · จอสัมผัส: แตะมุมซ้ายบน 5 ครั้ง

ไม่มีกล่อง Android? เปิด `http://<server>:3000/player/?id=ชื่อจอ` ในเบราว์เซอร์ของสมาร์ททีวีหรือ PC แบบเต็มจอได้ (แต่ไม่เก็บไฟล์สื่อไว้เล่นออฟไลน์)

## 3. เตรียมสื่อ

- รูป: JPG/PNG/WebP ขนาด 1920×1080 (จอแนวตั้ง 1080×1920)
- วิดีโอ: MP4 (H.264 + AAC) ไม่เกิน 1080p — กล่องราคาประหยัดหลายรุ่นเล่น 4K/H.265 ได้ไม่ลื่น
  แปลงด้วย ffmpeg: `ffmpeg -i in.mov -c:v libx264 -preset veryfast -crf 23 -vf scale=-2:1080 -c:a aac out.mp4`
- หน้าเว็บ: บางเว็บห้ามฝังใน iframe (จะขึ้นหน้าว่าง) — ทดสอบด้วยปุ่ม "ดูตัวอย่าง" ในหน้าจอนั้น
- ระยะเวลา 0 กับวิดีโอ = เล่นจนจบ

## 4. Build APK เอง

GitHub Actions (`.github/workflows/ubu-signage-apk.yml`) build ให้อัตโนมัติเมื่อ push โค้ดใน `ubu-signage/android/`
build ในเครื่อง: เปิดโฟลเดอร์ `ubu-signage/android` ด้วย Android Studio แล้ว Build → Build APK, หรือ `gradle assembleRelease`

APK เซ็นด้วยคีย์ใน `android/keystore/` เพื่อให้ติดตั้งเวอร์ชันใหม่ทับได้โดยไม่ต้องถอนแอป
ถ้า repo เป็น public แนะนำสร้างคีย์ใหม่ (`keytool -genkeypair ...`) แล้วใส่รหัสผ่านใน GitHub Secrets
`SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`

## โครงสร้าง

```
ubu-signage/
├─ server/
│  ├─ server.js              API + เสิร์ฟหน้า admin/player
│  ├─ public/admin/          หน้าจัดการ (ภาษาไทย)
│  ├─ public/player/         หน้าเล่น (ES5 รองรับ WebView รุ่นเก่า)
│  ├─ install-ubuntu.sh, Dockerfile, docker-compose.yml
│  └─ data/                  db.json + media/ (สร้างอัตโนมัติ)
└─ android/                  แอป kiosk (Java, minSdk 21 = Android 5+)
   └─ app/src/main/java/th/ac/ubu/signage/
      ├─ MainActivity.java   WebView เต็มจอ, ตั้งค่า, watchdog
      ├─ MediaCache.java     เก็บสื่อ/หน้าเล่นไว้ในเครื่อง (รองรับ Range สำหรับวิดีโอ)
      └─ BootReceiver.java   เปิดแอปเมื่อบูต
```

## API (สำหรับต่อยอด)

ฝั่งจอ (ไม่ต้องล็อกอิน): `GET /api/player/:screenId` คืน config ทั้งหมดที่จอนั้นต้องใช้
ฝั่ง admin (Basic Auth) ที่ `/api/admin/…`: `state`, `media` (POST multipart `files`), `media/web`, `playlists`, `screens/:id`, `screens/:id/copy`, `screens/:id|all/reload`, `settings`

ตัวอย่าง layout HTML ในโฟลเดอร์ `examples/` ของ repo (นาฬิกา, อากาศ, countdown ฯลฯ) นำไปเปิดผ่านเว็บเซิร์ฟเวอร์ใดก็ได้แล้วเพิ่มเป็น "หน้าเว็บ" ใน playlist
