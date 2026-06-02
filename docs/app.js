'use strict';

/* ============================ Helpers ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Render any <i data-lucide> placeholders into inline SVGs (Garden design language).
function drawIcons() { try { window.lucide && window.lucide.createIcons(); } catch {} }

/* ---- Supabase client ---- */
const CFG = window.AMITVET_CONFIG || {};
const CONFIG_OK = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY);
const sb = CONFIG_OK ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

function must({ data, error }) { if (error) throw new Error(error.message || 'שגיאה מול השרת'); return data; }
const uid = () => State.user && State.user.id;
const vet = () => State.user && State.user.role === 'vet';
let _profile = null;
async function loadProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('נדרשת התחברות');
  if (!_profile || _profile.id !== user.id) {
    _profile = must(await sb.from('profiles').select('*').eq('id', user.id).single());
  }
  return { ..._profile, email: user.email };
}

/*
 * api() — תאימות-לאחור: ממפה את אותן קריאות REST שהשתמשנו בהן עם שרת ה-Node
 * אל קריאות Supabase, כך שכל קוד הממשק נשאר ללא שינוי.
 */
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const b = opts.body || {};
  const [raw, qsStr] = path.split('?');
  const q = Object.fromEntries(new URLSearchParams(qsStr || ''));
  const s = raw.split('/').filter(Boolean); // e.g. ['pets','5']
  const petId = b.pet_id ? Number(b.pet_id) : null;

  // ---------------- auth ----------------
  if (raw === '/auth/me') { const p = await loadProfile();
    return { user: { id: p.id, name: p.name, email: p.email, phone: p.phone, role: p.role, created_at: p.created_at } }; }

  if (raw === '/auth/login') {
    const { error } = await sb.auth.signInWithPassword({ email: b.email, password: b.password });
    if (error) throw new Error('אימייל או סיסמה שגויים');
    _profile = null; const p = await loadProfile();
    return { user: { id: p.id, name: p.name, role: p.role } };
  }
  if (raw === '/auth/register') {
    const { data, error } = await sb.auth.signUp({ email: b.email, password: b.password, options: { data: { name: b.name, phone: b.phone || null } } });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error('החשבון נוצר. אם נדרש אימות מייל — אשרו את הקישור שנשלח אליכם ואז התחברו.');
    _profile = null; const p = await loadProfile();
    return { user: { id: p.id, name: p.name, role: p.role } };
  }
  if (raw === '/auth/logout') { await sb.auth.signOut(); _profile = null; return { ok: true }; }

  // ---------------- pets ----------------
  if (s[0] === 'pets' && s.length === 1 && method === 'GET') {
    const rows = must(await sb.from('pets').select('*, owner:profiles!owner_id(name,phone)').order('created_at', { ascending: false }));
    return { pets: rows.map((p) => ({ ...p, owner_name: p.owner?.name, owner_phone: p.owner?.phone })) };
  }
  if (s[0] === 'pets' && s.length === 2 && method === 'GET') {
    const pet = must(await sb.from('pets').select('*').eq('id', s[1]).single());
    const vaccinations = must(await sb.from('vaccinations').select('*').eq('pet_id', s[1]).order('date_given', { ascending: false }));
    const recs = must(await sb.from('medical_records').select('*, vet:profiles!vet_id(name)').eq('pet_id', s[1]).order('visit_date', { ascending: false }));
    const prescriptions = must(await sb.from('prescriptions').select('*').eq('pet_id', s[1]).order('active', { ascending: false }).order('start_date', { ascending: false }));
    const weights = must(await sb.from('weight_logs').select('*').eq('pet_id', s[1]).order('measured_at', { ascending: true }));
    return { pet, vaccinations, records: recs.map((r) => ({ ...r, vet_name: r.vet?.name })), prescriptions, weights };
  }
  if (s[0] === 'pets' && method === 'POST') {
    const row = { owner_id: vet() && b.owner_id ? b.owner_id : uid(), name: b.name, species: b.species, breed: b.breed || null,
      sex: ['male', 'female', 'unknown'].includes(b.sex) ? b.sex : 'unknown', birthdate: b.birthdate || null,
      weight_kg: b.weight_kg ? Number(b.weight_kg) : null, notes: b.notes || null };
    return { pet: must(await sb.from('pets').insert(row).select().single()) };
  }
  if (s[0] === 'pets' && method === 'PUT') {
    const row = { name: b.name, species: b.species, breed: b.breed || null,
      sex: ['male', 'female', 'unknown'].includes(b.sex) ? b.sex : 'unknown', birthdate: b.birthdate || null,
      weight_kg: b.weight_kg != null && b.weight_kg !== '' ? Number(b.weight_kg) : null, notes: b.notes || null };
    return { pet: must(await sb.from('pets').update(row).eq('id', s[1]).select().single()) };
  }
  if (s[0] === 'pets' && method === 'DELETE') { must(await sb.from('pets').delete().eq('id', s[1])); return { ok: true }; }

  // ---------------- appointments ----------------
  if (s[0] === 'appointments' && s.length === 1 && method === 'GET') {
    let qy = sb.from('appointments').select('*, client:profiles!client_id(name,phone), pet:pets(name,species)');
    if (vet() && q.status) qy = qy.eq('status', q.status);
    qy = qy.order('scheduled_at', { ascending: vet() });
    const rows = must(await qy);
    return { appointments: rows.map((a) => ({ ...a, client_name: a.client?.name, client_phone: a.client?.phone, pet_name: a.pet?.name, pet_species: a.pet?.species })) };
  }
  if (s[0] === 'appointments' && method === 'POST') {
    const row = { client_id: vet() && b.client_id ? b.client_id : uid(), pet_id: petId,
      type: b.type || 'checkup', scheduled_at: b.scheduled_at, duration_min: b.duration_min ? Number(b.duration_min) : 30,
      reason: b.reason || null, status: vet() ? 'confirmed' : 'requested' };
    return { appointment: must(await sb.from('appointments').insert(row).select().single()) };
  }
  if (s[0] === 'appointments' && s.length === 2 && method === 'PATCH') {
    if (!vet()) { must(await sb.from('appointments').update({ status: 'cancelled' }).eq('id', s[1])); return { appointment: { id: Number(s[1]) } }; }
    const patch = {};
    if (b.status) patch.status = b.status;
    if (b.scheduled_at) patch.scheduled_at = b.scheduled_at;
    if (b.vet_notes !== undefined) patch.vet_notes = b.vet_notes;
    if (b.type) patch.type = b.type;
    if (b.reason !== undefined) patch.reason = b.reason;
    return { appointment: must(await sb.from('appointments').update(patch).eq('id', s[1]).select().single()) };
  }
  if (s[0] === 'appointments' && method === 'DELETE') { must(await sb.from('appointments').delete().eq('id', s[1])); return { ok: true }; }

  // ---------------- inquiries ----------------
  if (s[0] === 'inquiries' && s.length === 1 && method === 'GET') {
    let qy = sb.from('inquiries').select('*, client:profiles!client_id(name), pet:pets(name), messages(count)');
    if (vet() && q.status) qy = qy.eq('status', q.status);
    const rows = must(await qy.order('updated_at', { ascending: false }));
    return { inquiries: rows.map((i) => ({ ...i, client_name: i.client?.name, pet_name: i.pet?.name, message_count: i.messages?.[0]?.count || 0 })) };
  }
  if (s[0] === 'inquiries' && s.length === 2 && method === 'GET') {
    const i = must(await sb.from('inquiries').select('*, client:profiles!client_id(name), pet:pets(name), messages(count)').eq('id', s[1]).single());
    const msgs = must(await sb.from('messages').select('*, sender:profiles!sender_id(name,role)').eq('inquiry_id', s[1]).order('created_at', { ascending: true }));
    return { inquiry: { ...i, client_name: i.client?.name, pet_name: i.pet?.name, message_count: i.messages?.[0]?.count || 0 },
      messages: msgs.map((m) => ({ ...m, sender_name: m.sender?.name, sender_role: m.sender?.role })) };
  }
  if (s[0] === 'inquiries' && s.length === 1 && method === 'POST') {
    const inq = must(await sb.from('inquiries').insert({ client_id: vet() && b.client_id ? b.client_id : uid(),
      pet_id: petId, subject: b.subject, priority: b.priority || 'normal' }).select('id').single());
    must(await sb.from('messages').insert({ inquiry_id: inq.id, sender_id: uid(), body: b.body }));
    return { inquiry: { id: inq.id } };
  }
  if (s[0] === 'inquiries' && s[2] === 'messages' && method === 'POST') {
    const msg = must(await sb.from('messages').insert({ inquiry_id: Number(s[1]), sender_id: uid(), body: b.body })
      .select('*, sender:profiles!sender_id(name,role)').single());
    const cur = must(await sb.from('inquiries').select('status').eq('id', s[1]).single());
    const newStatus = vet() && cur.status === 'open' ? 'in_progress' : cur.status;
    must(await sb.from('inquiries').update({ updated_at: new Date().toISOString(), status: newStatus }).eq('id', s[1]));
    return { message: { ...msg, sender_name: msg.sender?.name, sender_role: msg.sender?.role } };
  }
  if (s[0] === 'inquiries' && s.length === 2 && method === 'PATCH') {
    const patch = { updated_at: new Date().toISOString() };
    if (b.status) patch.status = b.status;
    if (vet() && b.priority) patch.priority = b.priority;
    return { inquiry: must(await sb.from('inquiries').update(patch).eq('id', s[1]).select().single()) };
  }

  // ---------------- medical / vaccinations ----------------
  if (raw === '/medical/records' && method === 'POST') {
    return { record: must(await sb.from('medical_records').insert({ pet_id: petId, vet_id: uid(),
      visit_date: b.visit_date || new Date().toISOString().slice(0, 10), diagnosis: b.diagnosis || null,
      treatment: b.treatment || null, notes: b.notes || null }).select().single()) };
  }
  if (s[0] === 'medical' && s[1] === 'records' && method === 'DELETE') { must(await sb.from('medical_records').delete().eq('id', s[2])); return { ok: true }; }
  if (raw === '/medical/vaccinations' && method === 'POST') {
    return { vaccination: must(await sb.from('vaccinations').insert({ pet_id: petId, vaccine_name: b.vaccine_name,
      date_given: b.date_given || new Date().toISOString().slice(0, 10), next_due: b.next_due || null, notes: b.notes || null }).select().single()) };
  }
  if (s[0] === 'medical' && s[1] === 'vaccinations' && method === 'DELETE') { must(await sb.from('vaccinations').delete().eq('id', s[2])); return { ok: true }; }

  // ---------------- admin ----------------
  if (raw === '/admin/clients') {
    const rows = must(await sb.from('profiles').select('id,name,email,phone,created_at, pets(count)').eq('role', 'client').order('name'));
    return { clients: rows.map((c) => ({ ...c, pet_count: c.pets?.[0]?.count || 0 })) };
  }
  if (raw === '/admin/dashboard') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const todayStr = start.toISOString().slice(0, 10);
    const in30 = new Date(start); in30.setDate(in30.getDate() + 30);
    const [pa, oi, tc, tp, ot] = await Promise.all([
      sb.from('appointments').select('id', { count: 'exact', head: true }).eq('status', 'requested'),
      sb.from('inquiries').select('id', { count: 'exact', head: true }).neq('status', 'resolved'),
      sb.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'client'),
      sb.from('pets').select('id', { count: 'exact', head: true }),
      sb.from('tasks').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    ]);
    const todayRows = must(await sb.from('appointments').select('*, client:profiles!client_id(name), pet:pets(name)')
      .gte('scheduled_at', start.toISOString()).lt('scheduled_at', end.toISOString())
      .in('status', ['confirmed', 'requested']).order('scheduled_at', { ascending: true }));
    const vacRows = must(await sb.from('vaccinations').select('*, pet:pets(name, owner:profiles!owner_id(name))')
      .gte('next_due', todayStr).lte('next_due', in30.toISOString().slice(0, 10)).order('next_due', { ascending: true }));
    return {
      stats: { pendingAppointments: pa.count || 0, openInquiries: oi.count || 0, totalClients: tc.count || 0, totalPets: tp.count || 0, openTasks: ot.count || 0 },
      todayAppointments: todayRows.map((a) => ({ ...a, client_name: a.client?.name, pet_name: a.pet?.name })),
      upcomingVaccinations: vacRows.map((v) => ({ ...v, pet_name: v.pet?.name, owner_name: v.pet?.owner?.name })),
    };
  }

  // ---------------- tasks (vet) ----------------
  if (s[0] === 'tasks' && s.length === 1 && method === 'GET') {
    let qy = sb.from('tasks').select('*, client:profiles!client_id(name), pet:pets(name)');
    if (q.status) qy = qy.eq('status', q.status);
    const rows = must(await qy.order('status', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }));
    return { tasks: rows.map((t) => ({ ...t, client_name: t.client?.name, pet_name: t.pet?.name })) };
  }
  if (s[0] === 'tasks' && method === 'POST') {
    return { task: must(await sb.from('tasks').insert({ created_by: uid(), title: b.title, notes: b.notes || null,
      due_date: b.due_date || null, priority: b.priority || 'normal',
      client_id: b.client_id || null, pet_id: b.pet_id ? Number(b.pet_id) : null }).select().single()) };
  }
  if (s[0] === 'tasks' && s.length === 2 && method === 'PATCH') {
    const patch = {};
    if (b.status) patch.status = b.status;
    if (b.title) patch.title = b.title;
    if (b.notes !== undefined) patch.notes = b.notes;
    if (b.due_date !== undefined) patch.due_date = b.due_date || null;
    if (b.priority) patch.priority = b.priority;
    return { task: must(await sb.from('tasks').update(patch).eq('id', s[1]).select().single()) };
  }
  if (s[0] === 'tasks' && method === 'DELETE') { must(await sb.from('tasks').delete().eq('id', s[1])); return { ok: true }; }

  // ---------------- prescriptions (vet writes) ----------------
  if (raw === '/prescriptions' && method === 'POST') {
    return { prescription: must(await sb.from('prescriptions').insert({ pet_id: petId, vet_id: uid(),
      medication: b.medication, dosage: b.dosage || null, instructions: b.instructions || null,
      start_date: b.start_date || new Date().toISOString().slice(0, 10), end_date: b.end_date || null,
      active: b.active !== undefined ? !!b.active : true }).select().single()) };
  }
  if (s[0] === 'prescriptions' && s.length === 2 && method === 'PATCH') {
    return { prescription: must(await sb.from('prescriptions').update({ active: !!b.active }).eq('id', s[1]).select().single()) };
  }
  if (s[0] === 'prescriptions' && method === 'DELETE') { must(await sb.from('prescriptions').delete().eq('id', s[1])); return { ok: true }; }

  // ---------------- weight logs (vet writes) ----------------
  if (raw === '/weights' && method === 'POST') {
    return { weight: must(await sb.from('weight_logs').insert({ pet_id: petId, weight_kg: Number(b.weight_kg),
      measured_at: b.measured_at || new Date().toISOString().slice(0, 10), notes: b.notes || null }).select().single()) };
  }
  if (s[0] === 'weights' && method === 'DELETE') { must(await sb.from('weight_logs').delete().eq('id', s[1])); return { ok: true }; }

  // ---------------- clinic settings ----------------
  if (raw === '/clinic' && method === 'GET') {
    return { clinic: must(await sb.from('clinic_settings').select('*').eq('id', 1).single()) };
  }
  if (raw === '/clinic' && method === 'PUT') {
    return { clinic: must(await sb.from('clinic_settings').update({ clinic_name: b.clinic_name || null, phone: b.phone || null,
      address: b.address || null, hours: b.hours || null, emergency_info: b.emergency_info || null,
      updated_at: new Date().toISOString() }).eq('id', 1).select().single()) };
  }

  // ---------------- reminders (client dashboard) ----------------
  if (raw === '/reminders' && method === 'GET') {
    const todayIso = new Date().toISOString();
    const todayStr = new Date().toISOString().slice(0, 10);
    const in60 = new Date(); in60.setDate(in60.getDate() + 60);
    const appts = must(await sb.from('appointments').select('*, pet:pets(name)')
      .gte('scheduled_at', todayIso).in('status', ['requested', 'confirmed']).order('scheduled_at', { ascending: true }));
    const vaccs = must(await sb.from('vaccinations').select('*, pet:pets(name)')
      .gte('next_due', todayStr).lte('next_due', in60.toISOString().slice(0, 10)).order('next_due', { ascending: true }));
    return {
      appointments: appts.map((a) => ({ ...a, pet_name: a.pet?.name })),
      vaccinations: vaccs.map((v) => ({ ...v, pet_name: v.pet?.name })),
    };
  }

  // ---------------- notifications log (vet) ----------------
  if (s[0] === 'notifications' && method === 'GET') {
    let qy = sb.from('notifications').select('*');
    if (q.appointment_id) qy = qy.eq('appointment_id', q.appointment_id);
    const rows = must(await qy.order('send_at', { ascending: true }));
    return { notifications: rows };
  }

  throw new Error('פעולה לא נתמכת: ' + method + ' ' + raw);
}

