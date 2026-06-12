-- ============================================================
-- Albion Comp Manager — ตั้งค่าฐานข้อมูล Supabase (รันครั้งเดียว)
-- วิธีใช้: เปิดโปรเจกต์ใน supabase.com → SQL Editor → วางทั้งไฟล์นี้ → Run
-- ============================================================

-- ตารางเก็บข้อมูลทั้งแอปเป็นเอกสารเดียว (แบบเดียวกับ data.json)
create table if not exists public.app_data (
  id int primary key,
  rev bigint not null default 0,
  saved_at timestamptz not null default now(),
  data jsonb not null default '{"builds":[],"comps":[]}'::jsonb
);

-- แถวเดียวที่ใช้งาน (id = 1)
insert into public.app_data (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- รายชื่อ "ผู้จัดทีม" ที่ได้รับสิทธิ์แก้ข้อมูล (allowlist)
-- การล็อกอินได้อย่างเดียวไม่พอ — ต้องอยู่ในตารางนี้ด้วย
-- จึงปลอดภัยแม้ใครจะแอบสมัครบัญชีผ่าน API ได้
-- ------------------------------------------------------------
create table if not exists public.organizers (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.organizers enable row level security;

-- ให้แต่ละคนเช็คได้แค่ "ตัวเอง" อยู่ใน allowlist ไหม (จำเป็นต่อ policy ด้านล่าง)
drop policy if exists "self check" on public.organizers;
create policy "self check" on public.organizers
  for select to authenticated using (user_id = auth.uid());
-- ไม่มี policy เขียน = เพิ่ม/ลบผู้จัดได้จาก SQL Editor / Dashboard เท่านั้น

-- ------------------------------------------------------------
-- สิทธิ์ของตารางข้อมูลหลัก
-- ------------------------------------------------------------
alter table public.app_data enable row level security;

-- ทุกคน (รวมไม่ล็อกอิน) อ่านได้ — เพื่อนกิลด์เปิดดูคอมป์ได้เลย
drop policy if exists "public read" on public.app_data;
create policy "public read" on public.app_data
  for select using (true);

-- แก้ได้เฉพาะคนที่ "ล็อกอิน + อยู่ใน allowlist" และห้ามเปลี่ยน id (กันทำแถว id=1 หาย)
drop policy if exists "auth write" on public.app_data;
drop policy if exists "organizer write" on public.app_data;
create policy "organizer write" on public.app_data
  for update to authenticated
  using (id = 1 and exists (select 1 from public.organizers o where o.user_id = auth.uid()))
  with check (id = 1 and exists (select 1 from public.organizers o where o.user_id = auth.uid()));

-- กันแก้คอลัมน์ id ในทุกกรณี (แถว id=1 คือหัวใจของแอป):
-- ต้อง revoke สิทธิ์ update ระดับตารางก่อน แล้ว grant กลับเฉพาะคอลัมน์ที่แอปใช้
revoke update on public.app_data from authenticated, anon;
grant update (rev, saved_at, data) on public.app_data to authenticated;

-- ไม่มี policy insert/delete = ไม่มีใครเพิ่ม/ลบแถวได้

-- เปิด Realtime ให้หน้าเว็บคนอื่นอัปเดตทันทีเมื่อมีการแก้
do $$
begin
  alter publication supabase_realtime add table public.app_data;
exception
  when duplicate_object then null;
end $$;

-- ============================================================
-- หลังจากสร้างบัญชีผู้จัดใน Authentication → Users แล้ว
-- ต้องเพิ่มเขาเข้า allowlist ด้วยคำสั่งนี้ (แก้อีเมลให้ตรง แล้ว Run):
-- ============================================================
-- insert into public.organizers (user_id)
--   select id from auth.users where email = 'YOUR-EMAIL@example.com'
--   on conflict (user_id) do nothing;
