/* Albion Comp Manager — app logic */
'use strict';

// ---------- constants ----------
const ROLES = [
  { id: 'tank', label: 'แท็งก์' },
  { id: 'healer', label: 'ฮีลเลอร์' },
  { id: 'support', label: 'ซัพพอร์ต' },
  { id: 'dps', label: 'DPS' },
  { id: 'other', label: 'อื่นๆ' },
];
const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

const GEAR_SLOTS = [
  { key: 'weapon', label: 'อาวุธ', cat: 'weapon' },
  { key: 'offhand', label: 'ออฟแฮนด์', cat: 'offhand' },
  { key: 'head', label: 'หมวก', cat: 'head' },
  { key: 'armor', label: 'เสื้อเกราะ', cat: 'armor' },
  { key: 'shoes', label: 'รองเท้า', cat: 'shoes' },
  { key: 'cape', label: 'เคป', cat: 'cape' },
];

const COMP_SIZES = [5, 10, 20];
const LS_KEY = 'albion-comp-data';

// ---------- state ----------
let ITEMS = [];
let ITEM_BY_ID = {};
let state = { rev: 0, savedAt: 0, builds: [], comps: [] };
let currentTab = 'builds';
let currentCompId = null;
let buildSearch = '';
let buildRoleFilter = '';
let serverOk = true;

// ---------- storage mode ----------
// 'firebase' = คลาวด์แชร์ทั้งกิลด์ (อ่านได้ทุกคน แก้ได้เฉพาะคนล็อกอิน + อยู่ใน allowlist)
// 'local'    = เซิร์ฟเวอร์ node ในเครื่อง (data.json)
// 'browser'  = localStorage อย่างเดียว (เปิดแบบ static ไม่มี server)
let MODE = 'browser';
let fbApp = null; // firebase app
let fbDb = null; // realtime database ref
let fbAuth = null; // auth
let canEdit = true; // false = โหมดดูอย่างเดียว (ยังไม่ล็อกอิน หรือไม่อยู่ใน allowlist)
let pendingRemote = null; // ข้อมูลใหม่จากคลาวด์ที่รอ apply (ค้างไว้ตอน modal เปิดอยู่)
let offlinePending = false; // มีงานออฟไลน์ใน localStorage ที่ยังไม่ขึ้นคลาวด์
let isOrganizer = false; // ผ่านการเช็คใน allowlist /organizers/{uid} แล้ว

const CFG = window.APP_CONFIG || {};

function firebaseConfigured() {
  return !!(CFG.firebase && CFG.firebase.apiKey && CFG.firebase.databaseURL);
}

// โหลด Firebase compat SDK เฉพาะตอนตั้งค่าไว้ — vendor ไฟล์ไว้กับโปรเจกต์เอง (12.14.0)
// ไม่พึ่ง CDN ภายนอก: ตัดปัญหา CDN ล่ม/ช้า/ถูกสับเปลี่ยนไฟล์ และกำหนดเวอร์ชันแน่นอน
function loadFirebaseLib(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (window.firebase && window.firebase.database && window.firebase.auth) return resolve(true);
    const sources = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-database-compat.js'];
    let remaining = sources.length;
    let failed = false;
    const t = setTimeout(() => {
      failed = true;
      resolve(false);
    }, timeoutMs);
    const finish = () => {
      if (failed) return;
      if (--remaining === 0) {
        clearTimeout(t);
        resolve(!!(window.firebase && window.firebase.database && window.firebase.auth));
      }
    };
    const fail = () => {
      if (failed) return;
      failed = true;
      clearTimeout(t);
      resolve(false);
    };
    // firebase-app ต้องโหลดก่อนเสมอ — chain แบบ sequential
    let i = 0;
    const next = () => {
      if (failed || i >= sources.length) return; // หยุดเชนทันทีถ้า timeout/error
      const s = document.createElement('script');
      s.src = sources[i++];
      s.onload = () => {
        finish();
        next();
      };
      s.onerror = fail;
      document.head.appendChild(s);
    };
    next();
  });
}

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function uid() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function item(id) {
  return id ? ITEM_BY_ID[id] || null : null;
}

function roleLabel(roleId) {
  return ROLE_BY_ID[roleId]?.label || 'อื่นๆ';
}

function roleClass(roleId) {
  return ROLE_BY_ID[roleId] ? 'role-' + roleId : 'role-other';
}

// ---------- persistence ----------
let saveTimer = null;
let saving = false; // มี save วิ่งอยู่บนเครือข่าย — กัน realtime ทับ state กลางคัน
let dirty = false; // มี local edit ที่ยังไม่ confirm บนคลาวด์ — กัน applyRemote ทับงาน
let authSeq = 0; // monotonic counter — กัน applySession ที่ทำงานช้ามา clobber session ใหม่

function lsWrite() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage ถูกบล็อก (เช่น private mode) — โหมดคลาวด์/เซิร์ฟเวอร์ยังบันทึกได้ปกติ */
  }
}

function setSaveStatus(text, cls) {
  const el = $('#save-status');
  el.textContent = text;
  el.className = 'save-status ' + (cls || '');
}

function scheduleSave() {
  setSaveStatus('กำลังบันทึก…', '');
  // เขียน localStorage ทันที (กันปิดแท็บก่อน debounce ครบ 500ms) — ดีเลย์เฉพาะการยิงขึ้น server
  state.savedAt = Date.now();
  dirty = true;
  lsWrite();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 500);
}

async function doSave() {
  saveTimer = null;
  if (MODE === 'browser') {
    // localStorage ถูกเขียนแล้วใน scheduleSave
    setSaveStatus('บันทึกในเบราว์เซอร์ ✓', 'ok');
    return;
  }
  saving = true;
  try {
    if (MODE === 'firebase') await doSaveFirebase();
    else await doSaveLocal();
  } finally {
    saving = false;
    maybeApplyPendingRemote(); // มีข้อมูลใหม่จากคลาวด์ค้างอยู่ระหว่าง save → apply ตอนนี้
  }
}

async function doSaveLocal() {
  try {
    const res = await fetch('api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (res.status === 409) {
      serverOk = true;
      setSaveStatus('⚠ ข้อมูลถูกแก้จากแท็บ/หน้าต่างอื่น — รีโหลดหน้านี้ก่อนแก้ต่อ', 'err');
      return;
    }
    if (!res.ok) throw new Error('save failed');
    const out = await res.json().catch(() => ({}));
    if (typeof out.rev === 'number') {
      state.rev = out.rev;
      lsWrite();
    }
    dirty = false;
    serverOk = true;
    setSaveStatus('บันทึกแล้ว ✓', 'ok');
  } catch {
    serverOk = false;
    setSaveStatus('บันทึกในเบราว์เซอร์ (เซิร์ฟเวอร์ไม่ตอบ)', 'warn');
  }
}

