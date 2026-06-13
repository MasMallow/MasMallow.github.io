# คู่มือเอาขึ้น GitHub Pages + Firebase

สถาปัตยกรรม: หน้าเว็บ (static) อยู่บน **GitHub Pages** ที่ `https://masmallow.github.io/` ส่วนข้อมูลบิลด์/คอมป์อยู่บน **Firebase Realtime Database** (ฟรี) — สมาชิกกิลด์เปิดดูได้ทุกคนแบบเรียลไทม์ แก้ได้เฉพาะคนที่ล็อกอิน + อยู่ใน allowlist

> โปรเจกต์ **albion-de483** (region: asia-southeast1) ถูกตั้งไว้แล้ว — คู่มือนี้ใช้กับโปรเจกต์เดิมต่อ

---

## ขั้นที่ 1 — ติดตั้ง Security Rules (ครั้งเดียว, สำคัญที่สุด!)

ถ้าไม่ติดตั้ง = database เปิดให้ใครก็เขียนได้ → ลบข้อมูลกิลด์ได้ในไม่กี่วินาที

1. ไปที่ [console.firebase.google.com](https://console.firebase.google.com) → เลือกโปรเจกต์ **albion-de483**
2. เมนูซ้าย **Build → Realtime Database** → แท็บ **Rules**
3. ลบของเดิมทั้งหมด เปิดไฟล์ [`database.rules.json`](database.rules.json) คัดลอกทั้งไฟล์มาวาง → **Publish**

## ขั้นที่ 2 — สร้างบัญชีผู้จัดทีม

1. เมนูซ้าย **Build → Authentication** → ปุ่ม **Get started** (ถ้าเพิ่งเปิดครั้งแรก)
2. แท็บ **Sign-in method** → คลิก **Email/Password** → เปิด toggle อันแรก → Save
3. แท็บ **Users** → **Add user** → ใส่อีเมล + **รหัสผ่านที่แข็งแรง 12 ตัวขึ้นไป** (จุดล็อกอินเปิดสู่อินเทอร์เน็ต — รหัสอ่อนถูกเดาได้) → Add user
4. **คัดลอก UID ของบัญชี** (อยู่ในคอลัมน์ "User UID" — ตัวอักษรยาวๆ)

## ขั้นที่ 3 — เพิ่มบัญชีเข้า allowlist ⚠ ต้องทำ ไม่งั้นล็อกอินก็ยังแก้ไม่ได้

1. กลับไป **Realtime Database** → แท็บ **Data**
2. ที่ root กดเครื่องหมาย **+** → ใส่ key = `organizers` → ค่าว่างไว้ → Add
3. คลิกที่ `organizers` ที่เพิ่งสร้าง → กด **+** → ใส่ key = `<UID ที่คัดลอกไว้>` → value = `true` (boolean ตัวเล็ก) → Add

โครงสร้างต้องเป็นแบบนี้:
```
albion-de483-default-rtdb
└── organizers
    └── abc123XYZ...   : true
    └── def456ABC...   : true   (เพิ่มคนอื่นได้ที่นี่)
```

> **ถอดสิทธิ์ผู้จัด**: ลบ key ของ UID ในข้อนี้ออก (ไม่ต้องลบบัญชีออกจาก Auth)

## ขั้นที่ 4 — ปิดรับสมัครเอง (defense in depth)

แม้จะมี allowlist กั้นไว้แล้ว แต่ปิดเพื่อไม่ให้บัญชีขยะรกระบบ:

1. **Authentication → Settings → User actions**
2. ปิด **Enable create (sign-up)** → Save

## ขั้นที่ 5 — Push ขึ้น GitHub

config.js ปัจจุบันมีคีย์ของโปรเจกต์ albion-de483 ใส่ไว้แล้ว — ดับเบิลคลิก **`publish.bat`** ในโฟลเดอร์ `albion`

`publish.bat` จะ:
1. สร้าง `items.json` ใหม่จากรูปในโฟลเดอร์ (เพิ่มรูปไอเทมใหม่ก็แค่รันนี้ซ้ำ)
2. คัดลอกไฟล์แอป + Firebase SDK (3 ไฟล์ vendored) + รูปทั้งหมดไปที่ repo
3. `git commit` + `push`

repo ชื่อ `MasMallow.github.io` เป็น user site — GitHub เปิด Pages ให้อัตโนมัติ ถ้าเปิดเว็บไม่ขึ้นใน 2-3 นาที เช็คที่ repo → **Settings → Pages**

## ขั้นที่ 6 — ย้ายข้อมูลจากเครื่องขึ้นคลาวด์ (ครั้งเดียว)

1. เปิดแอปในเครื่อง (`start.bat`) → กด **⬇ Export** ได้ไฟล์ `albion-comp-data.json`
2. เปิด `https://masmallow.github.io/` → กด **🔑 ผู้จัดทีม** → ล็อกอิน
3. กด **⬆ Import** → เลือกไฟล์ → ข้อมูลขึ้นคลาวด์อัตโนมัติ

เสร็จแล้ว! ส่งลิงก์ `https://masmallow.github.io/` ให้เพื่อนกิลด์ได้เลย

---

## การใช้งานประจำวัน

| งาน | ทำที่ไหน |
|---|---|
| แก้บิลด์/คอมป์ | เปิดเว็บ → ล็อกอิน → แก้ (บันทึกขึ้นคลาวด์อัตโนมัติ) |
| เพื่อนกิลด์ดูคอมป์ | เปิดลิงก์เฉยๆ (อัปเดตเรียลไทม์) |
| เพิ่มผู้จัดคนใหม่ | สร้าง user ใน Authentication → เพิ่ม UID ใน `/organizers` |
| ถอดสิทธิ์ผู้จัด | ลบ UID จาก `/organizers` |
| เพิ่มรูปไอเทมใหม่ | วาง .png ในโฟลเดอร์ที่ตรงประเภท → รัน `publish.bat` |
| แก้โค้ด/หน้าตาเว็บ | แก้ในโฟลเดอร์ `albion` → รัน `publish.bat` |

## เรื่องความปลอดภัยที่ควรรู้

- **apiKey เปิดเผยได้** — Firebase ออกแบบมาให้ key อยู่ในหน้าเว็บได้ ความปลอดภัยอยู่ที่ Security Rules ฝั่ง database (เขียนได้เฉพาะ uid ที่อยู่ใน `/organizers`)
- การสมัครบัญชีเอง (ถ้าลืมปิด sign-up) **ไม่ได้สิทธิ์เขียน** เพราะไม่อยู่ใน allowlist
- ใช้**รหัสผ่านแข็งแรง** กับบัญชีผู้จัดเสมอ — Firebase รองรับ multi-factor auth ใน Authentication → Settings ถ้าอยากเพิ่มชั้น
- ข้อมูลบิลด์/คอมป์/ชื่อผู้เล่น **อ่านได้สาธารณะ** (ใครมีลิงก์ก็ดูได้) — อย่าใส่ข้อมูลส่วนตัวจริงในโน้ต
- ไลบรารี Firebase ถูก vendor ไว้ในโปรเจกต์ (`firebase-*-compat.js` v12.14.0) ไม่โหลดจาก CDN — อัปเกรดโดยดาวน์โหลดเวอร์ชันใหม่จาก gstatic แล้ว publish

## ฟรีหรือเสียเงิน?

**ฟรี** — แอปนี้ใช้ทรัพยากรน้อยมาก (เอกสารเดียวขนาดไม่กี่ KB) ห่างไกลเพดาน free tier ของ Firebase ที่ให้ Realtime Database 1GB storage + 10GB/เดือน bandwidth