function toast(msg, type = '') {
  const t = el(`<div class="toast ${type}">${esc(msg)}</div>`);
  $('#toast-container').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

function openModal(title, bodyNode, footNode, onClose) {
  const overlay = el(`<div class="modal-overlay"><div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="x">×</button></div>
    <div class="modal-body"></div></div></div>`);
  overlay.querySelector('.modal-body').appendChild(bodyNode);
  if (footNode) { const f = el('<div class="modal-foot"></div>'); f.appendChild(footNode); overlay.querySelector('.modal').appendChild(f); }
  let closed = false;
  const close = () => { if (closed) return; closed = true; overlay.remove(); if (onClose) onClose(); };
  overlay.querySelector('.x').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  $('#modal-root').appendChild(overlay);
  return { close, overlay };
}

/* ============================ Dictionaries ============================ */
const APPT_TYPES = { checkup: 'בדיקה כללית', vaccination: 'חיסון', surgery: 'ניתוח', dental: 'טיפול שיניים',
  grooming: 'טיפוח', emergency: 'חירום', follow_up: 'מעקב', other: 'אחר' };
const APPT_STATUS = { requested: 'ממתין לאישור', confirmed: 'מאושר', completed: 'הושלם', cancelled: 'בוטל', no_show: 'לא הגיע' };
const NOTIF_TEMPLATE = { reminder_24h: 'תזכורת 24 שעות', reminder_2h: 'תזכורת שעתיים' };
const NOTIF_STATUS = { scheduled: 'מתוזמן', sent: 'נשלח', failed: 'נכשל', cancelled: 'בוטל' };
const INQ_STATUS = { open: 'פתוח', in_progress: 'בטיפול', resolved: 'נסגר' };
const PRIORITY = { low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', urgent: 'דחוף' };
const TASK_STATUS = { open: 'פתוחה', done: 'הושלמה' };
const SEX = { male: 'זכר', female: 'נקבה', unknown: 'לא ידוע' };
const SPECIES_ICON = (s) => { s = (s || '').toLowerCase();
  if (s.includes('כלב')) return '🐕'; if (s.includes('חתול')) return '🐈'; if (s.includes('ציפור') || s.includes('תוכי')) return '🦜';
  if (s.includes('ארנב')) return '🐇'; if (s.includes('סוס')) return '🐎'; if (s.includes('דג')) return '🐠'; return '🐾'; };

function fmtDateTime(s) { if (!s) return '—'; const d = new Date(s.replace(' ', 'T'));
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function fmtDate(s) { if (!s) return '—'; const d = new Date(s); return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function ageFrom(birth) { if (!birth) return null; const b = new Date(birth), now = new Date();
  let y = now.getFullYear() - b.getFullYear(); let m = now.getMonth() - b.getMonth();
  if (m < 0) { y--; m += 12; } return y > 0 ? `${y} שנים` : `${m} חודשים`; }

/* ============================ State ============================ */
const State = { user: null };

/* ============================ Bootstrap ============================ */
(async function init() {
  if (!CONFIG_OK) { renderSetup(); return; }
  try { const { user } = await api('/auth/me'); State.user = user; renderApp(); }
  catch { renderAuth(); }
})();

// Shown when docs/config.js still has placeholder Supabase credentials.
function renderSetup() {
  $('#app').innerHTML = '';
  $('#app').appendChild(el(`<div class="auth-wrap"><div class="auth-card" style="max-width:520px;text-align:right">
    <div class="auth-logo"><span class="mark"><i data-lucide="paw-print"></i></span></div>
    <h1>הגדרת AmitVet</h1>
    <p class="sub">חיבור ל-Supabase לא הושלם עדיין</p>
    <p style="margin-bottom:12px">כדי שהאתר יעבוד צריך למלא את פרטי ה-Supabase בקובץ
      <code>docs/config.js</code>:</p>
    <ol style="padding-in-start:20px;line-height:2;font-size:14px">
      <li>פתחו פרויקט חינמי ב-<b>supabase.com</b></li>
      <li>הריצו את הקובץ <code>supabase/schema.sql</code> ב-SQL Editor</li>
      <li>העתיקו את ה-<b>Project URL</b> וה-<b>anon key</b> (Settings → API) אל <code>docs/config.js</code></li>
    </ol>
    <p class="muted mt" style="font-size:13px">הסבר מלא בקובץ <code>README.md</code>.</p>
  </div></div>`));
  drawIcons();
}

/* ============================ Auth screen ============================ */
function renderAuth() {
  const root = $('#app');
  root.innerHTML = '';
  const wrap = el(`<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo"><span class="mark"><i data-lucide="paw-print"></i></span></div>
    <h1>AmitVet</h1>
    <p class="sub">המרפאה הווטרינרית שלך, במרחק קליק</p>
    <div class="tabs"><button data-t="login" class="active">התחברות</button><button data-t="register">הרשמה</button></div>
    <div id="auth-form"></div>
  </div></div>`);
  root.appendChild(wrap);
  drawIcons();
  const tabs = wrap.querySelectorAll('.tabs button');
  tabs.forEach((b) => b.onclick = () => { tabs.forEach((x) => x.classList.remove('active')); b.classList.add('active');
    b.dataset.t === 'login' ? loginForm() : registerForm(); });
  loginForm();
}

function loginForm() {
  const f = el(`<form>
    <div class="field"><label>אימייל</label><input type="email" name="email" required autocomplete="username"></div>
    <div class="field"><label>סיסמה</label><input type="password" name="password" required autocomplete="current-password"></div>
    <button class="btn block" type="submit">התחברות</button>
    <p class="muted mt" style="font-size:13px;text-align:center">לבדיקה: admin@amitvet.local / admin1234</p>
  </form>`);
  f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true;
    try { const { user } = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      State.user = user; renderApp(); } catch (err) { toast(err.message, 'err'); btn.disabled = false; } };
  $('#auth-form').replaceChildren(f);
}

function registerForm() {
  const f = el(`<form>
    <div class="field"><label>שם מלא</label><input name="name" required></div>
    <div class="field"><label>אימייל</label><input type="email" name="email" required></div>
    <div class="field"><label>טלפון</label><input name="phone" placeholder="050-0000000"></div>
    <div class="field"><label>סיסמה</label><input type="password" name="password" minlength="6" required></div>
    <button class="btn block" type="submit">יצירת חשבון</button>
  </form>`);
  f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true;
    try { const { user } = await api('/auth/register', { method: 'POST',
        body: { name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value } });
      State.user = user; toast('נרשמת בהצלחה!', 'ok'); renderApp(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; } };
  $('#auth-form').replaceChildren(f);
}

/* ============================ App shell ============================ */
const NAV = {
  vet: [
    { id: 'dashboard', label: 'לוח בקרה', icon: 'layout-dashboard' },
    { id: 'appointments', label: 'פגישות', icon: 'calendar', badge: 'pendingAppointments' },
    { id: 'inquiries', label: 'פניות', icon: 'message-circle', badge: 'openInquiries' },
    { id: 'tasks', label: 'משימות', icon: 'list-checks', badge: 'openTasks' },
    { id: 'clients', label: 'לקוחות', icon: 'users' },
    { id: 'pets', label: 'מטופלים', icon: 'paw-print' },
    { id: 'clinic', label: 'המרפאה', icon: 'building-2' },
  ],
  client: [
    { id: 'dashboard', label: 'בית', icon: 'home' },
    { id: 'pets', label: 'החיות שלי', icon: 'paw-print' },
    { id: 'appointments', label: 'הפגישות שלי', icon: 'calendar' },
    { id: 'inquiries', label: 'הפניות שלי', icon: 'message-circle' },
    { id: 'clinic', label: 'המרפאה', icon: 'building-2' },
  ],
};

function renderApp() {
  const root = $('#app');
  const isVet = State.user.role === 'vet';
  root.innerHTML = '';
  const shell = el(`<div>
    <div class="topbar">
      <div class="brand"><span class="mark"><i data-lucide="paw-print"></i></span> AmitVet</div>
      <div class="user"><span>${esc(State.user.name)}</span>
        <span class="role-badge">${isVet ? 'וטרינר ראשי' : 'לקוח'}</span>
        <button class="btn ghost sm" id="logout">יציאה</button></div>
    </div>
    <div class="layout">
      <aside class="sidebar"><nav></nav></aside>
      <main class="content" id="view"></main>
    </div>
  </div>`);
  root.appendChild(shell);
  const nav = shell.querySelector('nav');
  NAV[State.user.role].forEach((item) => {
    const b = el(`<button data-v="${item.id}"><span class="ico"><i data-lucide="${item.icon}"></i></span><span>${item.label}</span>${item.badge ? `<span class="count" data-badge="${item.badge}" hidden></span>` : ''}</button>`);
    b.onclick = () => navigate(item.id);
    nav.appendChild(b);
  });
  shell.querySelector('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); State.user = null; renderAuth(); };
  drawIcons();
  navigate('dashboard');
  if (isVet) refreshBadges();
}

// Updates the sidebar count badges (vet) from the dashboard stats.
async function refreshBadges() {
  try {
    const { stats } = await api('/admin/dashboard');
    document.querySelectorAll('.sidebar .count[data-badge]').forEach((sp) => {
      const n = stats[sp.dataset.badge] || 0;
      if (n > 0) { sp.textContent = n; sp.hidden = false; } else { sp.hidden = true; }
    });
  } catch {}
}

function navigate(view) {
  document.querySelectorAll('.sidebar nav button').forEach((b) => b.classList.toggle('active', b.dataset.v === view));
  const fn = { dashboard: viewDashboard, pets: viewPets, appointments: viewAppointments, inquiries: viewInquiries,
    clients: viewClients, tasks: viewTasks, clinic: viewClinic }[view];
  fn();
}

function setView(node) { $('#view').replaceChildren(node); }
function loadingView() { setView(el('<div class="loading-screen"><div class="spinner"></div></div>')); }

/* ============================ Dashboard ============================ */
async function viewDashboard() {
  loadingView();
  if (State.user.role === 'vet') return vetDashboard();
  return clientDashboard();
}

async function vetDashboard() {
  const { stats, todayAppointments, upcomingVaccinations } = await api('/admin/dashboard');
  const node = el(`<div>
    <div class="page-head"><h2>לוח בקרה</h2></div>
    <div class="grid cols-3 mb">
      <div class="stat-card"><div class="n">${stats.pendingAppointments}</div><div class="l">בקשות פגישה ממתינות</div></div>
      <div class="stat-card"><div class="n">${stats.openInquiries}</div><div class="l">פניות פתוחות</div></div>
      <div class="stat-card"><div class="n">${stats.openTasks || 0}</div><div class="l">משימות פתוחות</div></div>
      <div class="stat-card"><div class="n">${stats.totalClients}</div><div class="l">לקוחות רשומים</div></div>
      <div class="stat-card"><div class="n">${stats.totalPets}</div><div class="l">מטופלים</div></div>
    </div>
    <div class="section-title">📅 הפגישות של היום</div>
    <div id="today"></div>
    <div class="section-title">💉 חיסונים מתקרבים (30 יום)</div>
    <div id="vacc"></div>
  </div>`);
  const today = node.querySelector('#today');
  if (!todayAppointments.length) today.appendChild(el('<p class="muted">אין פגישות מתוכננות להיום.</p>'));
  todayAppointments.forEach((a) => today.appendChild(apptListItem(a)));
  const vacc = node.querySelector('#vacc');
  if (!upcomingVaccinations.length) vacc.appendChild(el('<p class="muted">אין חיסונים שמועדם מתקרב.</p>'));
  upcomingVaccinations.forEach((v) => vacc.appendChild(el(
    `<div class="list-item"><div class="avatar">💉</div><div class="grow">
      <div class="title">${esc(v.vaccine_name)} · ${esc(v.pet_name)}</div>
      <div class="meta">בעלים: ${esc(v.owner_name)} · מועד הבא: ${fmtDate(v.next_due)}</div></div></div>`)));
  setView(node);
}

async function clientDashboard() {
  const [{ appointments }, { pets }, reminders] = await Promise.all([
    api('/appointments'), api('/pets'), api('/reminders')]);
  const upcoming = appointments.filter((a) => a.status !== 'cancelled' && a.status !== 'completed').slice(0, 3);
  const node = el(`<div>
    <div class="page-head"><h2>שלום, ${esc(State.user.name)} 👋</h2></div>
    <div class="grid cols-3 mb">
      <div class="card click" id="q-appt"><div class="avatar">📅</div><h3 class="mt">קביעת פגישה</h3><p class="muted">בקש/י תור לחיה שלך</p></div>
      <div class="card click" id="q-inq"><div class="avatar">💬</div><h3 class="mt">פנייה לווטרינר</h3><p class="muted">יש לך שאלה? כתוב/כתבי לנו</p></div>
      <div class="card click" id="q-pet"><div class="avatar">🐾</div><h3 class="mt">הוספת חיה</h3><p class="muted">${pets.length} חיות רשומות</p></div>
    </div>
    <div class="section-title">🔔 תזכורות</div>
    <div id="reminders"></div>
    <div class="section-title">📅 הפגישות הקרובות שלך</div>
    <div id="up"></div>
  </div>`);
  node.querySelector('#q-appt').onclick = () => navigate('appointments');
  node.querySelector('#q-inq').onclick = () => navigate('inquiries');
  node.querySelector('#q-pet').onclick = () => navigate('pets');

  const rem = node.querySelector('#reminders');
  const vaccDue = reminders.vaccinations || [];
  const apptSoon = (reminders.appointments || []).slice(0, 3);
  if (!vaccDue.length && !apptSoon.length) rem.appendChild(el('<p class="muted">אין תזכורות כרגע — הכל מסודר! ✨</p>'));
  vaccDue.forEach((v) => rem.appendChild(el(
    `<div class="list-item"><div class="avatar">💉</div><div class="grow">
      <div class="title">חיסון ${esc(v.vaccine_name)}${v.pet_name ? ' · ' + esc(v.pet_name) : ''}</div>
      <div class="meta">מועד מומלץ: ${fmtDate(v.next_due)}</div></div>
      <span class="badge high">חיסון מתקרב</span></div>`)));
  apptSoon.forEach((a) => rem.appendChild(el(
    `<div class="list-item"><div class="avatar">📅</div><div class="grow">
      <div class="title">${APPT_TYPES[a.type] || a.type}${a.pet_name ? ' · ' + esc(a.pet_name) : ''}</div>
      <div class="meta">${fmtDateTime(a.scheduled_at)}</div></div>
      <span class="badge ${a.status}">${APPT_STATUS[a.status]}</span></div>`)));

  const up = node.querySelector('#up');
  if (!upcoming.length) up.appendChild(el('<p class="muted">אין פגישות קרובות. אפשר לקבוע תור מהכרטיס למעלה.</p>'));
  upcoming.forEach((a) => up.appendChild(apptListItem(a)));
  setView(node);
}

/* ============================ Pets ============================ */
async function viewPets() {
  loadingView();
  const { pets } = await api('/pets');
  const isVet = State.user.role === 'vet';
  const node = el(`<div>
    <div class="page-head"><h2>${isVet ? 'מטופלים' : 'החיות שלי'}</h2>
      ${isVet ? '' : '<button class="btn" id="add">＋ הוספת חיה</button>'}</div>
    <div class="grid cols-2" id="list"></div></div>`);
  const list = node.querySelector('#list');
  if (!pets.length) list.appendChild(el(`<div class="empty"><span class="ico">🐾</span>אין חיות רשומות עדיין.</div>`));
  pets.forEach((p) => {
    const c = el(`<div class="card click">
      <div style="display:flex;gap:14px;align-items:center">
        <div class="avatar" style="width:54px;height:54px;font-size:28px">${SPECIES_ICON(p.species)}</div>
        <div><div class="title" style="font-size:18px;font-weight:700">${esc(p.name)}</div>
        <div class="meta">${esc(p.species)}${p.breed ? ' · ' + esc(p.breed) : ''}${ageFrom(p.birthdate) ? ' · ' + ageFrom(p.birthdate) : ''}</div>
        ${isVet && p.owner_name ? `<div class="meta">בעלים: ${esc(p.owner_name)} · ${esc(p.owner_phone || '')}</div>` : ''}</div>
      </div></div>`);
    c.onclick = () => openPetDetail(p.id);
    list.appendChild(c);
  });
  if (!isVet) node.querySelector('#add').onclick = () => petForm();
  setView(node);
}

function petForm(pet) {
  const f = el(`<form>
    <div class="field"><label>שם החיה *</label><input name="name" required value="${esc(pet?.name || '')}"></div>
    <div class="row">
      <div class="field"><label>סוג *</label><input name="species" required placeholder="כלב / חתול / ..." value="${esc(pet?.species || '')}"></div>
      <div class="field"><label>גזע</label><input name="breed" value="${esc(pet?.breed || '')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>מין</label><select name="sex">
        <option value="unknown">לא ידוע</option><option value="male">זכר</option><option value="female">נקבה</option></select></div>
      <div class="field"><label>תאריך לידה</label><input type="date" name="birthdate" value="${esc(pet?.birthdate || '')}"></div>
      <div class="field"><label>משקל (ק"ג)</label><input type="number" step="0.1" name="weight_kg" value="${esc(pet?.weight_kg || '')}"></div>
    </div>
    <div class="field"><label>הערות</label><textarea name="notes">${esc(pet?.notes || '')}</textarea></div>
  </form>`);
  if (pet) f.sex.value = pet.sex || 'unknown';
  const submit = el(`<button class="btn">${pet ? 'שמירה' : 'הוספה'}</button>`);
  const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal(pet ? 'עריכת פרטי חיה' : 'הוספת חיה', f, wrapBtns(submit, cancel));
  cancel.onclick = close;
  submit.onclick = async () => {
    const body = { name: f.name.value, species: f.species.value, breed: f.breed.value, sex: f.sex.value,
      birthdate: f.birthdate.value, weight_kg: f.weight_kg.value, notes: f.notes.value };
    if (!body.name || !body.species) return toast('שם וסוג הם שדות חובה', 'err');
    try { await api(pet ? `/pets/${pet.id}` : '/pets', { method: pet ? 'PUT' : 'POST', body });
      toast('נשמר בהצלחה', 'ok'); close(); viewPets(); } catch (e) { toast(e.message, 'err'); }
  };
}

async function openPetDetail(id) {
  const { pet, vaccinations, records, prescriptions = [], weights = [] } = await api(`/pets/${id}`);
  const isVet = State.user.role === 'vet';
  const latestWeight = weights.length ? weights[weights.length - 1].weight_kg : pet.weight_kg;
  const body = el(`<div>
    <div class="detail-row"><div class="k">סוג / גזע</div><div class="v">${esc(pet.species)}${pet.breed ? ' · ' + esc(pet.breed) : ''}</div></div>
    <div class="detail-row"><div class="k">מין</div><div class="v">${SEX[pet.sex] || '—'}</div></div>
    <div class="detail-row"><div class="k">גיל</div><div class="v">${ageFrom(pet.birthdate) || '—'}${pet.birthdate ? ' (' + fmtDate(pet.birthdate) + ')' : ''}</div></div>
    <div class="detail-row"><div class="k">משקל נוכחי</div><div class="v">${latestWeight ? latestWeight + ' ק"ג' : '—'}</div></div>
    <div class="detail-row"><div class="k">הערות</div><div class="v">${esc(pet.notes) || '—'}</div></div>

    <div class="section-title">⚖️ מעקב משקל ${isVet ? '<button class="btn sm" id="add-wt">＋</button>' : ''}</div>
    <div id="wt"></div>

    <div class="section-title">💊 מרשמים ותרופות ${isVet ? '<button class="btn sm" id="add-rx">＋</button>' : ''}</div>
    <div id="rx"></div>

    <div class="section-title">💉 חיסונים ${isVet ? '<button class="btn sm" id="add-vac">＋</button>' : ''}</div>
    <div id="vac"></div>

    <div class="section-title">📋 היסטוריה רפואית ${isVet ? '<button class="btn sm" id="add-rec">＋</button>' : ''}</div>
    <div id="rec"></div>
  </div>`);

  // Weight: mini chart + log
  const wt = body.querySelector('#wt');
  if (!weights.length) { wt.appendChild(el('<p class="muted">אין מדידות משקל.</p>')); }
  else {
    wt.appendChild(weightChart(weights));
    weights.slice().reverse().forEach((w) => { const item = el(
      `<div class="list-item"><div class="grow"><div class="title">${w.weight_kg} ק"ג</div>
        <div class="meta">${fmtDate(w.measured_at)}${w.notes ? ' · ' + esc(w.notes) : ''}</div></div></div>`);
      if (isVet) { const d = el('<button class="btn ghost sm">מחק</button>'); d.onclick = async () => {
        await api(`/weights/${w.id}`, { method: 'DELETE' }); close(); openPetDetail(id); }; item.appendChild(d); }
      wt.appendChild(item); });
  }

  // Prescriptions
  const rx = body.querySelector('#rx');
  if (!prescriptions.length) rx.appendChild(el('<p class="muted">אין מרשמים.</p>'));
  prescriptions.forEach((p) => { const item = el(
    `<div class="list-item"><div class="grow">
      <div class="title">${esc(p.medication)}${p.dosage ? ' · ' + esc(p.dosage) : ''}</div>
      <div class="meta">${p.instructions ? esc(p.instructions) + ' · ' : ''}החל מ-${fmtDate(p.start_date)}${p.end_date ? ' עד ' + fmtDate(p.end_date) : ''}</div></div>
      <span class="badge ${p.active ? 'confirmed' : 'cancelled'}">${p.active ? 'פעיל' : 'הופסק'}</span></div>`);
    if (isVet) { const t = el(`<button class="btn ghost sm">${p.active ? 'הפסק' : 'הפעל'}</button>`);
      t.onclick = async () => { await api(`/prescriptions/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); close(); openPetDetail(id); }; item.appendChild(t); }
    rx.appendChild(item); });

  const vac = body.querySelector('#vac');
  if (!vaccinations.length) vac.appendChild(el('<p class="muted">אין חיסונים רשומים.</p>'));
  vaccinations.forEach((v) => vac.appendChild(el(
    `<div class="list-item"><div class="grow"><div class="title">${esc(v.vaccine_name)}</div>
      <div class="meta">ניתן: ${fmtDate(v.date_given)}${v.next_due ? ' · הבא: ' + fmtDate(v.next_due) : ''}${v.notes ? ' · ' + esc(v.notes) : ''}</div></div></div>`)));
  const rec = body.querySelector('#rec');
  if (!records.length) rec.appendChild(el('<p class="muted">אין רשומות רפואיות.</p>'));
  records.forEach((r) => rec.appendChild(el(
    `<div class="list-item"><div class="grow"><div class="title">${fmtDate(r.visit_date)}${r.diagnosis ? ' · ' + esc(r.diagnosis) : ''}</div>
      <div class="meta">${r.treatment ? 'טיפול: ' + esc(r.treatment) : ''}${r.notes ? ' · ' + esc(r.notes) : ''}${r.vet_name ? ' · ' + esc(r.vet_name) : ''}</div></div></div>`)));

  let foot;
  if (!isVet) {
    const edit = el('<button class="btn ghost">עריכה</button>');
    const del = el('<button class="btn danger">מחיקה</button>');
    edit.onclick = () => { close(); petForm(pet); };
    del.onclick = async () => { if (!confirm('למחוק את ' + pet.name + '?')) return;
      await api(`/pets/${pet.id}`, { method: 'DELETE' }); toast('נמחק', 'ok'); close(); viewPets(); };
    foot = wrapBtns(edit, del);
  }
  const { close } = openModal(`${SPECIES_ICON(pet.species)} ${pet.name}`, body, foot);
  if (isVet) {
    body.querySelector('#add-vac').onclick = () => { close(); vaccinationForm(pet.id); };
    body.querySelector('#add-rec').onclick = () => { close(); recordForm(pet.id); };
    body.querySelector('#add-rx').onclick = () => { close(); prescriptionForm(pet.id); };
    body.querySelector('#add-wt').onclick = () => { close(); weightForm(pet.id); };
  }
}

// Simple inline SVG line chart of weight over time.
function weightChart(weights) {
  const w = 300, h = 90, pad = 8;
  const vals = weights.map((x) => Number(x.weight_kg));
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const n = weights.length;
  const xAt = (i) => n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1);
  const yAt = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = vals.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const dots = vals.map((v, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="3" fill="#0d9488"/>`).join('');
  return el(`<div class="card" style="padding:10px;margin-bottom:10px">
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:90px" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="#0d9488" stroke-width="2"/>${dots}
    </svg>
    <div class="meta" style="display:flex;justify-content:space-between">
      <span>${fmtDate(weights[0].measured_at)}</span>
      <span>טווח: ${min}–${max} ק"ג</span>
      <span>${fmtDate(weights[n - 1].measured_at)}</span></div></div>`);
}

function prescriptionForm(petId) {
  const f = el(`<form>
    <div class="field"><label>תרופה / מרשם *</label><input name="medication" required></div>
    <div class="row">
      <div class="field"><label>מינון</label><input name="dosage" placeholder='למשל: 1 כדור פעמיים ביום'></div>
      <div class="field"><label>הוראות</label><input name="instructions" placeholder="עם אוכל / לפני שינה..."></div>
    </div>
    <div class="row">
      <div class="field"><label>תאריך התחלה</label><input type="date" name="start_date" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="field"><label>תאריך סיום</label><input type="date" name="end_date"></div>
    </div></form>`);
  const submit = el('<button class="btn">שמירה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('הוספת מרשם', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => { if (!f.medication.value) return toast('שם התרופה הוא שדה חובה', 'err'); try {
    await api('/prescriptions', { method: 'POST', body: { pet_id: petId, medication: f.medication.value, dosage: f.dosage.value,
      instructions: f.instructions.value, start_date: f.start_date.value, end_date: f.end_date.value } });
    toast('נוסף מרשם', 'ok'); close(); openPetDetail(petId); } catch (e) { toast(e.message, 'err'); } };
}

function weightForm(petId) {
  const f = el(`<form>
    <div class="row">
      <div class="field"><label>משקל (ק"ג) *</label><input type="number" step="0.01" name="weight_kg" required></div>
      <div class="field"><label>תאריך</label><input type="date" name="measured_at" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="field"><label>הערות</label><input name="notes"></div></form>`);
  const submit = el('<button class="btn">שמירה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('הוספת מדידת משקל', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => { if (!f.weight_kg.value) return toast('נא להזין משקל', 'err'); try {
    await api('/weights', { method: 'POST', body: { pet_id: petId, weight_kg: f.weight_kg.value, measured_at: f.measured_at.value, notes: f.notes.value } });
    toast('המשקל נשמר', 'ok'); close(); openPetDetail(petId); } catch (e) { toast(e.message, 'err'); } };
}

function vaccinationForm(petId) {
  const f = el(`<form>
    <div class="field"><label>שם החיסון *</label><input name="vaccine_name" required></div>
    <div class="row">
      <div class="field"><label>תאריך מתן</label><input type="date" name="date_given" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="field"><label>מועד הבא</label><input type="date" name="next_due"></div>
    </div>
    <div class="field"><label>הערות</label><textarea name="notes"></textarea></div></form>`);
  const submit = el('<button class="btn">שמירה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('הוספת חיסון', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => { try {
    await api('/medical/vaccinations', { method: 'POST', body: { pet_id: petId, vaccine_name: f.vaccine_name.value,
      date_given: f.date_given.value, next_due: f.next_due.value, notes: f.notes.value } });
    toast('נוסף חיסון', 'ok'); close(); openPetDetail(petId); } catch (e) { toast(e.message, 'err'); } };
}

function recordForm(petId) {
  const f = el(`<form>
    <div class="field"><label>תאריך ביקור</label><input type="date" name="visit_date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>אבחנה</label><input name="diagnosis"></div>
    <div class="field"><label>טיפול</label><input name="treatment"></div>
    <div class="field"><label>הערות</label><textarea name="notes"></textarea></div></form>`);
  const submit = el('<button class="btn">שמירה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('הוספת רשומה רפואית', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => { try {
    await api('/medical/records', { method: 'POST', body: { pet_id: petId, visit_date: f.visit_date.value,
      diagnosis: f.diagnosis.value, treatment: f.treatment.value, notes: f.notes.value } });
    toast('נוספה רשומה', 'ok'); close(); openPetDetail(petId); } catch (e) { toast(e.message, 'err'); } };
}

/* ============================ Appointments ============================ */
let apptFilter = '';
async function viewAppointments() {
  loadingView();
  const isVet = State.user.role === 'vet';
  const { appointments } = await api('/appointments' + (isVet && apptFilter ? '?status=' + apptFilter : ''));
  const node = el(`<div>
    <div class="page-head"><h2>${isVet ? 'פגישות' : 'הפגישות שלי'}</h2>
      <button class="btn" id="add">＋ ${isVet ? 'פגישה חדשה' : 'בקשת תור'}</button></div>
    ${isVet ? '<div class="toolbar" id="filters"></div>' : ''}
    <div id="list"></div></div>`);
  if (isVet) {
    const filters = node.querySelector('#filters');
    [['', 'הכל'], ['requested', 'ממתין לאישור'], ['confirmed', 'מאושר'], ['completed', 'הושלם'], ['cancelled', 'בוטל']]
      .forEach(([v, l]) => { const c = el(`<button class="chip ${apptFilter === v ? 'active' : ''}">${l}</button>`);
        c.onclick = () => { apptFilter = v; viewAppointments(); }; filters.appendChild(c); });
  }
  const list = node.querySelector('#list');
  if (!appointments.length) list.appendChild(el(`<div class="empty"><span class="ico">📅</span>אין פגישות להצגה.</div>`));
  appointments.forEach((a) => list.appendChild(apptListItem(a, true)));
  node.querySelector('#add').onclick = () => apptForm();
  setView(node);
}

function apptListItem(a, clickable) {
  const item = el(`<div class="list-item${clickable ? ' click' : ''}">
    <div class="avatar">📅</div>
    <div class="grow">
      <div class="title">${APPT_TYPES[a.type] || a.type}${a.pet_name ? ' · ' + esc(a.pet_name) : ''}</div>
      <div class="meta">${fmtDateTime(a.scheduled_at)}${a.client_name && State.user.role === 'vet' ? ' · ' + esc(a.client_name) : ''}${a.reason ? ' · ' + esc(a.reason) : ''}</div>
    </div>
    <span class="badge ${a.status}">${APPT_STATUS[a.status]}</span>
  </div>`);
  if (clickable) { item.style.cursor = 'pointer'; item.onclick = () => apptDetail(a); }
  return item;
}

async function petOptions(selectedId) {
  const { pets } = await api('/pets');
  return pets.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)} (${esc(p.species)})${p.owner_name ? ' · ' + esc(p.owner_name) : ''}</option>`).join('');
}

async function apptForm() {
  const opts = await petOptions();
  const typeOpts = Object.entries(APPT_TYPES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const f = el(`<form>
    <div class="field"><label>חיה</label><select name="pet_id"><option value="">— ללא —</option>${opts}</select></div>
    <div class="field"><label>סוג הפגישה</label><select name="type">${typeOpts}</select></div>
    <div class="field"><label>תאריך ושעה מבוקשים *</label><input type="datetime-local" name="scheduled_at" required></div>
    <div class="field"><label>סיבת הפנייה</label><textarea name="reason" placeholder="תיאור קצר של הסיבה לתור"></textarea></div>
  </form>`);
  const submit = el('<button class="btn">שליחת בקשה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('בקשת תור', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => {
    if (!f.scheduled_at.value) return toast('נא לבחור תאריך ושעה', 'err');
    try { await api('/appointments', { method: 'POST', body: { pet_id: f.pet_id.value || null, type: f.type.value,
      scheduled_at: f.scheduled_at.value.replace('T', ' '), reason: f.reason.value } });
      toast(State.user.role === 'vet' ? 'הפגישה נקבעה' : 'הבקשה נשלחה! נחזור אליך לאישור', 'ok'); close(); viewAppointments(); }
    catch (e) { toast(e.message, 'err'); } };
}

async function apptDetail(a) {
  const isVet = State.user.role === 'vet';
  const body = el(`<div>
    <div class="detail-row"><div class="k">סטטוס</div><div class="v"><span class="badge ${a.status}">${APPT_STATUS[a.status]}</span></div></div>
    <div class="detail-row"><div class="k">סוג</div><div class="v">${APPT_TYPES[a.type] || a.type}</div></div>
    <div class="detail-row"><div class="k">מועד</div><div class="v">${fmtDateTime(a.scheduled_at)}</div></div>
    ${a.pet_name ? `<div class="detail-row"><div class="k">חיה</div><div class="v">${esc(a.pet_name)}</div></div>` : ''}
    ${isVet ? `<div class="detail-row"><div class="k">לקוח</div><div class="v">${esc(a.client_name)} · ${esc(a.client_phone || '')}</div></div>` : ''}
    <div class="detail-row"><div class="k">סיבה</div><div class="v">${esc(a.reason) || '—'}</div></div>
    ${a.vet_notes ? `<div class="detail-row"><div class="k">הערות הווטרינר</div><div class="v">${esc(a.vet_notes)}</div></div>` : ''}
    <div id="vetctl"></div>
  </div>`);

  const actions = [];
  if (isVet) {
    const ctl = body.querySelector('#vetctl');
    // Reminder log for this appointment (read-only)
    try {
      const { notifications } = await api(`/notifications?appointment_id=${a.id}`);
      if (notifications && notifications.length) {
        ctl.appendChild(el('<div class="section-title">🔔 תזכורות</div>'));
        notifications.forEach((nt) => ctl.appendChild(el(
          `<div class="list-item"><div class="grow"><div class="title">${NOTIF_TEMPLATE[nt.template] || nt.template}</div>
            <div class="meta">${nt.channel === 'email' ? 'אימייל' : esc(nt.channel)} · מתוזמן ל-${fmtDateTime(nt.send_at)}${nt.sent_at ? ' · נשלח ' + fmtDateTime(nt.sent_at) : ''}${nt.error ? ' · ' + esc(nt.error) : ''}</div></div>
            <span class="badge ${nt.status === 'sent' ? 'completed' : nt.status === 'failed' ? 'cancelled' : nt.status === 'cancelled' ? 'normal' : 'confirmed'}">${NOTIF_STATUS[nt.status] || nt.status}</span></div>`)));
      }
    } catch {}
    ctl.appendChild(el('<div class="section-title">ניהול פגישה</div>'));
    const statusSel = el(`<div class="field"><label>שינוי סטטוס</label><select>
      ${Object.entries(APPT_STATUS).map(([v, l]) => `<option value="${v}" ${v === a.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`);
    const reSched = el(`<div class="field"><label>קביעה מחדש</label><input type="datetime-local" value="${a.scheduled_at ? a.scheduled_at.replace(' ', 'T') : ''}"></div>`);
    const notes = el(`<div class="field"><label>הערות</label><textarea>${esc(a.vet_notes || '')}</textarea></div>`);
    ctl.append(statusSel, reSched, notes);
    const save = el('<button class="btn">שמירת שינויים</button>');
    save.onclick = async () => { try {
      await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: statusSel.querySelector('select').value,
        scheduled_at: reSched.querySelector('input').value.replace('T', ' '), vet_notes: notes.querySelector('textarea').value } });
      toast('עודכן', 'ok'); close(); viewAppointments(); } catch (e) { toast(e.message, 'err'); } };
    actions.push(save);
  } else if (a.status === 'requested' || a.status === 'confirmed') {
    const cancelAppt = el('<button class="btn danger">ביטול פגישה</button>');
    cancelAppt.onclick = async () => { if (!confirm('לבטל את הפגישה?')) return;
      await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
      toast('הפגישה בוטלה', 'ok'); close(); viewAppointments(); };
    actions.push(cancelAppt);
  }
  const closeBtn = el('<button class="btn ghost">סגירה</button>');
  actions.push(closeBtn);
  const { close } = openModal('פרטי פגישה', body, wrapBtns(...actions));
  closeBtn.onclick = close;
}