// ใช้ RTDB transaction — atomic check-and-set ระดับ database
// Firebase จัดการ retry + conflict ให้เอง ไม่ต้อง track rev ฝั่งเรา
async function doSaveFirebase() {
  if (!canEdit || !fbDb) {
    setSaveStatus('โหมดดูอย่างเดียว — ล็อกอินเพื่อแก้ไข', 'warn');
    return;
  }
  const mine = { builds: state.builds, comps: state.comps };
  try {
    const ref = fbDb.ref('app_data');
    const tx = await ref.transaction((current) => {
      const curRev = (current && current.rev) || 0;
      // ตอน read ครั้งแรก current=null = RTDB ยังไม่มีข้อมูล — สร้างได้
      // ตอน read แล้วได้ snapshot ที่ rev เปลี่ยน = conflict (abort = undefined)
      if (current && curRev !== state.rev) return undefined; // abort → committed=false
      return {
        rev: curRev + 1,
        savedAt: window.firebase.database.ServerValue.TIMESTAMP,
        data: mine,
      };
    });
    if (!tx.committed) {
      // ชนกับการแก้ของคนอื่น — สำรองงานเราไว้ก่อน แล้วเปิด modal ให้เลือก
      try {
        localStorage.setItem(LS_KEY + ':conflict', JSON.stringify({ savedAt: Date.now(), ...mine }));
      } catch {
        /* ignore */
      }
      const snap = tx.snapshot && tx.snapshot.val();
      if (snap) {
        if ($('#modal-root').children.length > 0) pendingRemote = snap;
        else applyRemote(snap);
      }
      setSaveStatus('⚠ มีคนแก้พร้อมกัน — แสดงเวอร์ชันล่าสุดแล้ว', 'err');
      openConflictModal(mine);
      return;
    }
    const snap = tx.snapshot.val();
    state.rev = snap.rev;
    state.savedAt = typeof snap.savedAt === 'number' ? snap.savedAt : Date.now();
    dirty = false;
    try {
      localStorage.removeItem(LS_KEY + ':pagehide');
    } catch {
      /* ignore */
    }
    lsWrite();
    setSaveStatus('บันทึกขึ้นคลาวด์ ✓', 'ok');
  } catch (e) {
    if (e && (e.code === 'PERMISSION_DENIED' || /permission/i.test(String(e.message || '')))) {
      canEdit = false;
      document.body.classList.add('viewer');
      render();
      setSaveStatus('⚠ ไม่มีสิทธิ์แก้ไข — ต้องอยู่ใน allowlist ผู้จัด', 'err');
      return;
    }
    setSaveStatus('คลาวด์ไม่ตอบ — เก็บในเบราว์เซอร์ไว้ก่อนแล้ว', 'warn');
  }
}

function maybeApplyPendingRemote() {
  if (
    pendingRemote &&
    !dirty &&
    !offlinePending &&
    !saving &&
    saveTimer === null &&
    $('#modal-root').children.length === 0
  ) {
    applyRemote(pendingRemote);
  }
}

// แจ้งว่าการบันทึกชนกับคนอื่น พร้อมทางกู้งานของเรา
function openConflictModal(mine) {
  const overlay = openModal(`
    <h2>⚠ บันทึกชนกัน</h2>
    <p style="line-height:1.8">มีคนอื่นบันทึกก่อนเรา — ตอนนี้หน้าจอแสดง<b>เวอร์ชันล่าสุดจากคลาวด์</b>แล้ว<br/>
    งานที่คุณเพิ่งแก้ (${mine.builds.length} บิลด์ / ${mine.comps.length} คอมป์) ถูกสำรองไว้ในเครื่อง</p>
    <div class="modal-actions">
      <button class="btn" data-act="dl-mine">⬇ ดาวน์โหลดงานของฉันไว้ก่อน</button>
      <button class="btn btn-gold" data-act="ok">รับทราบ</button>
    </div>
  `);
  overlay.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'ok') closeModal(overlay);
    if (act === 'dl-mine') downloadJson(mine, 'albion-conflict-backup.json');
  });
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ปิดแท็บ/รีโหลดระหว่างรอ debounce → ดันข้อมูลขึ้นปลายทางให้ทัน
// (ถ้า saving=true อยู่ ปล่อย transaction ทำต่อ ไม่ยิง REST ขนานทับ)
async function flushSave() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  // สำรอง payload ก่อนยิงเสมอ — รีโหลดครั้งหน้ากู้คืนได้ถ้า PUT หาย/โดน rules ปฏิเสธ
  try {
    localStorage.setItem(
      LS_KEY + ':pagehide',
      JSON.stringify({ savedAt: state.savedAt, rev: state.rev, builds: state.builds, comps: state.comps }),
    );
  } catch {
    /* ignore */
  }
  try {
    if (MODE === 'local') {
      navigator.sendBeacon('api/data', new Blob([JSON.stringify(state)], { type: 'application/json' }));
    } else if (MODE === 'firebase' && canEdit && fbDb && fbAuth?.currentUser && !saving) {
      // RTDB REST รองรับ keepalive — fire-and-forget โดยใช้ idToken
      try {
        const token = await fbAuth.currentUser.getIdToken();
        const body = JSON.stringify({
          rev: state.rev + 1,
          savedAt: { '.sv': 'timestamp' },
          data: { builds: state.builds, comps: state.comps },
        });
        const url = `${CFG.firebase.databaseURL}/app_data.json`;
        fetch(url, {
          method: 'PUT',
          keepalive: new Blob([body]).size <= 60 * 1024,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body,
        }).catch(() => {});
      } catch {
        /* token หมดอายุ — localStorage ถูกเขียนไว้แล้ว */
      }
    }
  } catch {
    // localStorage ถูกเขียนไว้แล้วใน scheduleSave
  }
}
window.addEventListener('pagehide', flushSave);
// กลับมาจาก bfcache — ปลายทางอาจขยับไปแล้วจากการ flush หรือจากแท็บอื่น ดึงชุดล่าสุดมาทั้งก้อน
window.addEventListener('pageshow', async (e) => {
  if (!e.persisted) return;
  try {
    if (MODE === 'local') {
      const d = await (await fetch('api/data')).json();
      if (typeof d.rev === 'number' && d.rev > state.rev) {
        state.builds = sanitizeBuilds(d.builds);
        state.comps = sanitizeComps(d.comps);
        state.savedAt = d.savedAt || 0;
        state.rev = d.rev;
        lsWrite();
        render();
      }
    } else if (MODE === 'firebase') {
      await refreshFromCloud();
    }
  } catch {
    /* ignore */
  }
});

async function loadItems() {
  // เซิร์ฟเวอร์ local ก่อน (สแกนโฟลเดอร์สดทุกครั้ง) → ไฟล์ static (GitHub Pages) → ว่าง
  try {
    const res = await fetch('api/items');
    if (res.ok) return await res.json();
  } catch {
    /* no local server */
  }
  try {
    const res = await fetch('items.json');
    if (res.ok) return await res.json();
  } catch {
    /* static file missing */
  }
  return [];
}

async function loadAll() {
  ITEMS = await loadItems();
  ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

  // โหมดคลาวด์ — ตั้งค่า firebase ไว้แล้วต้องไม่ตกไปโหมดแก้ไขอิสระ แม้โหลดไลบรารีไม่ได้
  if (firebaseConfigured()) {
    MODE = 'firebase';
    if (await loadFirebaseLib()) {
      try {
        fbApp = window.firebase.initializeApp(CFG.firebase);
        fbAuth = window.firebase.auth();
        fbDb = window.firebase.database();
      } catch {
        fbApp = null;
        fbDb = null;
        fbAuth = null;
      }
    }
    if (fbDb) {
      await loadDataFirebase();
      return;
    }
    // ไลบรารีหาย/คีย์ผิด — อ่านอย่างเดียวจากสำเนาในเครื่อง (initAuth จะล็อก UI ให้)
    let ls = null;
    try {
      ls = JSON.parse(localStorage.getItem(LS_KEY));
    } catch {
      /* ignore */
    }
    if (ls) {
      state.builds = sanitizeBuilds(ls.builds);
      state.comps = sanitizeComps(ls.comps);
      state.rev = ls.rev || 0;
      state.savedAt = ls.savedAt || 0;
    }
    setSaveStatus('เชื่อมต่อคลาวด์ไม่ได้ — แสดงข้อมูลสำรองแบบอ่านอย่างเดียว', 'warn');
    return;
  }

  // โหมด local server / browser
  let serverData = null;
  let serverFound = false;
  try {
    const res = await fetch('api/data');
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('json')) {
      serverData = await res.json();
      serverFound = true;
    } else if (res.status === 500) {
      serverFound = true; // server อยู่แต่ data.json เสียหาย
      serverOk = false;
    }
  } catch {
    /* no server */
  }
  MODE = serverFound ? 'local' : 'browser';
  if (!serverFound) serverOk = false;

  let ls = null;
  try {
    ls = JSON.parse(localStorage.getItem(LS_KEY));
  } catch {
    /* ignore */
  }
  const hasContent = (d) => d && typeof d === 'object' && (d.builds?.length || d.comps?.length);
  // เทียบ server กับ localStorage แล้วใช้ชุดที่บันทึกล่าสุด
  // (กันเคสแก้ข้อมูลตอน server ปิดอยู่ แล้วโดนสำเนาเก่าบน server ทับตอนรีโหลด)
  let chosen = serverData;
  let pushBack = false;
  if (hasContent(ls) && (!hasContent(serverData) || (ls.savedAt || 0) > (serverData?.savedAt || 0))) {
    chosen = ls;
    pushBack = true; // สำเนาในเบราว์เซอร์ใหม่กว่า — ดันกลับขึ้น server
  }
  if (chosen && typeof chosen === 'object') {
    state.builds = sanitizeBuilds(chosen.builds);
    state.comps = sanitizeComps(chosen.comps);
    state.savedAt = chosen.savedAt || 0;
  }
  // บันทึกครั้งถัดไปต้องอ้าง rev ปัจจุบันของ server เสมอ
  state.rev = (serverData && typeof serverData.rev === 'number' && serverData.rev) || 0;
  if (pushBack && serverData) scheduleSave();
}

