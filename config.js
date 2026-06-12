// ===== การตั้งค่า Supabase (สำหรับโหมดคลาวด์ — แชร์ข้อมูลให้ทั้งกิลด์) =====
// เอาค่าจาก supabase.com → โปรเจกต์ของคุณ → Project Settings → API Keys
//   SUPABASE_URL      = Project URL  (เช่น https://abcdefgh.supabase.co)
//   SUPABASE_ANON_KEY = anon / public key (เปิดเผยได้ ปลอดภัยด้วย Row Level Security)
// ปล่อยว่างทั้งคู่ = ใช้โหมดเดิม (local server / localStorage)
window.APP_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};