/* ============================ Inquiries (communication) ============================ */
let inqFilter = '';
async function viewInquiries() {
  loadingView();
  const isVet = State.user.role === 'vet';
  const { inquiries } = await api('/inquiries' + (isVet && inqFilter ? '?status=' + inqFilter : ''));
  const node = el(`<div>
    <div class="page-head"><h2>${isVet ? 'פניות לקוחות' : 'הפניות שלי'}</h2>
      ${isVet ? '' : '<button class="btn" id="add">＋ פנייה חדשה</button>'}</div>
    ${isVet ? '<div class="toolbar" id="filters"></div>' : ''}
    <div id="list"></div></div>`);
  if (isVet) {
    const filters = node.querySelector('#filters');
    [['', 'הכל'], ['open', 'פתוח'], ['in_progress', 'בטיפול'], ['resolved', 'נסגר']]
      .forEach(([v, l]) => { const c = el(`<button class="chip ${inqFilter === v ? 'active' : ''}">${l}</button>`);
        c.onclick = () => { inqFilter = v; viewInquiries(); }; filters.appendChild(c); });
  }
  const list = node.querySelector('#list');
  if (!inquiries.length) list.appendChild(el(`<div class="empty"><span class="ico">💬</span>אין פניות להצגה.</div>`));
  inquiries.forEach((i) => {
    const item = el(`<div class="list-item click">
      <div class="avatar">💬</div>
      <div class="grow"><div class="title">${esc(i.subject)}</div>
        <div class="meta">${isVet ? esc(i.client_name) + ' · ' : ''}${i.pet_name ? esc(i.pet_name) + ' · ' : ''}${i.message_count} הודעות · ${fmtDateTime(i.updated_at)}</div></div>
      <span class="badge ${i.priority}">${PRIORITY[i.priority]}</span>
      <span class="badge ${i.status}">${INQ_STATUS[i.status]}</span>
    </div>`);
    item.onclick = () => openInquiry(i.id);
    list.appendChild(item);
  });
  if (!isVet) node.querySelector('#add').onclick = () => inquiryForm();
  setView(node);
}