async function loadDataFirebase() {
  let row = null;
  try {
    const snap = await fbDb.ref('app_data').get();
    row = snap.exists() ? snap.val() : null;
  } catch {
    /* คลาวด์ไม่ตอบ */
  }
  let ls = null;
  try {
    ls = JSON.parse(localStorage.getItem(LS_KEY));
  } catch {
    /* ignore */
  }
  // pagehide flush ที่อาจหายไป (โดน rules ปฏิเสธ/หลุดกลางคัน) — ใช้ของนี้ถ้าใหม่กว่า ls
  try {
    const pageh = JSON.parse(localStorage.getItem(LS_KEY + ':pagehide'));
    if (pageh && (!ls || (pageh.savedAt || 0) > (ls.savedAt || 0))) {
      ls = { rev: pageh.rev, savedAt: pageh.savedAt, builds: pageh.builds, comps: pageh.comps };
    }
  } catch {
    /* ignore */
  }
  const cloudSavedAt = row && typeof row.savedAt === 'number' ? row.savedAt : 0;
  if (ls && (ls.savedAt || 0) > cloudSavedAt && (ls.builds?.length || ls.comps?.length)) {
    // มีงานออฟไลน์ค้างในเครื่องที่ใหม่กว่าคลาวด์ — ใช้ชุดนี้ก่อน แล้วดันขึ้นคลาวด์เมื่อล็อกอิน
    state.builds = sanitizeBuilds(ls.builds);
    state.comps = sanitizeComps(ls.comps);
    state.savedAt = ls.savedAt || 0;
    state.rev = ls.rev || 0;
    offlinePending = true;
    if (row && (row.rev || 0) !== (ls.rev || 0)) {
      pendingRemote = row;
      setSaveStatus('⚠ ทั้งเครื่องนี้และคลาวด์มีการแก้ — ล็อกอินเพื่อเลือกชุดที่จะใช้', 'warn');
    } else {
      setSaveStatus('มีงานในเครื่องที่ยังไม่ขึ้นคลาวด์ — ล็อกอินเพื่อบันทึก', 'warn');
    }
    return;
  }
  if (row) {
    state.builds = sanitizeBuilds(row.data?.builds);
    state.comps = sanitizeComps(row.data?.comps);
    state.rev = row.rev || 0;
    state.savedAt = cloudSavedAt;
    lsWrite();
  } else if (ls) {
    state.builds = sanitizeBuilds(ls.builds);
    state.comps = sanitizeComps(ls.comps);
    state.rev = ls.rev || 0;
    setSaveStatus('คลาวด์ไม่ตอบ — แสดงข้อมูลสำรองในเครื่อง', 'warn');
  }
}

// ---------- cloud sync (firebase RTDB) ----------
// RTDB onValue ทำงาน realtime + ออฟไลน์ cache ในตัว — เรียบง่ายกว่า Supabase channel มาก
// หมายเหตุ: network drop = Firebase auto-reconnect, แต่ PERMISSION_DENIED = listener หลุดถาวร ต้อง re-attach เอง
let rtRetryQueued = false;
function startRealtime() {
  if (MODE !== 'firebase' || !fbDb) return;
  const attach = () => {
    try {
      fbDb.ref('app_data').on(
        'value',
        (snap) => {
          if (snap.exists()) receiveRemote(snap.val());
        },
        () => {
          setSaveStatus('การเชื่อมต่อคลาวด์ขาด — จะลองใหม่อัตโนมัติ', 'err');
          if (rtRetryQueued) return;
          rtRetryQueued = true;
          const retry = () => {
            rtRetryQueued = false;
            attach();
            refreshFromCloud();
          };
          window.addEventListener('online', retry, { once: true });
          document.addEventListener('visibilitychange', function onVis() {
            if (document.visibilityState === 'visible') {
              document.removeEventListener('visibilitychange', onVis);
              if (rtRetryQueued) retry();
            }
          });
        },
      );
    } catch {
      /* ignore */
    }
  };
  attach();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromCloud();
  });
}

async function refreshFromCloud() {
  if (MODE !== 'firebase' || !fbDb) return;
  try {
    const snap = await fbDb.ref('app_data').get();
    if (snap.exists()) receiveRemote(snap.val());
  } catch {
    /* ignore */
  }
}

function receiveRemote(row) {
  if (!row || typeof row.rev !== 'number' || row.rev <= state.rev) return;
  // realtime payload มีเพดานขนาด — ถ้า data มาไม่ครบ อย่า apply ของว่างทับ ให้ดึงสดจาก REST แทน
  if (!row.data || !Array.isArray(row.data.builds) || !Array.isArray(row.data.comps)) {
    refreshFromCloud();
    return;
  }
  // กำลังแก้อยู่ / มี save วิ่งอยู่ / มีงานออฟไลน์รอผู้ใช้ตัดสินใจ / มี dirty edit ที่ยังไม่ขึ้นคลาวด์ — อย่าทับ เก็บไว้ก่อน
  if (dirty || offlinePending || saving || saveTimer !== null || $('#modal-root').children.length > 0) {
    pendingRemote = row;
    setSaveStatus(
      offlinePending
        ? '⚠ ทั้งเครื่องนี้และคลาวด์มีการแก้ — ล็อกอินเพื่อเลือกชุดที่จะใช้'
        : dirty
          ? '⚠ มีงานที่ยังไม่บันทึก และคลาวด์มีการแก้ใหม่ — จะให้เลือกเมื่อบันทึกเสร็จ'
          : '🔄 มีข้อมูลใหม่จากคลาวด์ — จะอัปเดตเมื่อเสร็จงานตรงหน้า',
      'warn',
    );
    return;
  }
  applyRemote(row);
}

function applyRemote(row) {
  pendingRemote = null;
  state.builds = sanitizeBuilds(row.data?.builds);
  state.comps = sanitizeComps(row.data?.comps);
  state.rev = row.rev || 0;
  state.savedAt = typeof row.savedAt === 'number' ? row.savedAt : 0;
  lsWrite();
  render();
  setSaveStatus('อัปเดตจากคลาวด์ ✓', 'ok');
}

