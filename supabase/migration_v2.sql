-- ============================================================================
-- AmitVet · מיגרציה v2 — תכונות נוספות
-- הריצו את כל הקובץ ב-Supabase → SQL Editor (בטוח להריץ גם אם כבר רץ).
-- מוסיף: משימות, מרשמים/תרופות, מעקב משקל, ופרטי מרפאה.
-- ============================================================================

-- ---------- טבלאות ----------

create table if not exists public.tasks (
  id         bigint generated always as identity primary key,
  created_by uuid references public.profiles(id) on delete set null,
  title      text not null,
  notes      text,
  due_date   date,
  priority   text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status     text not null default 'open' check (status in ('open','done')),
  client_id  uuid references public.profiles(id) on delete set null,
  pet_id     bigint references public.pets(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.prescriptions (
  id           bigint generated always as identity primary key,
  pet_id       bigint not null references public.pets(id) on delete cascade,
  vet_id       uuid references public.profiles(id) on delete set null,
  medication   text not null,
  dosage       text,
  instructions text,
  start_date   date default current_date,
  end_date     date,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.weight_logs (
  id          bigint generated always as identity primary key,
  pet_id      bigint not null references public.pets(id) on delete cascade,
  weight_kg   numeric not null,
  measured_at date not null default current_date,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.clinic_settings (
  id             int primary key default 1 check (id = 1),
  clinic_name    text,
  phone          text,
  address        text,
  hours          text,
  emergency_info text,
  updated_at     timestamptz default now()
);
insert into public.clinic_settings (id) values (1) on conflict (id) do nothing;

-- ---------- RLS ----------

alter table public.tasks          enable row level security;
alter table public.prescriptions  enable row level security;
alter table public.weight_logs    enable row level security;
alter table public.clinic_settings enable row level security;

-- tasks: לווטרינר בלבד.
drop policy if exists tasks_all on public.tasks;
create policy tasks_all on public.tasks for all using (public.is_vet()) with check (public.is_vet());

-- prescriptions: הבעלים קורא לחיות שלו; רק וטרינר כותב.
drop policy if exists rx_select on public.prescriptions;
create policy rx_select on public.prescriptions for select using (
  exists (select 1 from public.pets p where p.id = prescriptions.pet_id and (p.owner_id = auth.uid() or public.is_vet()))
);
drop policy if exists rx_insert on public.prescriptions;
create policy rx_insert on public.prescriptions for insert with check (public.is_vet());
drop policy if exists rx_update on public.prescriptions;
create policy rx_update on public.prescriptions for update using (public.is_vet());
drop policy if exists rx_delete on public.prescriptions;
create policy rx_delete on public.prescriptions for delete using (public.is_vet());

-- weight_logs: הבעלים קורא לחיות שלו; רק וטרינר כותב.
drop policy if exists wl_select on public.weight_logs;
create policy wl_select on public.weight_logs for select using (
  exists (select 1 from public.pets p where p.id = weight_logs.pet_id and (p.owner_id = auth.uid() or public.is_vet()))
);
drop policy if exists wl_insert on public.weight_logs;
create policy wl_insert on public.weight_logs for insert with check (public.is_vet());
drop policy if exists wl_delete on public.weight_logs;
create policy wl_delete on public.weight_logs for delete using (public.is_vet());

-- clinic_settings: כל משתמש מחובר קורא; רק וטרינר מעדכן.
drop policy if exists clinic_select on public.clinic_settings;
create policy clinic_select on public.clinic_settings for select using (auth.uid() is not null);
drop policy if exists clinic_update on public.clinic_settings;
create policy clinic_update on public.clinic_settings for update using (public.is_vet());

create index if not exists idx_rx_pet  on public.prescriptions(pet_id);
create index if not exists idx_wl_pet  on public.weight_logs(pet_id);
create index if not exists idx_task_status on public.tasks(status);