async function inquiryForm() {
  const opts = await petOptions();
  const f = el(`<form>
    <div class="field"><label>נושא *</label><input name="subject" required></div>
    <div class="row">
      <div class="field"><label>חיה רלוונטית</label><select name="pet_id"><option value="">— ללא —</option>${opts}</select></div>
      <div class="field"><label>דחיפות</label><select name="priority">
        <option value="normal">רגילה</option><option value="low">נמוכה</option><option value="high">גבוהה</option><option value="urgent">דחוף</option></select></div>
    </div>
    <div class="field"><label>תוכן ההודעה *</label><textarea name="body" required placeholder="תאר/י את השאלה או הבעיה..."></textarea></div>
  </form>`);
  const submit = el('<button class="btn">שליחה</button>'); const cancel = el('<button class="btn ghost">ביטול</button>');
  const { close } = openModal('פנייה חדשה לווטרינר', f, wrapBtns(submit, cancel)); cancel.onclick = close;
  submit.onclick = async () => {
    if (!f.subject.value || !f.body.value) return toast('נושא ותוכן הם שדות חובה', 'err');
    try { const { inquiry } = await api('/inquiries', { method: 'POST', body: { subject: f.subject.value,
      body: f.body.value, pet_id: f.pet_id.value || null, priority: f.priority.value } });
      toast('הפנייה נשלחה', 'ok'); close(); openInquiry(inquiry.id); } catch (e) { toast(e.message, 'err'); } };
}