// ---------- auth (firebase) ----------
async function initAuth() {
  // โหมดคลาวด์แต่ SDK โหลดไม่ผ่าน → ห้ามให้แก้ไข (ตามคำสัญญาใน loadAll)
  if (MODE === 'firebase' && !fbAuth) {
    canEdit = false;
    isOrganizer = false;
    document.body.classList.add('viewer');
    renderAuthArea('');
    return;
  }
  if (MODE !== 'firebase') {
    canEdit = true;
    renderAuthArea('');
    return;
  }
  canEdit = false;
  isOrganizer = false;
  // ถ้ามี session ที่แคชไว้ (compat SDK กู้คืน sync จาก localStorage) ไม่ต้องโชว์ viewer mode ก่อน
  // — กัน flash ของ UI โหมดดูระหว่างที่ allowlist check ยังไม่เสร็จ
  if (!fbAuth.currentUser) document.body.classList.add('viewer');
  // รอ applySession รอบแรกให้เสร็จก่อน init() จะเรียก render() (จะได้ไม่ flash)
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const safety = setTimeout(finish, 3000);
    try {
      fbAuth.onAuthStateChanged(
        async (user) => {
          try {
            await applySession(user);
          } finally {
            clearTimeout(safety);
            finish();
          }
        },
        () => {
          clearTimeout(safety);
          finish();
        },
      );
    } catch {
      clearTimeout(safety);
      finish();
    }
  });
}

async function applySession(user) {
  const mySeq = ++authSeq;
  const was = canEdit;
  // ล็อกอินอย่างเดียวยังแก้ไม่ได้ — ต้องอยู่ใน allowlist /organizers/{uid} ด้วย
  let nextIsOrganizer = false;
  if (user && fbDb) {
    try {
      const snap = await fbDb.ref(`organizers/${user.uid}`).get();
      nextIsOrganizer = snap.exists() && snap.val() === true;
    } catch {
      nextIsOrganizer = false;
    }
  }
  if (mySeq !== authSeq) return; // มีเหตุการณ์ auth ใหม่แล้ว — ผลลัพธ์เก่าทิ้งไป
  isOrganizer = nextIsOrganizer;
  canEdit = !!user && isOrganizer;
  document.body.classList.toggle('viewer', !canEdit);
  renderAuthArea(user?.email || '', !!user);
  if (canEdit && offlinePending) {
    offlinePending = false;
    if (pendingRemote) {
      // ทั้งสองฝั่งแก้คนละทาง — ให้ผู้ใช้เลือกเองว่าจะใช้ชุดไหน
      openSyncChoiceModal(pendingRemote);
    } else {
      scheduleSave(); // คลาวด์ไม่ขยับระหว่างเราออฟไลน์ — ดันขึ้นได้เลย
    }
  } else if (user && !isOrganizer) {
    // ล็อกอินแล้วแต่ไม่อยู่ใน allowlist — แสดงข้อมูลคลาวด์ล่าสุดได้ตามปกติ
    // อย่าให้ offlinePending ค้างถาวรจนกัน realtime ไม่ให้ apply
    if (offlinePending) {
      offlinePending = false;
      if (pendingRemote) {
        const row = pendingRemote;
        pendingRemote = null;
        applyRemote(row);
      } else {
        refreshFromCloud();
      }
    }
    setSaveStatus('⚠ บัญชีนี้ไม่อยู่ใน allowlist ผู้จัด — ดูได้แต่แก้ไม่ได้', 'warn');
  }
  if (was !== canEdit) render();
}

// งานออฟไลน์ในเครื่อง vs เวอร์ชันใหม่บนคลาวด์ — ให้ผู้ใช้ตัดสิน
function openSyncChoiceModal(row) {
  const cloud = row.data || { builds: [], comps: [] };
  const fmt = (t) => (t ? new Date(t).toLocaleString('th-TH') : '-');
  const overlay = openModal(`
    <h2>⚠ ข้อมูลสองชุดไม่ตรงกัน</h2>
    <p style="line-height:1.9">มีการแก้ไขทั้งสองที่ระหว่างที่เครื่องนี้ออฟไลน์:</p>
    <ul style="line-height:2;color:var(--text-dim)">
      <li><b style="color:var(--text)">ในเครื่องนี้:</b> ${state.builds.length} บิลด์ / ${state.comps.length} คอมป์ — แก้ล่าสุด ${fmt(state.savedAt)}</li>
      <li><b style="color:var(--text)">บนคลาวด์:</b> ${(cloud.builds || []).length} บิลด์ / ${(cloud.comps || []).length} คอมป์ — แก้ล่าสุด ${fmt(typeof row.savedAt === 'number' ? row.savedAt : 0)}</li>
    </ul>
    <div class="modal-actions" style="flex-wrap:wrap">
      <button class="btn" data-act="dl-local">⬇ ดาวน์โหลดชุดในเครื่องเก็บไว้</button>
      <button class="btn" data-act="use-cloud">ใช้ชุดคลาวด์ (ทิ้งของเครื่องนี้)</button>
      <button class="btn btn-gold" data-act="use-local">ใช้ชุดในเครื่อง (ทับคลาวด์)</button>
    </div>
  `);
  overlay.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'dl-local') downloadJson({ builds: state.builds, comps: state.comps }, 'albion-local-backup.json');
    if (act === 'use-cloud') {
      closeModal(overlay);
      applyRemote(row);
    }
    if (act === 'use-local') {
      pendingRemote = null;
      state.rev = row.rev || 0; // บันทึกทับต่อจาก rev ปัจจุบันของคลาวด์
      closeModal(overlay);
      scheduleSave();
    }
  });
}

function renderAuthArea(email, signedIn) {
  const el = $('#auth-area');
  if (!el) return;
  if (MODE !== 'firebase') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (signedIn) {
    el.innerHTML = `<span class="auth-email" title="${esc(email)}">👤 ${esc((email || '').split('@')[0])}${
      isOrganizer ? '' : ' <span style="color:var(--danger);font-size:11px">(ดูอย่างเดียว)</span>'
    }</span><button class="btn btn-ghost" id="btn-logout">ออกจากระบบ</button>`;
  } else {
    el.innerHTML = `<button class="btn btn-gold" id="btn-login">🔑 ผู้จัดทีม</button>`;
  }
  $('#btn-logout')?.addEventListener('click', () => {
    // มีงานค้างยังไม่ขึ้นคลาวด์ — เตือนก่อน
    if (dirty || saveTimer !== null || saving) {
      if (!confirm('ยังมีงานยังไม่ได้บันทึกขึ้นคลาวด์ — ออกจากระบบเลยใช่ไหม? (งานจะค้างในเครื่องนี้)')) return;
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    pendingRemote = null;
    // เก็บ dirty + offlinePending ไว้ เพื่อให้ login ครั้งหน้ารับช่วงต่อ
    fbAuth.signOut();
  });
  $('#btn-login')?.addEventListener('click', openLoginModal);
}

function openLoginModal() {
  const overlay = openModal(`
    <h2>เข้าสู่ระบบผู้จัดทีม</h2>
    <p style="color:var(--text-dim);font-size:13px;margin:0 0 14px;">เฉพาะคนจัดคอมป์ — สมาชิกกิลด์เปิดดูได้เลยไม่ต้องล็อกอิน</p>
    <div class="form-row">
      <label>อีเมล <input type="email" id="li-email" autocomplete="username" style="min-width:260px" /></label>
    </div>
    <div class="form-row">
      <label>รหัสผ่าน <input type="password" id="li-pass" autocomplete="current-password" style="min-width:260px" /></label>
    </div>
    <p id="li-err" style="color:var(--danger);font-size:13px;min-height:18px;margin:4px 0 0;"></p>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">ยกเลิก</button>
      <button class="btn btn-gold" data-act="login">เข้าสู่ระบบ</button>
    </div>
  `);
  setTimeout(() => $('#li-email', overlay)?.focus(), 50);
  let inFlight = false; // กัน Enter รัวๆ ยิง signInWithEmailAndPassword หลายครั้งซ้อน
  const doLogin = async () => {
    if (inFlight) return;
    const btn = $('[data-act="login"]', overlay);
    if (!fbAuth) {
      $('#li-err', overlay).textContent = 'เชื่อมต่อคลาวด์ไม่ได้ — รีโหลดหน้าแล้วลองใหม่';
      return;
    }
    inFlight = true;
    btn.disabled = true;
    $('#li-err', overlay).textContent = '';
    try {
      await fbAuth.signInWithEmailAndPassword($('#li-email', overlay).value.trim(), $('#li-pass', overlay).value);
      closeModal(overlay);
      refreshFromCloud();
    } catch {
      $('#li-err', overlay).textContent = 'เข้าสู่ระบบไม่สำเร็จ — ตรวจอีเมล/รหัสผ่านอีกครั้ง';
      btn.disabled = false;
    } finally {
      inFlight = false;
    }
  };
  overlay.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cancel') closeModal(overlay);
    if (act === 'login') doLogin();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'li-email' || e.target.id === 'li-pass')) doLogin();
  });
}

