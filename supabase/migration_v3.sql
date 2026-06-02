-- ============================================================================
-- AmitVet · מיגרציה v3 — תזכורות תור אוטומטיות (P0)
-- הריצו ב-Supabase → SQL Editor (idempotent — בטוח להריץ שוב).
-- מוסיף: סטטוס no_show, טבלת notifications (יומן + מניעת כפילויות),
-- וטבלת appointment_tokens (אישור/ביטול חד-פעמי מתוך התזכורת).
-- את חיווט ה-pg_cron ראו בקובץ הנפרד supabase/setup_cron.sql.
-- ============================================================================

-- ---------- 1. סטטוס no_show לתורים ----------
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('requested','confirmed','completed','cancelled','no_show'));

-- ---------- 2. יומן התראות (notifications) ----------
create table if not exists public.notifications (
  id             bigint generated always as identity primary key,
  recipient_id   uuid references public.profiles(id) on delete set null,
  appointment_id bigint references public.appointments(id) on delete cascade,
  channel        text not null default 'email',          -- email | whatsapp | sms
  template       text not null,                           -- reminder_24h | reminder_2h
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'scheduled'
                 check (status in ('scheduled','sent','failed','cancelled')),
  send_at        timestamptz not null default now(),
  sent_at        timestamptz,
  error          text,
  created_at     timestamptz not null default now()
);
-- מונע כפילות: לכל תור — לכל היותר תזכורת אחת מכל סוג.
create unique index if not exists uq_notifications_appt_template
  on public.notifications (appointment_id, template);
create index if not exists idx_notifications_due
  on public.notifications (status, send_at);

-- ---------- 3. טוקני פעולה חד-פעמיים (אישור/ביטול מהתזכורת) ----------
create table if not exists public.appointment_tokens (
  token          uuid primary key default gen_random_uuid(),
  appointment_id bigint not null references public.appointments(id) on delete cascade,
  created_at     timestamptz not null default now(),
  used_at        timestamptz
);
create index if not exists idx_appt_tokens_appt on public.appointment_tokens (appointment_id);

-- ---------- 4. RLS ----------
alter table public.notifications      enable row level security;
alter table public.appointment_tokens enable row level security;

-- notifications: הווטרינר קורא (יומן). הכתיבה נעשית רק ע"י ה-Edge Function
-- (service_role עוקף RLS), ולכן אין policy ל-insert/update עבור משתמשים רגילים.
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select using (public.is_vet());

-- appointment_tokens: סוד. אין שום policy → לקוחות/וטרינר (anon/authenticated)
-- לא יכולים לקרוא או לכתוב. רק ה-Edge Function (service_role) ניגש אליהם.
-- (RLS מופעל ללא policies = גישה חסומה לכולם פרט ל-service_role.)