async function openInquiry(id) {
  const { inquiry, messages } = await api(`/inquiries/${id}`);
  const isVet = State.user.role === 'vet';
  const body = el(`<div>
    <div class="mb" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="badge ${inquiry.status}">${INQ_STATUS[inquiry.status]}</span>
      <span class="badge ${inquiry.priority}">דחיפות: ${PRIORITY[inquiry.priority]}</span>
      ${inquiry.pet_name ? `<span class="muted">🐾 ${esc(inquiry.pet_name)}</span>` : ''}
      ${isVet ? `<span class="muted">· ${esc(inquiry.client_name)}</span>` : ''}
    </div>
    <div class="thread" id="thread"></div>
    <div class="reply-box"><textarea id="reply" placeholder="כתוב/כתבי תשובה..."></textarea><button class="btn" id="send">שליחה</button></div>
    ${isVet ? '<div id="vetctl"></div>' : ''}
  </div>`);
  const thread = body.querySelector('#thread');
  const renderMsgs = (msgs) => { thread.innerHTML = ''; msgs.forEach((m) => {
    const mine = m.sender_id === State.user.id;
    thread.appendChild(el(`<div class="msg ${mine ? 'mine' : 'theirs'}">
      <div class="who">${esc(m.sender_name)}${m.sender_role === 'vet' ? ' (וטרינר)' : ''}</div>
      <div>${esc(m.body).replace(/\n/g, '<br>')}</div>
      <div class="when">${fmtDateTime(m.created_at)}</div></div>`));
    });
    thread.scrollTop = thread.scrollHeight; };
  renderMsgs(messages);

  body.querySelector('#send').onclick = async () => {
    const ta = body.querySelector('#reply'); const text = ta.value.trim();
    if (!text) return; try {
      await api(`/inquiries/${id}/messages`, { method: 'POST', body: { body: text } });
      ta.value = ''; const { messages: m } = await api(`/inquiries/${id}`); renderMsgs(m);
      setTimeout(() => thread.scrollTop = thread.scrollHeight, 50); } catch (e) { toast(e.message, 'err'); } };

  if (isVet) {
    const ctl = body.querySelector('#vetctl');
    ctl.appendChild(el('<div class="section-title">ניהול פנייה</div>'));
    const sel = el(`<div class="row"><div class="field"><label>סטטוס</label><select id="st">
      ${Object.entries(INQ_STATUS).map(([v, l]) => `<option value="${v}" ${v === inquiry.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>דחיפות</label><select id="pr">
      ${Object.entries(PRIORITY).map(([v, l]) => `<option value="${v}" ${v === inquiry.priority ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>`);
    ctl.appendChild(sel);
    const save = el('<button class="btn ghost sm">עדכון סטטוס</button>');
    save.onclick = async () => { try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: { status: sel.querySelector('#st').value, priority: sel.querySelector('#pr').value } });
      toast('עודכן', 'ok'); } catch (e) { toast(e.message, 'err'); } };
    ctl.appendChild(save);
  }

  // Live updates: refresh the thread when a new message lands in this inquiry.
  const channel = sb.channel('inq-' + id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `inquiry_id=eq.${id}` },
      async () => { try { const { messages: m } = await api(`/inquiries/${id}`); renderMsgs(m); setTimeout(() => thread.scrollTop = thread.scrollHeight, 30); } catch {} })
    .subscribe();

  openModal(inquiry.subject, body, null, () => sb.removeChannel(channel));
  body.querySelector('#reply').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) body.querySelector('#send').click(); });
}