// ---------- sanitize (กันข้อมูล import/แก้มือที่รูปร่างเพี้ยนทำแอปพังถาวร) ----------
function sanitizeBuilds(arr) {
  if (!Array.isArray(arr)) return [];
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  const idOrNull = (v) => (typeof v === 'string' && v ? v : null);
  return arr
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      id: str(b.id) || uid(),
      name: str(b.name) || 'บิลด์ไม่มีชื่อ',
      role: ROLE_BY_ID[b.role] ? b.role : 'other',
      weapon: idOrNull(b.weapon),
      offhand: idOrNull(b.offhand),
      head: idOrNull(b.head),
      armor: idOrNull(b.armor),
      shoes: idOrNull(b.shoes),
      // เก็บ cape เป็น item ID เท่านั้น (รุ่นเก่าเคยเก็บเป็น free text — ตัดทิ้งถ้าไม่ใช่ ID ที่รู้จัก)
      cape: typeof b.cape === 'string' && /^T\d+_CAPEITEM/.test(b.cape) ? b.cape : null,
      food: str(b.food),
      potion: str(b.potion),
      note: str(b.note),
    }));
}

function sanitizeComps(arr) {
  if (!Array.isArray(arr)) return [];
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  return arr
    .filter((c) => c && typeof c === 'object')
    .map((c) => {
      const slots = (Array.isArray(c.slots) ? c.slots : [])
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          build: typeof s.build === 'string' && s.build ? s.build : null,
          player: str(s.player),
          note: str(s.note),
        }));
      while (slots.length < 1) slots.push({ build: null, player: '', note: '' });
      return { id: str(c.id) || uid(), name: str(c.name) || 'คอมป์', size: slots.length, slots };
    });
}

// ---------- modal helpers ----------
function openModal(html, extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${extraClass}">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
  $('#modal-root').appendChild(overlay);
  const onKey = (e) => {
    // close only the top-most modal
    if (e.key === 'Escape' && overlay === $('#modal-root').lastElementChild) closeModal(overlay);
  };
  overlay._onKey = onKey;
  document.addEventListener('keydown', onKey);
  return overlay;
}

function closeModal(overlay) {
  document.removeEventListener('keydown', overlay._onKey);
  overlay.remove();
  if (overlay._onClose) overlay._onClose();
  // มีข้อมูลใหม่จากคลาวด์รออยู่ และไม่มีงานค้างแล้ว → apply ได้
  maybeApplyPendingRemote();
}

// ---------- item picker ----------
function pickItem(cat, currentId) {
  return new Promise((resolve) => {
    const slotLabel = GEAR_SLOTS.find((g) => g.cat === cat)?.label || cat;
    let search = '';
    let sub = '';

    const isArmorCat = cat === 'armor' || cat === 'head' || cat === 'shoes';
    const chips = isArmorCat
      ? [
          { id: '', label: 'ทั้งหมด' },
          { id: 'cloth', label: 'ผ้า' },
          { id: 'leather', label: 'หนัง' },
          { id: 'plate', label: 'เพลท' },
        ]
      : cat === 'weapon'
        ? [
            { id: '', label: 'ทั้งหมด' },
            { id: '1h', label: 'มือเดียว' },
            { id: '2h', label: 'สองมือ' },
          ]
        : [];

    const overlay = openModal(
      `
      <h2>เลือก${esc(slotLabel)}</h2>
      <div class="picker-filters">
        ${chips.map((c) => `<button class="chip ${c.id === sub ? 'active' : ''}" data-sub="${c.id}">${esc(c.label)}</button>`).join('')}
        <input type="search" class="picker-search" placeholder="ค้นหาชื่อไอเทม… (เช่น hammer, holy)" autofocus />
      </div>
      <div class="item-grid"></div>
      <div class="modal-actions">
        ${currentId ? '<button class="btn btn-danger" data-act="clear">ล้างช่องนี้</button>' : ''}
        <button class="btn" data-act="cancel">ยกเลิก</button>
      </div>
    `,
      'picker-modal',
    );

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      closeModal(overlay);
      resolve(val);
    };
    overlay._onClose = () => {
      if (!done) {
        done = true;
        resolve(undefined); // cancelled
      }
    };

    const grid = $('.item-grid', overlay);

    function renderGrid() {
      const q = search.trim().toLowerCase();
      const list = ITEMS.filter((it) => {
        if (it.cat !== cat) return false;
        if (sub) {
          if (sub === '1h' && it.twoHanded) return false;
          if (sub === '2h' && !it.twoHanded) return false;
          if (['cloth', 'leather', 'plate'].includes(sub) && it.material !== sub) return false;
        }
        if (q && !(it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q))) return false;
        return true;
      });
      grid.innerHTML = list.length
        ? list
            .map(
              (it) => `
        <div class="item-tile ${it.id === currentId ? 'selected' : ''}" data-id="${esc(it.id)}" title="${esc(it.id)}">
          <img src="${esc(it.img)}" alt="" loading="lazy" />
          <span class="item-name">${esc(it.name)}</span>
        </div>`,
            )
            .join('')
        : '<p style="color:var(--text-dim);grid-column:1/-1;text-align:center;padding:30px 0;">ไม่พบไอเทม</p>';
    }
    renderGrid();

    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.item-tile');
      if (tile) finish(tile.dataset.id);
    });
    $('.picker-search', overlay).addEventListener('input', (e) => {
      search = e.target.value;
      renderGrid();
    });
    $$('.chip', overlay).forEach((ch) =>
      ch.addEventListener('click', () => {
        sub = ch.dataset.sub;
        $$('.chip', overlay).forEach((c) => c.classList.toggle('active', c === ch));
        renderGrid();
      }),
    );
    overlay.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'cancel') finish(undefined);
      if (act === 'clear') finish(null); // null = clear slot
    });
    setTimeout(() => $('.picker-search', overlay)?.focus(), 50);
  });
}

