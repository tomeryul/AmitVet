-- ============================================================================
-- AmitVet · Supabase schema  (הריצו את כל הקובץ ב-Supabase → SQL Editor)
-- כולל: טבלאות, יצירת פרופיל אוטומטית בהרשמה, ומדיניות אבטחה (RLS).
-- ============================================================================

-- ---------- 1. טבלאות ----------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  email      text,
  phone      text,
  role       text not null default 'client' check (role in ('client','vet')),
  created_at timestamptz not null default now()
);

create table if not exists public.pets (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  species    text not null,
  breed      text,
  sex        text default 'unknown' check (sex in ('male','female','unknown')),
  birthdate  date,
  weight_kg  numeric,
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id           bigint generated always as identity primary key,
  client_id    uuid not null references public.profiles(id) on delete cascade,
  pet_id       bigint references public.pets(id) on delete set null,
  type         text not null default 'checkup',
  scheduled_at timestamptz not null,
  duration_min int not null default 30,
  reason       text,
  status       text not null default 'requested' check (status in ('requested','confirmed','completed','cancelled')),
  vet_notes    text,
  created_at   timestamptz not null default now()
);

create table if not exists public.inquiries (
  id         bigint generated always as identity primary key,
  client_id  uuid not null references public.profiles(id) on delete cascade,
  pet_id     bigint references public.pets(id) on delete set null,
  subject    text not null,
  priority   text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status     text not null default 'open' check (status in ('open','in_progress','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  inquiry_id bigint not null references public.inquiries(id) on delete cascade,
  sender_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.medical_records (
  id         bigint generated always as identity primary key,
  pet_id     bigint not null references public.pets(id) on delete cascade,
  vet_id     uuid references public.profiles(id) on delete set null,
  visit_date date not null default current_date,
  diagnosis  text,
  treatment  text,
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists public.vaccinations (
  id           bigint generated always as identity primary key,
  pet_id       bigint not null references public.pets(id) on delete cascade,
  vaccine_name text not null,
  date_given   date not null default current_date,
  next_due     date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ---------- 2. יצירת פרופיל אוטומטית בהרשמה ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, phone, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'phone',
    'client'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 3. עזר: האם המשתמש הנוכחי הוא וטרינר ----------
-- security definer כדי לעקוף RLS בעת בדיקת התפקיד (מונע רקורסיה).

create or replace function public.is_vet()
returns boolean
language sql
security definer stable set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'vet');
$$;

-- ---------- 4. הפעלת RLS ----------

alter table public.profiles        enable row level security;
alter table public.pets            enable row level security;
alter table public.appointments    enable row level security;
alter table public.inquiries       enable row level security;
alter table public.messages        enable row level security;
alter table public.medical_records enable row level security;
alter table public.vaccinations    enable row level security;

-- ---------- 5. מדיניות גישה ----------

-- profiles: כל אחד רואה את עצמו; וטרינר רואה את כולם.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_vet());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid());
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());

-- pets: הבעלים מנהל את שלו; וטרינר רואה/מנהל הכל.
drop policy if exists pets_select on public.pets;
create policy pets_select on public.pets for select using (owner_id = auth.uid() or public.is_vet());
drop policy if exists pets_insert on public.pets;
create policy pets_insert on public.pets for insert with check (owner_id = auth.uid() or public.is_vet());
drop policy if exists pets_update on public.pets;
create policy pets_update on public.pets for update using (owner_id = auth.uid() or public.is_vet());
drop policy if exists pets_delete on public.pets;
create policy pets_delete on public.pets for delete using (owner_id = auth.uid() or public.is_vet());

-- appointments: הלקוח על שלו; וטרינר על הכל.
drop policy if exists appt_select on public.appointments;
create policy appt_select on public.appointments for select using (client_id = auth.uid() or public.is_vet());
drop policy if exists appt_insert on public.appointments;
create policy appt_insert on public.appointments for insert with check (client_id = auth.uid() or public.is_vet());
drop policy if exists appt_update on public.appointments;
create policy appt_update on public.appointments for update using (client_id = auth.uid() or public.is_vet());
drop policy if exists appt_delete on public.appointments;
create policy appt_delete on public.appointments for delete using (public.is_vet());

-- inquiries: הלקוח על שלו; וטרינר על הכל.
drop policy if exists inq_select on public.inquiries;
create policy inq_select on public.inquiries for select using (client_id = auth.uid() or public.is_vet());
drop policy if exists inq_insert on public.inquiries;
create policy inq_insert on public.inquiries for insert with check (client_id = auth.uid() or public.is_vet());
drop policy if exists inq_update on public.inquiries;
create policy inq_update on public.inquiries for update using (client_id = auth.uid() or public.is_vet());

-- messages: רק משתתפי הפנייה (הלקוח שפתח אותה או הווטרינר).
drop policy if exists msg_select on public.messages;
create policy msg_select on public.messages for select using (
  exists (select 1 from public.inquiries i where i.id = messages.inquiry_id and (i.client_id = auth.uid() or public.is_vet()))
);
drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert with check (
  sender_id = auth.uid()
  and exists (select 1 from public.inquiries i where i.id = messages.inquiry_id and (i.client_id = auth.uid() or public.is_vet()))
);

-- medical_records: הבעלים קורא לחיות שלו; רק וטרינר כותב.
drop policy if exists med_select on public.medical_records;
create policy med_select on public.medical_records for select using (
  exists (select 1 from public.pets p where p.id = medical_records.pet_id and (p.owner_id = auth.uid() or public.is_vet()))
);
drop policy if exists med_insert on public.medical_records;
create policy med_insert on public.medical_records for insert with check (public.is_vet());
drop policy if exists med_update on public.medical_records;
create policy med_update on public.medical_records for update using (public.is_vet());
drop policy if exists med_delete on public.medical_records;
create policy med_delete on public.medical_records for delete using (public.is_vet());

-- vaccinations: הבעלים קורא לחיות שלו; רק וטרינר כותב.
drop policy if exists vac_select on public.vaccinations;
create policy vac_select on public.vaccinations for select using (
  exists (select 1 from public.pets p where p.id = vaccinations.pet_id and (p.owner_id = auth.uid() or public.is_vet()))
);
drop policy if exists vac_insert on public.vaccinations;
create policy vac_insert on public.vaccinations for insert with check (public.is_vet());
drop policy if exists vac_update on public.vaccinations;
create policy vac_update on public.vaccinations for update using (public.is_vet());
drop policy if exists vac_delete on public.vaccinations;
create policy vac_delete on public.vaccinations for delete using (public.is_vet());

-- ---------- 6. הודעות בזמן אמת (Realtime) ----------
alter publication supabase_realtime add table public.messages;

-- ============================================================================
-- אחרי שנרשמתם דרך האתר, הפכו את החשבון שלכם לווטרינר ראשי:
--   update public.profiles set role = 'vet'
--   where email = 'האימייל-שלכם@דוגמה.com';
-- ============================================================================