/* ============================ Clients (vet only) ============================ */
async function viewClients() {
  loadingView();
  const { clients } = await api('/admin/clients');
  const node = el(`<div><div class="page-head"><h2>לקוחות</h2></div><div id="list"></div></div>`);
  const list = node.querySelector('#list');
  if (!clients.length) list.appendChild(el(`<div class="empty"><span class="ico">👥</span>אין לקוחות רשומים.</div>`));
  clients.forEach((c) => list.appendChild(el(
    `<div class="list-item"><div class="avatar">👤</div>
      <div class="grow"><div class="title">${esc(c.name)}</div>
        <div class="meta">${esc(c.email)}${c.phone ? ' · ' + esc(c.phone) : ''} · ${c.pet_count} חיות</div></div>
      <span class="muted">מאז ${fmtDate(c.created_at)}</span></div>`)));
  setView(node);
}

/* ============================ Tasks (vet only) ============================ */
let taskFilter = 'open';
async function viewTasks() {
  loadingView();
  const { tasks } = await api('/tasks' + (taskFilter ? '?status=' + taskFilter : ''));
  const node = el(`<div>
    <div class="page-head"><h2>משימות</h2><button class="btn" id="add">＋ משימה חדשה</button></div>
    <div class="toolbar" id="filters"></div>
    <div id="list"></div></div>`);
  const filters = node.querySelector('#filters');
  [['open', 'פתוחות'], ['done', 'הושלמו'], ['', 'הכל']].forEach(([v, l]) => {
    const c = el(`<button class="chip ${taskFilter === v ? 'active' : ''}">${l}</button>`);
    c.onclick = () => { taskFilter = v; viewTasks(); }; filters.appendChild(c);
  });
  const list = node.querySelector('#list');
  if (!tasks.length) list.appendChild(el(`<div class="empty"><span class="ico">✅</span>אין משימות להצגה.</div>`));
  tasks.forEach((t) => {
    const done = t.status === 'done';
    const item = el(`<div class="list-item">
      <div class="avatar">${done ? '✅' : '⬜'}</div>
      <div class="grow"><div class="title" style="${done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(t.title)}</div>
        <div class="meta">${t.due_date ? 'יעד: ' + fmtDate(t.due_date) : ''}${t.client_name ? ' · ' + esc(t.client_name) : ''}${t.pet_name ? ' · ' + esc(t.pet_name) : ''}${t.notes ? ' · ' + esc(t.notes) : ''}</div></div>
      <span class="badge ${t.priority}">${PRIORITY[t.priority]}</span></div>`);
    const toggle = el(`<button class="btn ${done ? 'ghost' : ''} sm">${done ? 'החזר' : 'סיום'}</button>`);
    toggle.onclick = async (e) => { e.stopPropagation(); await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: done ? 'open' : 'done' } }); viewTasks(); refreshBadges(); };
    item.appendChild(toggle);
    item.style.cursor = 'pointer';
    item.onclick = () => taskForm(t);
    list.appendChild(item);
  });
  node.querySelector('#add').onclick = () => taskForm();
  setView(node);
}