// ---------- build editor ----------
function openBuildEditor(buildId) {
  if (!canEdit) return;
  const existing = state.builds.find((b) => b.id === buildId);
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { id: uid(), name: '', role: 'dps', weapon: null, offhand: null, head: null, armor: null, shoes: null, cape: null, food: '', potion: '', note: '' };

  const overlay = openModal(`
    <h2>${existing ? 'แก้ไขบิลด์' : 'สร้างบิลด์ใหม่'}</h2>
    <div class="form-row">
      <label>ชื่อบิลด์
        <input type="text" id="be-name" placeholder="เช่น แท็งก์เปิด, ฮีลหลัก" value="${esc(draft.name)}" style="min-width:260px" />
      </label>
      <label>บทบาท (Role)
        <select id="be-role">
          ${ROLES.map((r) => `<option value="${r.id}" ${r.id === draft.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="gear-pick-row" id="be-gear"></div>
    <div class="form-row">
      <label>อาหาร <input type="text" id="be-food" placeholder="เช่น Beef Stew" value="${esc(draft.food)}" /></label>
      <label>ยา <input type="text" id="be-potion" placeholder="เช่น Resistance Potion" value="${esc(draft.potion)}" /></label>
    </div>
    <label style="display:block;font-size:13px;color:var(--text-dim);margin-bottom:4px;">หมายเหตุ</label>
    <textarea id="be-note" placeholder="สเปลที่ใช้ / IP ขั้นต่ำ / เงื่อนไขอื่นๆ">${esc(draft.note)}</textarea>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">ยกเลิก</button>
      <button class="btn btn-gold" data-act="save">💾 บันทึกบิลด์</button>
    </div>
  `);

  let stashedOffhand = null; // จำออฟแฮนด์ไว้ตอนสลับไปอาวุธสองมือ — สลับกลับ 1 มือแล้วคืนให้
  function renderGear() {
    const wp = item(draft.weapon);
    const offhandBlocked = !!wp?.twoHanded;
    if (offhandBlocked) {
      if (draft.offhand) {
        stashedOffhand = draft.offhand;
        draft.offhand = null;
      }
    } else if (!draft.offhand && stashedOffhand) {
      draft.offhand = stashedOffhand;
      stashedOffhand = null;
    }
    $('#be-gear', overlay).innerHTML = GEAR_SLOTS.map((g) => {
      const it = item(draft[g.key]);
      const disabled = g.key === 'offhand' && offhandBlocked;
      return `
        <div class="gear-pick">
          <span class="pick-label">${esc(g.label)}</span>
          <button class="pick-btn" data-slot="${g.key}" ${disabled ? 'disabled title="อาวุธสองมือใช้ออฟแฮนด์ไม่ได้"' : ''}>
            ${it ? `<img src="${esc(it.img)}" alt="" />` : '<span class="plus">+</span>'}
          </button>
          <span class="pick-name">${disabled ? '<i>– สองมือ –</i>' : it ? esc(it.name) : '<span style="color:#5d636d">ยังไม่เลือก</span>'}</span>
          ${it && !disabled ? `<button class="clear-link" data-clear="${g.key}">ล้าง</button>` : ''}
        </div>`;
    }).join('');
  }
  renderGear();

  let pickerBusy = false; // กันดับเบิลคลิกเปิด picker ซ้อนกันสองอัน
  $('#be-gear', overlay).addEventListener('click', async (e) => {
    const clearKey = e.target.dataset?.clear;
    if (clearKey) {
      draft[clearKey] = null;
      renderGear();
      return;
    }
    const btn = e.target.closest('.pick-btn');
    if (!btn || btn.disabled || pickerBusy) return;
    const slot = btn.dataset.slot;
    const cat = GEAR_SLOTS.find((g) => g.key === slot).cat;
    pickerBusy = true;
    const picked = await pickItem(cat, draft[slot]);
    pickerBusy = false;
    if (picked === undefined) return; // cancelled
    draft[slot] = picked; // item id or null (cleared)
    renderGear();
  });

  overlay.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cancel') closeModal(overlay);
    if (act === 'save') {
      draft.name = $('#be-name', overlay).value.trim() || 'บิลด์ไม่มีชื่อ';
      draft.role = $('#be-role', overlay).value;
      // cape ตอนนี้เป็น item ID (เลือกจากรูป) — อ่านค่าจาก draft โดยตรง ไม่ต้องอ่าน input
      draft.food = $('#be-food', overlay).value.trim();
      draft.potion = $('#be-potion', overlay).value.trim();
      draft.note = $('#be-note', overlay).value.trim();
      const idx = state.builds.findIndex((b) => b.id === draft.id);
      if (idx >= 0) state.builds[idx] = draft;
      else state.builds.push(draft);
      scheduleSave();
      closeModal(overlay);
      render();
    }
  });
}

// ---------- builds view ----------
function buildUsageCount(buildId) {
  let n = 0;
  for (const c of state.comps) for (const s of c.slots) if (s.build === buildId) n++;
  return n;
}

function renderBuilds(root) {
  const filtered = state.builds.filter((b) => {
    if (buildRoleFilter && b.role !== buildRoleFilter) return false;
    const q = buildSearch.trim().toLowerCase();
    if (q && !b.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const order = Object.fromEntries(ROLES.map((r, i) => [r.id, i]));
  filtered.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name, 'th'));

  root.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-gold" data-act="new-build">+ สร้างบิลด์ใหม่</button>
      <select id="bf-role">
        <option value="">ทุกบทบาท</option>
        ${ROLES.map((r) => `<option value="${r.id}" ${r.id === buildRoleFilter ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
      </select>
      <input type="search" id="bf-search" placeholder="ค้นหาชื่อบิลด์…" value="${esc(buildSearch)}" />
      <div class="spacer"></div>
      <span style="color:var(--text-dim);font-size:13px;">${state.builds.length} บิลด์</span>
    </div>
    ${
      state.builds.length === 0
        ? `<div class="empty-hint">ยังไม่มีบิลด์<br/>กด <b>"+ สร้างบิลด์ใหม่"</b> เพื่อจัดเซ็ตแรกของกิลด์ — เลือกอาวุธ หมวก เสื้อ รองเท้า จากรูปไอเทมได้เลย</div>`
        : filtered.length === 0
          ? `<div class="empty-hint">ไม่พบบิลด์ที่ตรงกับตัวกรอง</div>`
          : `<div class="build-grid">${filtered.map(buildCardHtml).join('')}</div>`
    }
  `;

  $('#bf-role', root).addEventListener('change', (e) => {
    buildRoleFilter = e.target.value;
    render();
  });
  $('#bf-search', root).addEventListener('input', (e) => {
    buildSearch = e.target.value;
    const caret = e.target.selectionStart;
    render(true);
    const s = $('#bf-search');
    if (s) s.setSelectionRange(caret, caret); // คงตำแหน่งเคอร์เซอร์เดิม ไม่กระโดดไปท้าย
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (act === 'new-build') openBuildEditor(null);
    if (act === 'edit-build') openBuildEditor(id);
    if (act === 'copy-build') {
      const src = state.builds.find((b) => b.id === id);
      if (!src) return;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = uid();
      copy.name = src.name + ' (สำเนา)';
      state.builds.push(copy);
      scheduleSave();
      render();
    }
    if (act === 'del-build') {
      const used = buildUsageCount(id);
      const b = state.builds.find((x) => x.id === id);
      const msg = used > 0 ? `ลบบิลด์ "${b?.name}" ?\n\nบิลด์นี้ถูกใช้อยู่ใน ${used} ช่องของคอมป์ — ช่องเหล่านั้นจะกลายเป็นว่าง` : `ลบบิลด์ "${b?.name}" ?`;
      if (!confirm(msg)) return;
      state.builds = state.builds.filter((x) => x.id !== id);
      for (const c of state.comps) for (const s of c.slots) if (s.build === id) s.build = null;
      scheduleSave();
      render();
    }
  });
}

function buildCardHtml(b) {
  const extras = [b.food && `อาหาร: ${esc(b.food)}`, b.potion && `ยา: ${esc(b.potion)}`].filter(Boolean);
  return `
    <div class="build-card">
      <div class="build-card-head">
        <span class="role-badge ${roleClass(b.role)}">${esc(roleLabel(b.role))}</span>
        <h3>${esc(b.name)}</h3>
      </div>
      <div class="gear-row">
        ${GEAR_SLOTS.map((g) => {
          const it = item(b[g.key]);
          return it
            ? `<div class="gear-cell" title="${esc(it.name)}"><img src="${esc(it.img)}" alt="" /><span class="slot-tag">${esc(g.label)}</span></div>`
            : `<div class="gear-cell empty" title="ไม่ได้เลือก${esc(g.label)}"><span class="slot-tag">${esc(g.label)}</span></div>`;
        }).join('')}
      </div>
      ${extras.length ? `<div class="build-extras">${extras.join(' · ')}</div>` : ''}
      ${b.note ? `<div class="build-note">${esc(b.note)}</div>` : ''}
      <div class="card-actions">
        <button class="btn btn-sm" data-act="edit-build" data-id="${b.id}">✏️ แก้ไข</button>
        <button class="btn btn-sm" data-act="copy-build" data-id="${b.id}">⧉ คัดลอก</button>
        <span style="flex:1"></span>
        <button class="btn btn-sm btn-danger" data-act="del-build" data-id="${b.id}">🗑 ลบ</button>
      </div>
    </div>`;
}

// ---------- comps view ----------
function newComp(name, size) {
  return {
    id: uid(),
    name: name || 'คอมป์ใหม่',
    size,
    slots: Array.from({ length: size }, () => ({ build: null, player: '', note: '' })),
  };
}

function compRoleSummary(c) {
  const counts = {};
  let empty = 0;
  for (const s of c.slots) {
    const b = state.builds.find((x) => x.id === s.build);
    if (b) counts[b.role] = (counts[b.role] || 0) + 1;
    else empty++;
  }
  return { counts, empty };
}

function openNewCompModal() {
  if (!canEdit) return;
  const overlay = openModal(`
    <h2>สร้างคอมป์ใหม่</h2>
    <div class="form-row">
      <label>ชื่อคอมป์
        <input type="text" id="nc-name" placeholder="เช่น ZvZ จันทร์, Crystal 5v5" style="min-width:260px" />
      </label>
      <label>ขนาดทีม
        <select id="nc-size">
          ${COMP_SIZES.map((s) => `<option value="${s}">${s} คน</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">ยกเลิก</button>
      <button class="btn btn-gold" data-act="create">สร้างคอมป์</button>
    </div>
  `);
  setTimeout(() => $('#nc-name', overlay)?.focus(), 50);
  overlay.addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cancel') closeModal(overlay);
    if (act === 'create') {
      const name = $('#nc-name', overlay).value.trim() || 'คอมป์ใหม่';
      const size = parseInt($('#nc-size', overlay).value, 10);
      const c = newComp(name, size);
      state.comps.push(c);
      currentCompId = c.id;
      scheduleSave();
      closeModal(overlay);
      render();
    }
  });
  $('#nc-name', overlay).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('[data-act="create"]', overlay).click();
  });
}

function renderCompList(root) {
  root.innerHTML = `
    <div class="toolbar">
      <button class="btn btn-gold" data-act="new-comp">+ สร้างคอมป์</button>
      <div class="spacer"></div>
      <span style="color:var(--text-dim);font-size:13px;">${state.comps.length} คอมป์</span>
    </div>
    ${
      state.comps.length === 0
        ? `<div class="empty-hint">ยังไม่มีคอมป์<br/>กด <b>"+ สร้างคอมป์"</b> แล้วเลือกขนาดทีม 5 / 10 / 20 คน จากนั้นใส่บิลด์และชื่อผู้เล่นในแต่ละช่อง</div>`
        : `<div class="comp-grid">${state.comps.map(compCardHtml).join('')}</div>`
    }
  `;
  root.addEventListener('click', (e) => {
    const newBtn = e.target.closest('[data-act="new-comp"]');
    if (newBtn) return openNewCompModal();
    const card = e.target.closest('.comp-card');
    if (card) {
      currentCompId = card.dataset.id;
      render();
    }
  });
}

function compCardHtml(c) {
  const { counts, empty } = compRoleSummary(c);
  const filled = c.slots.length - empty;
  return `
    <div class="comp-card" data-id="${c.id}">
      <h3>${esc(c.name)}</h3>
      <div><span class="size-pill">${c.slots.length} คน</span>
        <span class="comp-meta"> จัดแล้ว ${filled}/${c.slots.length}</span></div>
      <div class="role-chips">
        ${ROLES.filter((r) => counts[r.id]).map((r) => `<span class="role-chip"><b>${counts[r.id]}</b> ${esc(r.label)}</span>`).join('')}
        ${empty ? `<span class="role-chip">ว่าง <b>${empty}</b></span>` : ''}
      </div>
    </div>`;
}

function buildOptionsHtml(selectedId) {
  const order = Object.fromEntries(ROLES.map((r, i) => [r.id, i]));
  const sorted = [...state.builds].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name, 'th'));
  return (
    `<option value="">— ว่าง —</option>` +
    sorted.map((b) => `<option value="${b.id}" ${b.id === selectedId ? 'selected' : ''}>[${esc(roleLabel(b.role))}] ${esc(b.name)}</option>`).join('')
  );
}