async function taskForm(task) {
  const [pets, { clients }] = await Promise.all([
    api('/pets').then((r) => r.pets), api('/admin/clients')]);
  const petOpts = pets.map((p) => `<option value="${p.id}" ${task && p.id === task.pet_id ? 'selected' : ''}>${esc(p.name)}${p.owner_name ? ' · ' + esc(p.owner_name) : ''}</option>`).join('');
  const clientOpts = clients.map((c) => `<option value="${c.id}" ${task && c.id === task.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const f = el(`<form>
    <div class="field"><label>כותרת המשימה *</label><input name="title" required value="${esc(task?.title || '')}"></div>
    <div class="row">
      <div class="field"><label>תאריך יעד</label><input type="date" name="due_date" value="${esc(task?.due_date || '')}"></div>
      <div class="field"><label>דחיפות</label><select name="priority">
        ${Object.entries(PRIORITY).map(([v, l]) => `<option value="${v}" ${(task?.priority || 'normal') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>לקוח קשור</label><select name="client_id"><option value="">— ללא —</option>${clientOpts}</select></div>
      <div class="field"><label>חיה קשורה</label><select name="pet_id"><option value="">— ללא —</option>${petOpts}</select></div>
    </div>
    <div class="field"><label>הערות</label><textarea name="notes">${esc(task?.notes || '')}</textarea></div>
  </form>`);
  const submit = el(`<button class="btn">${task ? 'שמירה' : 'הוספה'}</button>`);
  const cancel = el('<button class="btn ghost">ביטול</button>');
  const btns = [submit, cancel];
  if (task) { const del = el('<button class="btn danger">מחיקה</button>');
    del.onclick = async () => { if (!confirm('למחוק את המשימה?')) return; await api(`/tasks/${task.id}`, { method: 'DELETE' }); toast('נמחק', 'ok'); close(); viewTasks(); refreshBadges(); };
    btns.push(del); }
  const { close } = openModal(task ? 'עריכת משימה' : 'משימה חדשה', f, wrapBtns(...btns));
  cancel.onclick = close;
  submit.onclick = async () => {
    if (!f.title.value) return toast('כותרת היא שדה חובה', 'err');
    const body = { title: f.title.value, due_date: f.due_date.value, priority: f.priority.value,
      client_id: f.client_id.value || null, pet_id: f.pet_id.value || null, notes: f.notes.value };
    try { await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PATCH' : 'POST', body });
      toast('נשמר', 'ok'); close(); viewTasks(); refreshBadges(); } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============================ Clinic info / settings ============================ */
async function viewClinic() {
  loadingView();
  const { clinic } = await api('/clinic');
  const isVet = State.user.role === 'vet';
  if (isVet) {
    const f = el(`<div class="card" style="max-width:600px">
      <div class="field"><label>שם המרפאה</label><input id="clinic_name" value="${esc(clinic.clinic_name || '')}"></div>
      <div class="row">
        <div class="field"><label>טלפון</label><input id="phone" value="${esc(clinic.phone || '')}"></div>
        <div class="field"><label>כתובת</label><input id="address" value="${esc(clinic.address || '')}"></div>
      </div>
      <div class="field"><label>שעות פעילות</label><textarea id="hours" placeholder="א'-ה' 09:00-19:00&#10;ו' 09:00-13:00">${esc(clinic.hours || '')}</textarea></div>
      <div class="field"><label>מידע לשעת חירום</label><textarea id="emergency_info" placeholder="טלפון חירום, מרפאה תורנית...">${esc(clinic.emergency_info || '')}</textarea></div>
      <button class="btn" id="save">שמירת פרטי המרפאה</button>
    </div>`);
    const node = el(`<div><div class="page-head"><h2>פרטי המרפאה</h2></div></div>`);
    node.appendChild(f);
    f.querySelector('#save').onclick = async () => { try {
      await api('/clinic', { method: 'PUT', body: { clinic_name: f.querySelector('#clinic_name').value, phone: f.querySelector('#phone').value,
        address: f.querySelector('#address').value, hours: f.querySelector('#hours').value, emergency_info: f.querySelector('#emergency_info').value } });
      toast('פרטי המרפאה נשמרו', 'ok'); } catch (e) { toast(e.message, 'err'); } };
    setView(node);
  } else {
    const empty = !clinic.clinic_name && !clinic.phone && !clinic.address && !clinic.hours;
    const node = el(`<div><div class="page-head"><h2>${esc(clinic.clinic_name || 'המרפאה')}</h2></div>
      ${empty ? '<p class="muted">פרטי המרפאה טרם הוזנו.</p>' : `<div class="card" style="max-width:600px">
        ${clinic.phone ? `<div class="detail-row"><div class="k">📞 טלפון</div><div class="v"><a href="tel:${esc(clinic.phone)}">${esc(clinic.phone)}</a></div></div>` : ''}
        ${clinic.address ? `<div class="detail-row"><div class="k">📍 כתובת</div><div class="v">${esc(clinic.address)}</div></div>` : ''}
        ${clinic.hours ? `<div class="detail-row"><div class="k">🕐 שעות</div><div class="v" style="white-space:pre-line">${esc(clinic.hours)}</div></div>` : ''}
        ${clinic.emergency_info ? `<div class="detail-row"><div class="k">🚨 חירום</div><div class="v" style="white-space:pre-line">${esc(clinic.emergency_info)}</div></div>` : ''}
      </div>`}</div>`);
    setView(node);
  }
}

/* ============================ small utils ============================ */
function wrapBtns(...btns) { const d = document.createElement('div'); d.style.display = 'flex'; d.style.gap = '10px'; btns.forEach((b) => d.appendChild(b)); return d; }