function renderCompDetail(root, comp) {
  const dis = canEdit ? '' : 'disabled';
  const { counts, empty } = compRoleSummary(comp);
  const partySize = 5;
  const parties = [];
  for (let i = 0; i < comp.slots.length; i += partySize) {
    parties.push(comp.slots.slice(i, i + partySize).map((s, j) => ({ slot: s, idx: i + j })));
  }

  root.innerHTML = `
    <div class="comp-head">
      <button class="btn" data-act="back">← กลับ</button>
      <input type="text" class="comp-name" id="cd-name" value="${esc(comp.name)}" title="ชื่อคอมป์ (แก้ได้)" ${dis} />
      <select id="cd-size" title="ขนาดทีม" ${dis}>
        ${COMP_SIZES.map((s) => `<option value="${s}" ${s === comp.slots.length ? 'selected' : ''}>${s} คน</option>`).join('')}
        ${!COMP_SIZES.includes(comp.slots.length) ? `<option value="${comp.slots.length}" selected>${comp.slots.length} คน</option>` : ''}
      </select>
      <div class="spacer" style="flex:1"></div>
      <button class="btn" data-act="copy-text">📋 คัดลอกเป็นข้อความ</button>
      <button class="btn" data-act="dup-comp">⧉ ทำสำเนา</button>
      <button class="btn btn-danger" data-act="del-comp">🗑 ลบคอมป์</button>
    </div>

    <div class="summary-bar">
      <span class="label">สรุป:</span>
      ${ROLES.filter((r) => counts[r.id]).map((r) => `<span class="role-chip"><b>${counts[r.id]}</b> ${esc(r.label)}</span>`).join('')}
      <span class="role-chip">ว่าง <b>${empty}</b></span>
      ${state.builds.length === 0 ? `<span style="color:var(--support);font-size:13px;">⚠ ยังไม่มีบิลด์ — ไปที่แท็บ "บิลด์ / เซ็ต" เพื่อสร้างก่อน</span>` : ''}
    </div>

    ${parties
      .map(
        (party, pi) => `
      <div class="party-block">
        ${comp.slots.length > partySize ? `<div class="party-title">ปาร์ตี้ ${pi + 1}</div>` : ''}
        <table class="slot-table">
          ${party
            .map(({ slot, idx }) => {
              const b = state.builds.find((x) => x.id === slot.build);
              const wp = b ? item(b.weapon) : null;
              return `
            <tr data-idx="${idx}">
              <td class="slot-num">${idx + 1}.</td>
              <td class="slot-weap">${wp ? `<img src="${esc(wp.img)}" title="${esc(wp.name)}" alt=""/>` : '<div class="no-weap"></div>'}</td>
              <td class="slot-build"><select data-field="build" ${dis}>${buildOptionsHtml(slot.build)}</select></td>
              <td class="slot-role">${b ? `<span class="role-badge ${roleClass(b.role)}">${esc(roleLabel(b.role))}</span>` : ''}</td>
              <td class="slot-player"><input type="text" data-field="player" placeholder="ชื่อผู้เล่น" value="${esc(slot.player)}" ${dis} /></td>
              <td class="slot-note"><input type="text" data-field="note" placeholder="โน้ต เช่น ตัวสำรอง, เรียก engage" value="${esc(slot.note)}" ${dis} /></td>
              <td class="slot-actions">
                <button class="btn" data-move="-1" title="เลื่อนขึ้น">↑</button>
                <button class="btn" data-move="1" title="เลื่อนลง">↓</button>
                <button class="btn btn-danger" data-act="clear-slot" title="ล้างช่องนี้">✕</button>
              </td>
            </tr>`;
            })
            .join('')}
        </table>
      </div>`,
      )
      .join('')}
  `;

  // header actions
  $('#cd-name', root).addEventListener('change', (e) => {
    comp.name = e.target.value.trim() || 'คอมป์';
    scheduleSave();
  });
  $('#cd-size', root).addEventListener('change', (e) => {
    const newSize = parseInt(e.target.value, 10);
    if (newSize < comp.slots.length) {
      const dropped = comp.slots.slice(newSize).filter((s) => s.build || s.player || s.note);
      if (dropped.length && !confirm(`ลดขนาดเป็น ${newSize} คน?\nช่องที่จัดไว้แล้ว ${dropped.length} ช่อง (ลำดับท้าย) จะถูกตัดออก`)) {
        e.target.value = String(comp.slots.length);
        return;
      }
      comp.slots = comp.slots.slice(0, newSize);
    } else {
      while (comp.slots.length < newSize) comp.slots.push({ build: null, player: '', note: '' });
    }
    comp.size = comp.slots.length;
    scheduleSave();
    render();
  });

  root.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act]');
    const moveBtn = e.target.closest('[data-move]');
    if (moveBtn) {
      const tr = moveBtn.closest('tr');
      const idx = parseInt(tr.dataset.idx, 10);
      const dir = parseInt(moveBtn.dataset.move, 10);
      const to = idx + dir;
      if (to < 0 || to >= comp.slots.length) return;
      [comp.slots[idx], comp.slots[to]] = [comp.slots[to], comp.slots[idx]];
      scheduleSave();
      render();
      return;
    }
    if (!actBtn) return;
    const act = actBtn.dataset.act;
    if (act === 'back') {
      currentCompId = null;
      render();
    }
    if (act === 'del-comp') {
      if (!confirm(`ลบคอมป์ "${comp.name}" ?`)) return;
      state.comps = state.comps.filter((c) => c.id !== comp.id);
      currentCompId = null;
      scheduleSave();
      render();
    }
    if (act === 'dup-comp') {
      const copy = JSON.parse(JSON.stringify(comp));
      copy.id = uid();
      copy.name = comp.name + ' (สำเนา)';
      state.comps.push(copy);
      currentCompId = copy.id;
      scheduleSave();
      render();
    }
    if (act === 'clear-slot') {
      const tr = actBtn.closest('tr');
      const idx = parseInt(tr.dataset.idx, 10);
      comp.slots[idx] = { build: null, player: '', note: '' };
      scheduleSave();
      render();
    }
    if (act === 'copy-text') copyCompText(comp, actBtn);
  });

  // field bindings
  $$('.slot-table [data-field]', root).forEach((el) => {
    const tr = el.closest('tr');
    const idx = parseInt(tr.dataset.idx, 10);
    const field = el.dataset.field;
    if (field === 'build') {
      el.addEventListener('change', () => {
        comp.slots[idx].build = el.value || null;
        scheduleSave();
        render(); // update weapon icon + role badge + summary
        // render ทำลาย select เดิม — คืน focus ให้ช่องเดิมเพื่อให้กด Tab กรอกต่อได้
        const fresh = document.querySelector(`tr[data-idx="${idx}"] [data-field="build"]`);
        if (fresh) fresh.focus();
      });
    } else {
      el.addEventListener('input', () => {
        comp.slots[idx][field] = el.value;
        scheduleSave();
      });
    }
  });
}

async function copyCompText(comp, btn) {
  const partySize = 5;
  const lines = [`📋 ${comp.name} (${comp.slots.length} คน)`];
  comp.slots.forEach((s, i) => {
    if (comp.slots.length > partySize && i % partySize === 0) lines.push(`— ปาร์ตี้ ${i / partySize + 1} —`);
    const b = state.builds.find((x) => x.id === s.build);
    const role = b ? `[${roleLabel(b.role)}]` : '[ว่าง]';
    const buildName = b ? b.name : '-';
    const wp = b ? item(b.weapon)?.name : null;
    lines.push(`${i + 1}. ${role} ${buildName}${wp ? ` (${wp})` : ''} — ${s.player || '......'}${s.note ? ` *${s.note}` : ''}`);
  });
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flashBtn(btn, '✓ คัดลอกแล้ว');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    flashBtn(btn, '✓ คัดลอกแล้ว');
  }
}

function flashBtn(btn, text) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------- export / import ----------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'albion-comp-data.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.builds) || !Array.isArray(data.comps)) throw new Error('bad shape');
      const builds = sanitizeBuilds(data.builds);
      const comps = sanitizeComps(data.comps);
      if (!confirm(`นำเข้า ${builds.length} บิลด์ และ ${comps.length} คอมป์?\n\nข้อมูลปัจจุบันจะถูกแทนที่ทั้งหมด`)) return;
      state.builds = builds;
      state.comps = comps;
      currentCompId = null;
      render();
      scheduleSave();
    } catch {
      alert('ไฟล์ไม่ถูกต้อง — ต้องเป็นไฟล์ JSON ที่ Export จากแอปนี้');
    }
  };
  reader.readAsText(file);
}

// ---------- main render ----------
function render(keepFocus = false) {
  const root = $('#view');
  // replace node to drop old event listeners
  const fresh = root.cloneNode(false);
  root.replaceWith(fresh);

  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === currentTab));

  if (currentTab === 'builds') {
    renderBuilds(fresh);
    if (keepFocus) {
      const s = $('#bf-search', fresh);
      if (s) {
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }
    }
  } else {
    const comp = state.comps.find((c) => c.id === currentCompId);
    if (comp) renderCompDetail(fresh, comp);
    else {
      currentCompId = null;
      renderCompList(fresh);
    }
  }
}

// ---------- init ----------
async function init() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      currentTab = t.dataset.tab;
      render();
    }),
  );
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => {
    if (!canEdit) return;
    $('#import-file').click();
  });
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0] && canEdit) importData(e.target.files[0]);
    e.target.value = '';
  });

  await loadAll();
  await initAuth();
  startRealtime();

  if (ITEMS.length === 0 && !state.builds.length && !state.comps.length) {
    $('#view').innerHTML = `<div class="empty-hint">⚠ โหลดรายการไอเทมไม่ได้<br/>
      เปิดในเครื่อง: รัน <b>node server.js</b> แล้วเปิด <b>http://localhost:3000</b> (หรือดับเบิลคลิก <b>start.bat</b>)<br/>
      บนเว็บ: ตรวจว่าไฟล์ <b>items.json</b> ถูกอัปโหลดขึ้น GitHub แล้ว</div>`;
    return;
  }
  // โหลดรายชื่อไอเทมไม่ได้แต่มีข้อมูลอยู่ → ยังแสดงบิลด์/คอมป์ได้ แค่ไม่มีรูป (อย่าทำหน้าว่าง)
  if (ITEMS.length === 0) setSaveStatus('โหลดรายการไอเทมไม่ได้ — แสดงข้อมูลแบบไม่มีรูปไอเทม', 'warn');
  else if (MODE === 'browser') setSaveStatus('ข้อมูลเก็บในเบราว์เซอร์นี้เท่านั้น', 'warn');
  else if (MODE === 'local' && !serverOk) setSaveStatus('โหมดออฟไลน์', 'warn');
  render();
}

init().catch((e) => {
  console.error('init failed:', e);
  const v = $('#view');
  if (v && !v.innerHTML) {
    v.innerHTML = `<div class="empty-hint">⚠ เกิดข้อผิดพลาดตอนเปิดแอป — ลองรีโหลดหน้า<br/>
      <span style="font-size:12px;color:var(--text-dim)">${esc(String(e && e.message ? e.message : e))}</span></div>`;
  }
});
