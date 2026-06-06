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
    // Run all five reads in parallel (one round-trip instead of five).
    const [pet, vaccinations, recs, prescriptions, weights] = await Promise.all([
      sb.from('pets').select('*').eq('id', s[1]).single().then(must),
      sb.from('vaccinations').select('*').eq('pet_id', s[1]).order('date_given', { ascending: false }).then(must),
      sb.from('medical_records').select('*, vet:profiles!vet_id(name)').eq('pet_id', s[1]).order('visit_date', { ascending: false }).then(must),
      sb.from('prescriptions').select('*').eq('pet_id', s[1]).order('active', { ascending: false }).order('start_date', { ascending: false }).then(must),
      sb.from('weight_logs').select('*').eq('pet_id', s[1]).order('measured_at', { ascending: true }).then(must),
    ]);
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
    const [i, msgs] = await Promise.all([
      sb.from('inquiries').select('*, client:profiles!client_id(name), pet:pets(name), messages(count)').eq('id', s[1]).single().then(must),
      sb.from('messages').select('*, sender:profiles!sender_id(name,role)').eq('inquiry_id', s[1]).order('created_at', { ascending: true }).then(must),
    ]);
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
    const [appts, vaccs] = await Promise.all([
      sb.from('appointments').select('*, pet:pets(name)')
        .gte('scheduled_at', todayIso).in('status', ['requested', 'confirmed']).order('scheduled_at', { ascending: true }).then(must),
      sb.from('vaccinations').select('*, pet:pets(name)')
        .gte('next_due', todayStr).lte('next_due', in60.toISOString().slice(0, 10)).order('next_due', { ascending: true }).then(must),
    ]);
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

/* ============================================================================
   AmitVet Care — mobile UI layer (vanilla JS) over the Supabase data layer.
   Clean clinical design: medical blue/teal, bottom tabs, sheets, Lucide,
   bilingual HE/EN. All data still flows through api() above.
   ============================================================================ */

/* ===================== i18n ===================== */
(function () {
  const DICT = {
    he: {
      appName: 'אמית-וט', appTag: 'וטרינר עד הבית',
      login: 'התחברות', signup: 'הרשמה', email: 'אימייל', password: 'סיסמה',
      fullName: 'שם מלא', phone: 'טלפון', enter: 'כניסה', createAccount: 'יצירת חשבון',
      welcome: 'שלום', welcomeBack: 'טוב לראותך שוב',
      home: 'בית', dashboard: 'לוח בקרה', myPets: 'החיות שלי', pets: 'מטופלים',
      appts: 'תורים', myAppts: 'התורים שלי', inquiries: 'פניות', messages: 'הודעות',
      tasks: 'משימות', clients: 'לקוחות', clinic: 'המרפאה', more: 'עוד',
      pendingAppts: 'בקשות תור', openInquiries: 'פניות פתוחות', openTasks: 'משימות פתוחות',
      totalClients: 'לקוחות', totalPets: 'מטופלים', todayAppts: 'התורים של היום',
      upcomingVacc: 'חיסונים מתקרבים', reminders: 'תזכורות', quickActions: 'פעולות מהירות',
      bookAppt: 'קביעת תור', newInquiry: 'פנייה לווטרינר', addPet: 'הוספת חיה',
      upcomingAppts: 'התורים הקרובים', allGood: 'הכל מסודר — אין תזכורות כרגע', noToday: 'אין תורים להיום',
      registered: 'רשומות', recommendedBy: 'מומלץ עד',
      addNewPet: 'הוספת חיה', petName: 'שם החיה', species: 'סוג', breed: 'גזע',
      sex: 'מין', birthdate: 'תאריך לידה', weight: 'משקל', notes: 'הערות',
      age: 'גיל', currentWeight: 'משקל נוכחי', owner: 'בעלים', noPets: 'אין חיות רשומות',
      noPetsSub: 'הוסיפו את החיה הראשונה כדי להתחיל',
      weightTrack: 'מעקב משקל', prescriptions: 'תרופות ומרשמים', vaccinations: 'חיסונים',
      medHistory: 'היסטוריה רפואית', noWeights: 'אין מדידות משקל', noRx: 'אין מרשמים פעילים',
      noVacc: 'אין חיסונים רשומים', noRecords: 'אין רשומות רפואיות',
      given: 'ניתן', next: 'הבא', range: 'טווח', medication: 'תרופה', dosage: 'מינון',
      instructions: 'הוראות', startDate: 'תאריך התחלה', endDate: 'תאריך סיום',
      diagnosis: 'אבחנה', treatment: 'טיפול', visitDate: 'תאריך ביקור', vaccineName: 'שם החיסון',
      dateGiven: 'תאריך מתן', nextDue: 'מועד הבא', active: 'פעיל', stopped: 'הופסק',
      stop: 'הפסקה', activate: 'הפעלה', addWeight: 'הוספת משקל', addRx: 'הוספת מרשם',
      addVacc: 'הוספת חיסון', addRecord: 'רשומה רפואית',
      requestAppt: 'בקשת תור', newAppt: 'תור חדש', apptType: 'סוג הביקור',
      whichPet: 'איזו חיה', dateTime: 'תאריך ושעה', reason: 'סיבת הפנייה',
      reasonPh: 'תיאור קצר של הסיבה לתור', sendRequest: 'שליחת בקשה',
      noAppts: 'אין תורים להצגה', noApptsSub: 'קבעו תור חדש בלחיצה אחת',
      status: 'סטטוס', manageAppt: 'ניהול התור', changeStatus: 'שינוי סטטוס',
      reschedule: 'קביעה מחדש', vetNotes: 'הערות הווטרינר', saveChanges: 'שמירת שינויים',
      cancelAppt: 'ביטול התור', confirm: 'אישור', decline: 'דחייה', approve: 'אישור התור',
      apptDetails: 'פרטי התור', requestSent: 'הבקשה נשלחה — נחזור אליך לאישור', remindersLog: 'תזכורות',
      newInquiryFull: 'פנייה חדשה', subject: 'נושא', relatedPet: 'חיה רלוונטית',
      priority: 'דחיפות', messageBody: 'תוכן ההודעה', messagePh: 'תאר/י את השאלה או הבעיה...',
      send: 'שליחה', noInq: 'אין פניות', noInqSub: 'יש שאלה? כתבו לנו ונחזור אליכם',
      replyPh: 'כתוב/כתבי תשובה...', manageInq: 'ניהול הפנייה', msgsCount: 'הודעות',
      newTask: 'משימה חדשה', taskTitle: 'כותרת המשימה', dueDate: 'תאריך יעד',
      relatedClient: 'לקוח קשור', noTasks: 'אין משימות', noTasksSub: 'הכל בוצע — כל הכבוד',
      done: 'סיום', reopen: 'החזרה', complete: 'הושלמה', markDone: 'סימון כבוצע',
      noClients: 'אין לקוחות', since: 'לקוח/ה מאז', petsCount: 'חיות',
      clinicName: 'שם המרפאה', address: 'כתובת', hours: 'שעות פעילות',
      emergency: 'מידע לשעת חירום', callClinic: 'התקשרות למרפאה', navigate: 'ניווט',
      saveClinic: 'שמירת פרטי המרפאה', clinicInfo: 'פרטי המרפאה', clinicEmpty: 'פרטי המרפאה טרם הוזנו',
      save: 'שמירה', add: 'הוספה', cancel: 'ביטול', edit: 'עריכה', del: 'מחיקה',
      close: 'סגירה', back: 'חזרה', all: 'הכל', logout: 'יציאה', settings: 'הגדרות',
      saved: 'נשמר בהצלחה', deleted: 'נמחק', updated: 'עודכן', required: 'שדה חובה',
      vetTitle: 'וטרינר/ית', clientTitle: 'בעל/ת חיה', kg: 'ק"ג', viewAll: 'הצג הכל',
      confirmDelete: 'האם למחוק?', language: 'שפה', theme: 'צבע ראשי', loginHint: 'התחברות לדוגמה: admin@amitvet.local',
    },
    en: {
      appName: 'AmitVet', appTag: 'House-call vet',
      login: 'Log in', signup: 'Sign up', email: 'Email', password: 'Password',
      fullName: 'Full name', phone: 'Phone', enter: 'Enter', createAccount: 'Create account',
      welcome: 'Hello', welcomeBack: 'Good to see you again',
      home: 'Home', dashboard: 'Dashboard', myPets: 'My Pets', pets: 'Patients',
      appts: 'Visits', myAppts: 'Appointments', inquiries: 'Inquiries', messages: 'Messages',
      tasks: 'Tasks', clients: 'Clients', clinic: 'Clinic', more: 'More',
      pendingAppts: 'Pending requests', openInquiries: 'Open inquiries', openTasks: 'Open tasks',
      totalClients: 'Clients', totalPets: 'Patients', todayAppts: "Today's appointments",
      upcomingVacc: 'Upcoming vaccines', reminders: 'Reminders', quickActions: 'Quick actions',
      bookAppt: 'Book a visit', newInquiry: 'Ask the vet', addPet: 'Add a pet',
      upcomingAppts: 'Upcoming visits', allGood: 'All set — no reminders right now', noToday: 'No visits today',
      registered: 'registered', recommendedBy: 'recommended by',
      addNewPet: 'Add a pet', petName: 'Pet name', species: 'Species', breed: 'Breed',
      sex: 'Sex', birthdate: 'Date of birth', weight: 'Weight', notes: 'Notes',
      age: 'Age', currentWeight: 'Current weight', owner: 'Owner', noPets: 'No pets yet',
      noPetsSub: 'Add your first pet to get started',
      weightTrack: 'Weight tracking', prescriptions: 'Prescriptions', vaccinations: 'Vaccinations',
      medHistory: 'Medical history', noWeights: 'No weight measurements', noRx: 'No active prescriptions',
      noVacc: 'No vaccinations recorded', noRecords: 'No medical records',
      given: 'Given', next: 'Next', range: 'Range', medication: 'Medication', dosage: 'Dosage',
      instructions: 'Instructions', startDate: 'Start date', endDate: 'End date',
      diagnosis: 'Diagnosis', treatment: 'Treatment', visitDate: 'Visit date', vaccineName: 'Vaccine name',
      dateGiven: 'Date given', nextDue: 'Next due', active: 'Active', stopped: 'Stopped',
      stop: 'Stop', activate: 'Activate', addWeight: 'Add weight', addRx: 'Add prescription',
      addVacc: 'Add vaccination', addRecord: 'Medical record',
      requestAppt: 'Request a visit', newAppt: 'New appointment', apptType: 'Visit type',
      whichPet: 'Which pet', dateTime: 'Date & time', reason: 'Reason',
      reasonPh: 'A short description of the reason', sendRequest: 'Send request',
      noAppts: 'No appointments', noApptsSub: 'Book a new visit in one tap',
      status: 'Status', manageAppt: 'Manage appointment', changeStatus: 'Change status',
      reschedule: 'Reschedule', vetNotes: 'Vet notes', saveChanges: 'Save changes',
      cancelAppt: 'Cancel visit', confirm: 'Confirm', decline: 'Decline', approve: 'Approve',
      apptDetails: 'Appointment details', requestSent: "Request sent — we'll confirm shortly", remindersLog: 'Reminders',
      newInquiryFull: 'New inquiry', subject: 'Subject', relatedPet: 'Related pet',
      priority: 'Priority', messageBody: 'Message', messagePh: 'Describe your question or concern...',
      send: 'Send', noInq: 'No inquiries', noInqSub: 'Have a question? Message us anytime',
      replyPh: 'Write a reply...', manageInq: 'Manage inquiry', msgsCount: 'messages',
      newTask: 'New task', taskTitle: 'Task title', dueDate: 'Due date',
      relatedClient: 'Related client', noTasks: 'No tasks', noTasksSub: 'All done — nice work',
      done: 'Done', reopen: 'Reopen', complete: 'Completed', markDone: 'Mark as done',
      noClients: 'No clients', since: 'Client since', petsCount: 'pets',
      clinicName: 'Clinic name', address: 'Address', hours: 'Opening hours',
      emergency: 'Emergency info', callClinic: 'Call clinic', navigate: 'Directions',
      saveClinic: 'Save clinic details', clinicInfo: 'Clinic info', clinicEmpty: 'Clinic details not set yet',
      save: 'Save', add: 'Add', cancel: 'Cancel', edit: 'Edit', del: 'Delete',
      close: 'Close', back: 'Back', all: 'All', logout: 'Log out', settings: 'Settings',
      saved: 'Saved', deleted: 'Deleted', updated: 'Updated', required: 'Required field',
      vetTitle: 'Veterinarian', clientTitle: 'Pet owner', kg: 'kg', viewAll: 'View all',
      confirmDelete: 'Delete this?', language: 'Language', theme: 'Primary color', loginHint: 'Demo login: admin@amitvet.local',
    },
  };
  const saved = (() => { try { return localStorage.getItem('amitvet_lang'); } catch { return null; } })();
  const I18N = {
    lang: saved === 'en' ? 'en' : 'he',
    setLang(l) { I18N.lang = l; try { localStorage.setItem('amitvet_lang', l); } catch {} },
    dir() { return I18N.lang === 'he' ? 'rtl' : 'ltr'; },
    locale() { return I18N.lang === 'he' ? 'he-IL' : 'en-GB'; },
  };
  window.I18N = I18N;
  window.t = (k) => { const d = DICT[I18N.lang] || DICT.he; return d[k] != null ? d[k] : (DICT.he[k] != null ? DICT.he[k] : k); };
  window.tt = (o) => !o ? '' : (o[I18N.lang] != null ? o[I18N.lang] : (o.he || o.en || ''));
  const parse = (s) => new Date(String(s).replace(' ', 'T'));
  window.fmtDate = (s) => { if (!s) return '—'; const d = parse(s); return isNaN(d) ? '—' : d.toLocaleDateString(I18N.locale(), { day: '2-digit', month: 'short', year: 'numeric' }); };
  window.fmtDateShort = (s) => { if (!s) return '—'; const d = parse(s); return isNaN(d) ? '—' : d.toLocaleDateString(I18N.locale(), { day: '2-digit', month: 'short' }); };
  window.fmtTime = (s) => { if (!s) return ''; const d = parse(s); return isNaN(d) ? '' : d.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' }); };
  window.fmtDateTime = (s) => !s ? '—' : window.fmtDate(s) + ' · ' + window.fmtTime(s);
  window.relDay = (s) => { if (!s) return ''; const d = parse(s); const t0 = new Date(); t0.setHours(0,0,0,0); const dd = new Date(d); dd.setHours(0,0,0,0); const diff = Math.round((dd - t0) / 86400000); const he = {'0':'היום','1':'מחר','-1':'אתמול'}, en = {'0':'Today','1':'Tomorrow','-1':'Yesterday'}; const m = I18N.lang === 'he' ? he : en; return m[String(diff)] != null ? m[String(diff)] : window.fmtDateShort(s); };
  window.ageFrom = (b) => { if (!b) return null; const bd = new Date(b), now = new Date(); let y = now.getFullYear()-bd.getFullYear(), m = now.getMonth()-bd.getMonth(); if (m<0){y--;m+=12;} if (I18N.lang==='he') return y>0 ? y+(y===1?' שנה':' שנים') : m+' חודשים'; return y>0 ? y+(y===1?' yr':' yrs') : m+' mo'; };
})();
const T = window.t, TT = window.tt;

/* ===================== theme engine (in-app primary color) ===================== */
const THEMES = {
  navy: { label: { he: 'נייבי', en: 'Navy' }, swatch: '#21476d', vars: { '--blue': '#21476d', '--blue-600': '#21476d', '--blue-700': '#18395a', '--blue-500': '#2f5e8a', '--blue-ink': '#16324e', '--blue-soft': '#e2eaf2', '--blue-soft-2': '#cfdcea', '--sh-blue': '0 6px 16px -4px rgba(33,71,109,.36)' } },
  teal: { label: { he: 'טורקיז', en: 'Teal' }, swatch: '#2f9489', vars: { '--blue': '#2f9489', '--blue-600': '#2f9489', '--blue-700': '#237a70', '--blue-500': '#36a597', '--blue-ink': '#1c6b62', '--blue-soft': '#dcefec', '--blue-soft-2': '#c6e6e1', '--sh-blue': '0 6px 16px -4px rgba(54,165,151,.4)' } },
  green: { label: { he: 'ירוק זית', en: 'Olive' }, swatch: '#6c8a33', vars: { '--blue': '#6c8a33', '--blue-600': '#6c8a33', '--blue-700': '#5a7429', '--blue-500': '#86a64a', '--blue-ink': '#49611f', '--blue-soft': '#ecf1df', '--blue-soft-2': '#dde8c7', '--sh-blue': '0 6px 16px -4px rgba(121,153,60,.42)' } },
  sky: { label: { he: 'תכלת', en: 'Sky' }, swatch: '#1773c4', vars: { '--blue': '#1773c4', '--blue-600': '#1773c4', '--blue-700': '#115e9f', '--blue-500': '#2e8ad6', '--blue-ink': '#0c4f88', '--blue-soft': '#e3eef9', '--blue-soft-2': '#d2e4f5', '--sh-blue': '0 6px 16px -4px rgba(23,115,196,.42)' } },
  plum: { label: { he: 'סגול', en: 'Plum' }, swatch: '#7b4a86', vars: { '--blue': '#7b4a86', '--blue-600': '#7b4a86', '--blue-700': '#633a6d', '--blue-500': '#9466a0', '--blue-ink': '#4f2e58', '--blue-soft': '#efe6f2', '--blue-soft-2': '#e2d2e8', '--sh-blue': '0 6px 16px -4px rgba(123,74,134,.4)' } },
};
function applyTheme(key) {
  const th = THEMES[key] || THEMES.navy;
  const root = document.documentElement;
  Object.entries(th.vars).forEach(([k, v]) => root.style.setProperty(k, v));
  try { localStorage.setItem('amitvet-theme', key); } catch {}
}
function currentTheme() { let s = null; try { s = localStorage.getItem('amitvet-theme'); } catch {} return s && THEMES[s] ? s : 'navy'; }

/* ===================== brand logo (wordmark + roofline & dog) ===================== */
function logoHtml(size = 1, sub, light) {
  const navy = light ? '#ffffff' : '#21476d', teal = light ? '#bdeae3' : '#36a597', fs = 30 * size;
  return `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:${3 * size}px" dir="ltr">
    <div style="position:relative;display:inline-flex;align-items:baseline;line-height:1">
      <svg viewBox="0 0 140 52" style="position:absolute;bottom:${fs * 0.74}px;left:50%;transform:translateX(-50%);width:${92 * size}px;height:auto;overflow:visible">
        <path d="M12 46 L70 13 L128 46" fill="none" stroke="${navy}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
        <ellipse cx="62.5" cy="12" rx="3.6" ry="6.4" transform="rotate(-22 62.5 12)" fill="${teal}"/>
        <ellipse cx="77.5" cy="12" rx="3.6" ry="6.4" transform="rotate(22 77.5 12)" fill="${teal}"/>
        <circle cx="70" cy="16.5" r="8.4" fill="${teal}"/>
        <circle cx="66.7" cy="15.2" r="1.25" fill="#fff"/><circle cx="73.3" cy="15.2" r="1.25" fill="#fff"/>
        <ellipse cx="70" cy="20" rx="2.3" ry="1.7" fill="${navy}"/>
      </svg>
      <span style="font-family:var(--font-display);font-weight:700;font-size:${fs}px;letter-spacing:-.02em;color:${navy}">Amit</span>
      <span style="font-family:var(--font-display);font-weight:700;font-size:${fs}px;letter-spacing:-.02em;color:${teal}">Vet</span>
    </div>
    ${sub ? `<span style="font-size:${13.5 * size}px;color:${navy};font-weight:700;letter-spacing:-.01em;margin-top:1px;white-space:nowrap">${esc(sub)}</span>` : ''}
  </div>`;
}
function oliveBranch(style, flip) {
  let leaves = '';
  for (let i = 0; i < 6; i++) { const y = 14 + i * 15;
    leaves += `<ellipse cx="26" cy="${y}" rx="13" ry="6" transform="rotate(-32 26 ${y})" fill="#8aa84e" opacity=".85"/>`;
    leaves += `<ellipse cx="46" cy="${y + 6}" rx="13" ry="6" transform="rotate(32 46 ${y + 6})" fill="#79993c" opacity=".85"/>`;
  }
  return `<svg viewBox="0 0 72 120" style="${style}" aria-hidden="true"><g transform="${flip ? 'scale(-1,1) translate(-72,0)' : ''}"><path d="M36 6 Q34 60 36 116" stroke="#6c8a33" stroke-width="2.4" fill="none" stroke-linecap="round"/>${leaves}</g></svg>`;
}

/* ===================== label dictionaries ===================== */
const APPT_TYPES = {
  checkup: { he: 'בדיקה כללית', en: 'Check-up', icon: 'stethoscope' },
  vaccination: { he: 'חיסון', en: 'Vaccination', icon: 'syringe' },
  surgery: { he: 'ניתוח', en: 'Surgery', icon: 'scissors' },
  dental: { he: 'טיפול שיניים', en: 'Dental', icon: 'bone' },
  grooming: { he: 'טיפוח', en: 'Grooming', icon: 'sparkles' },
  emergency: { he: 'חירום', en: 'Emergency', icon: 'siren' },
  follow_up: { he: 'מעקב', en: 'Follow-up', icon: 'repeat' },
  other: { he: 'אחר', en: 'Other', icon: 'calendar' },
};
const APPT_STATUS = { requested: { he: 'ממתין לאישור', en: 'Pending' }, confirmed: { he: 'מאושר', en: 'Confirmed' }, completed: { he: 'הושלם', en: 'Completed' }, cancelled: { he: 'בוטל', en: 'Cancelled' }, no_show: { he: 'לא הגיע', en: 'No-show' } };
const INQ_STATUS = { open: { he: 'פתוח', en: 'Open' }, in_progress: { he: 'בטיפול', en: 'In progress' }, resolved: { he: 'נסגר', en: 'Resolved' } };
const PRIORITY = { low: { he: 'נמוכה', en: 'Low' }, normal: { he: 'רגילה', en: 'Normal' }, high: { he: 'גבוהה', en: 'High' }, urgent: { he: 'דחוף', en: 'Urgent' } };
const SEX = { male: { he: 'זכר', en: 'Male' }, female: { he: 'נקבה', en: 'Female' }, unknown: { he: 'לא ידוע', en: 'Unknown' } };
const NOTIF_TEMPLATE = { reminder_24h: { he: 'תזכורת 24 שעות', en: '24h reminder' }, reminder_2h: { he: 'תזכורת שעתיים', en: '2h reminder' } };

// Map free-text species (Hebrew or English) → gradient avatar + Lucide icon.
function speciesMeta(s) {
  s = (s || '').toLowerCase();
  if (s.includes('כלב') || s.includes('dog')) return { av: 'av-dog', icon: 'dog' };
  if (s.includes('חתול') || s.includes('cat')) return { av: 'av-cat', icon: 'cat' };
  if (s.includes('ציפור') || s.includes('תוכי') || s.includes('bird')) return { av: 'av-bird', icon: 'bird' };
  if (s.includes('ארנב') || s.includes('rabbit')) return { av: 'av-rabbit', icon: 'rabbit' };
  return { av: 'av-other', icon: 'paw-print' };
}

/* ===================== small builders ===================== */
const ic = (name) => `<i data-lucide="${name}"></i>`;
function petAvatar(species, size) { const m = speciesMeta(species); return `<div class="avatar ${m.av}${size ? ' ' + size : ''}">${ic(m.icon)}</div>`; }
function personAvatar(isVet, size) { return `<div class="avatar ${isVet ? 'av-vet' : 'av-user'}${size ? ' ' + size : ''}">${ic(isVet ? 'stethoscope' : 'user')}</div>`; }
function badge(kind, dict, value) { return `<span class="badge b-${kind}"><span class="dot"></span>${esc(TT(dict[value]) || value)}</span>`; }
function tileFor(status) { return ({ requested: 'tile-warn', confirmed: 'tile-info', completed: 'tile-ok', cancelled: 'tile-danger', no_show: 'tile-violet' }[status] || 'tile-blue'); }

function appbar({ title, sub, leading, trailing, center }) {
  return `<div class="appbar${center ? ' center' : ''}"><div class="appbar-row">${leading || ''}<div class="grow"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${trailing || ''}</div></div>`;
}
const iconbtn = (name, attr) => `<button class="iconbtn" ${attr || ''}>${ic(name)}</button>`;
const backBtn = () => `<button class="iconbtn" data-act="back">${ic('chevron-left')}</button>`.replace('data-lucide="chevron-left"', 'data-lucide="chevron-left" class="chev-back"');

/* ===================== State + navigation ===================== */
const State = { user: null };
State.lang = window.I18N.lang;
State.tab = 'home';
State.stack = [];

const Nav = {
  go(tab) { State.stack = []; State.tab = tab; closeSheet(); render(); },
  push(name, params) { State.stack.push({ name, params: params || {} }); closeSheet(); render(); },
  back() { State.stack.pop(); render(); },
  toggleLang() { window.I18N.setLang(window.I18N.lang === 'he' ? 'en' : 'he'); render(); },
};
function $app() { return document.querySelector('.amit-app'); }
function openSheet(node) { const host = $app(); if (!host) return; closeSheet(); host.appendChild(node); drawIcons(); }
function closeSheet() { document.querySelectorAll('.sheet-scrim').forEach((s) => s.remove()); }
function toast(msg, type = '') {
  let host = document.getElementById('toast-host');
  if (!host) { host = el('<div class="toast-host" id="toast-host"></div>'); ($app() || document.body).appendChild(host); }
  const node = el(`<div class="toast ${type}">${type === 'ok' ? ic('check') : ''}<span>${esc(msg)}</span></div>`);
  host.appendChild(node); drawIcons();
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; setTimeout(() => node.remove(), 300); }, 2600);
}

/* ===================== sheet + form helpers ===================== */
function sheet({ title, body, foot, onClose }) {
  const scrim = el(`<div class="sheet-scrim"><div class="sheet"><div class="sheet-grip"></div>
    <div class="sheet-head"><h3>${esc(title)}</h3><button class="iconbtn ghost" data-x>${ic('x')}</button></div>
    <div class="sheet-body"></div></div></div>`);
  const sh = scrim.querySelector('.sheet');
  const bd = scrim.querySelector('.sheet-body');
  if (typeof body === 'string') bd.innerHTML = body; else if (Array.isArray(body)) body.forEach((n) => bd.appendChild(n)); else if (body) bd.appendChild(body);
  if (foot) { const f = el('<div class="sheet-foot"></div>'); (Array.isArray(foot) ? foot : [foot]).forEach((n) => f.appendChild(n)); sh.appendChild(f); }
  const close = () => { scrim.remove(); if (onClose) onClose(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('[data-x]').onclick = close;
  return { scrim, close, body: bd };
}
const fieldHtml = (label, inner) => `<div class="field"><label>${esc(label)}</label>${inner}</div>`;
function optionList(dict, sel) { return Object.entries(dict).map(([v, o]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(TT(o))}</option>`).join(''); }
async function petOptions(selected) { const { pets } = await api('/pets'); return pets.map((p) => `<option value="${p.id}" ${String(p.id) === String(selected) ? 'selected' : ''}>${esc(p.name)}${p.owner_name ? ' · ' + esc(p.owner_name) : ''}</option>`).join(''); }

/* ===================== boot ===================== */
(async function init() {
  applyTheme(currentTheme());
  if (!CONFIG_OK) return renderSetup();
  try { const { user } = await api('/auth/me'); State.user = user; State.tab = user.role === 'vet' ? 'dashboard' : 'home'; render(); }
  catch { renderLogin(); }
})();

function renderSetup() {
  document.documentElement.dir = 'rtl';
  $('#app').replaceChildren(el(`<div class="amit-app" dir="rtl"><div class="scr"><div class="scr-scroll" style="display:grid;place-items:center">
    <div class="card pad-lg" style="max-width:420px;margin:24px">
      <div class="avatar av-vet lg" style="margin-bottom:14px">${ic('stethoscope')}</div>
      <h2 style="font-family:var(--font-display);font-size:20px;margin-bottom:8px">הגדרת AmitVet</h2>
      <p class="muted">חיבור ל-Supabase לא הושלם. מלאו את <code>docs/config.js</code> לפי ה-README.</p>
    </div></div></div></div>`));
  drawIcons();
}

/* ===================== login ===================== */
function renderLogin() {
  document.documentElement.dir = window.I18N.dir();
  const app = el(`<div class="amit-app" dir="${window.I18N.dir()}"></div>`);
  const wrap = el(`<div class="scr"><div class="scr-scroll" style="display:flex;flex-direction:column;justify-content:center;padding:24px;position:relative;overflow:hidden">
    ${oliveBranch('position:absolute;top:-10px;inset-inline-start:-18px;width:78px;height:auto;opacity:.5')}
    ${oliveBranch('position:absolute;bottom:-8px;inset-inline-end:-18px;width:78px;height:auto;opacity:.5', true)}
    <div style="text-align:center;margin-bottom:8px">${logoHtml(1.5, 'ד״ר עמית יולזרי')}
      <p class="muted" style="margin-top:10px">${esc(T('appTag'))}</p></div>
    <div class="card pad-lg mt16">
      <div class="seg mb12" id="ltabs"><button class="active" data-t="login">${esc(T('login'))}</button><button data-t="signup">${esc(T('signup'))}</button></div>
      <div id="lform"></div>
    </div>
    <button class="btn soft sm" id="langtoggle" style="align-self:center;margin-top:18px">${ic('languages')}${window.I18N.lang === 'he' ? 'English' : 'עברית'}</button>
  </div></div>`);
  app.appendChild(wrap);
  $('#app').replaceChildren(app);
  const tabs = wrap.querySelectorAll('#ltabs button');
  tabs.forEach((b) => b.onclick = () => { tabs.forEach((x) => x.classList.remove('active')); b.classList.add('active'); b.dataset.t === 'login' ? loginForm() : signupForm(); });
  wrap.querySelector('#langtoggle').onclick = () => { window.I18N.setLang(window.I18N.lang === 'he' ? 'en' : 'he'); renderLogin(); };
  loginForm();
  drawIcons();
}
function loginForm() {
  const f = el(`<form>
    ${fieldHtml(T('email'), '<input type="email" name="email" required autocomplete="username">')}
    ${fieldHtml(T('password'), '<input type="password" name="password" required autocomplete="current-password">')}
    <button class="btn block lg" type="submit">${esc(T('enter'))}</button>
    <p class="muted txt-c mt12" style="font-size:12.5px">${esc(T('loginHint'))}</p>
  </form>`);
  f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true;
    try { const { user } = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } }); State.user = user; State.tab = user.role === 'vet' ? 'dashboard' : 'home'; State.stack = []; render(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; } };
  document.getElementById('lform').replaceChildren(f); drawIcons();
}
function signupForm() {
  const f = el(`<form>
    ${fieldHtml(T('fullName'), '<input name="name" required>')}
    ${fieldHtml(T('email'), '<input type="email" name="email" required>')}
    ${fieldHtml(T('phone'), '<input name="phone" placeholder="050-0000000">')}
    ${fieldHtml(T('password'), '<input type="password" name="password" minlength="6" required>')}
    <button class="btn block lg" type="submit">${esc(T('createAccount'))}</button>
  </form>`);
  f.onsubmit = async (e) => { e.preventDefault(); const btn = f.querySelector('button'); btn.disabled = true;
    try { const { user } = await api('/auth/register', { method: 'POST', body: { name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value } }); State.user = user; State.tab = 'home'; State.stack = []; render(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; } };
  document.getElementById('lform').replaceChildren(f); drawIcons();
}

/* ===================== tab bar + shell ===================== */
function tabsFor(role, stats) {
  if (role === 'vet') return [
    { id: 'dashboard', icon: 'layout-dashboard', label: T('dashboard') },
    { id: 'appts', icon: 'calendar', label: T('appts'), badge: stats?.pendingAppointments },
    { id: 'inquiries', icon: 'message-circle', label: T('inquiries'), badge: stats?.openInquiries },
    { id: 'tasks', icon: 'list-checks', label: T('tasks'), badge: stats?.openTasks },
    { id: 'more', icon: 'menu', label: T('more') },
  ];
  return [
    { id: 'home', icon: 'home', label: T('home') },
    { id: 'pets', icon: 'paw-print', label: T('myPets') },
    { id: 'appts', icon: 'calendar', label: T('myAppts') },
    { id: 'inquiries', icon: 'message-circle', label: T('messages') },
    { id: 'clinic', icon: 'building-2', label: T('clinic') },
  ];
}
function tabBar(tabs, active) {
  const moreActive = active === 'more' || ['pets', 'clients', 'clinic'].includes(active);
  const bar = el('<div class="tabbar"></div>');
  tabs.forEach((tb) => {
    const on = tb.id === 'more' ? moreActive : tb.id === active;
    const b = el(`<button class="tab${on ? ' active' : ''}"><span class="tab-ic ic">${ic(tb.icon)}${tb.badge ? `<span class="tab-dot">${tb.badge}</span>` : ''}</span><span class="tab-lbl">${esc(tb.label)}</span></button>`);
    b.onclick = () => tb.id === 'more' ? openMore() : Nav.go(tb.id);
    bar.appendChild(b);
  });
  return bar;
}
function fabBtn(label, icon, onClick) { const b = el(`<button class="fab">${ic(icon)}<span>${esc(label)}</span></button>`); b.onclick = onClick; return b; }

const SCREENS = {
  home: clientHome, dashboard: vetDashboard, pets: petsList, appts: apptsList,
  inquiries: inquiriesList, clinic: clinicScreen, tasks: tasksScreen, clients: clientsScreen,
};

async function render() {
  if (!State.user) return renderLogin();
  // tear down any live chat channel when navigating away
  if (window.__chatChannel) { try { sb.removeChannel(window.__chatChannel); } catch {} window.__chatChannel = null; }
  document.documentElement.dir = window.I18N.dir();
  const app = el(`<div class="amit-app" dir="${window.I18N.dir()}"><div id="screen"><div class="center-fill"><div class="spinner"></div></div></div></div>`);
  $('#app').replaceChildren(app);
  try {
    const top = State.stack[State.stack.length - 1];
    let result;
    if (top) result = await (top.name === 'pet' ? petDetail(top.params) : chatScreen(top.params));
    else result = await (SCREENS[State.tab] || (State.user.role === 'vet' ? vetDashboard : clientHome))();
    app.querySelector('#screen').replaceChildren(result.node);
    if (!top) {
      app.appendChild(tabBar(tabsFor(State.user.role, result.stats), State.tab));
      if (result.fab) app.appendChild(result.fab);
    }
    app.appendChild(el('<div class="toast-host" id="toast-host"></div>'));
    drawIcons();
  } catch (e) { toast(e.message || 'שגיאה', 'err'); }
}

// builds a .scr node from an appbar spec + body html/nodes
function scrNode(appbarSpec, body, { hasTabs, hasFab } = {}) {
  const s = el('<div class="scr"></div>');
  s.insertAdjacentHTML('beforeend', appbar(appbarSpec));
  const sc = el(`<div class="scr-scroll fade-in${hasTabs ? ' has-tabs' : ''}${hasFab ? ' has-fab' : ''}"></div>`);
  if (typeof body === 'string') sc.innerHTML = body; else if (Array.isArray(body)) body.forEach((n) => n && sc.appendChild(n)); else if (body) sc.appendChild(body);
  s.appendChild(sc);
  // wire back button if present
  const back = s.querySelector('[data-act="back"]'); if (back) back.onclick = () => Nav.back();
  return s;
}

/* ===================== shared row builders ===================== */
function apptRow(a, showClient) {
  const tp = APPT_TYPES[a.type] || APPT_TYPES.other;
  return `<div class="row-item click" data-appt='${encodeURIComponent(JSON.stringify(a))}'>
    <span class="stat-ic ${tileFor(a.status)}" style="margin:0">${ic(tp.icon)}</span>
    <div class="grow"><div class="ri-title">${esc(TT(tp))}${a.pet_name ? ' · ' + esc(a.pet_name) : ''}</div>
      <div class="ri-meta truncate">${esc(window.fmtDateTime(a.scheduled_at))}${showClient && a.client_name ? ' · ' + esc(a.client_name) : ''}</div></div>
    ${badge(a.status, APPT_STATUS, a.status)}</div>`;
}
function inqRow(i, showClient) {
  return `<div class="row-item click" data-inq="${i.id}">
    <span class="stat-ic ${i.status === 'resolved' ? 'tile-ok' : 'tile-info'}" style="margin:0">${ic('message-circle')}</span>
    <div class="grow"><div class="ri-title truncate">${esc(i.subject)}</div>
      <div class="ri-meta truncate">${showClient && i.client_name ? esc(i.client_name) + ' · ' : ''}${i.message_count || 0} ${esc(T('msgsCount'))} · ${esc(window.relDay(i.updated_at))}</div></div>
    ${badge(i.status, INQ_STATUS, i.status)}</div>`;
}
function wirePetCards(node) { node.querySelectorAll('[data-pet]').forEach((c) => c.onclick = () => Nav.push('pet', { id: c.dataset.pet })); }
function wireApptRows(node) { node.querySelectorAll('[data-appt]').forEach((c) => c.onclick = () => apptManage(JSON.parse(decodeURIComponent(c.dataset.appt)))); }
function wireInqRows(node) { node.querySelectorAll('[data-inq]').forEach((c) => c.onclick = () => Nav.push('chat', { id: c.dataset.inq })); }

/* ===================== CLIENT: home ===================== */
async function clientHome() {
  const [{ appointments }, { pets }, reminders] = await Promise.all([api('/appointments'), api('/pets'), api('/reminders')]);
  const upcoming = appointments.filter((a) => a.status !== 'cancelled' && a.status !== 'completed').slice(0, 3);
  const trailing = iconbtn('settings-2', 'data-act="settings"');
  const body = el(`<div>
    <div class="section">
      <div class="grid c3">
        <button class="card click" data-q="appts" style="text-align:center;padding:18px 8px"><span class="stat-ic tile-blue" style="margin:0 auto 8px">${ic('calendar-plus')}</span><div style="font-weight:700;font-size:13px">${esc(T('bookAppt'))}</div></button>
        <button class="card click" data-q="inquiries" style="text-align:center;padding:18px 8px"><span class="stat-ic tile-teal" style="margin:0 auto 8px">${ic('message-square-plus')}</span><div style="font-weight:700;font-size:13px">${esc(T('newInquiry'))}</div></button>
        <button class="card click" data-q="pets" style="text-align:center;padding:18px 8px"><span class="stat-ic tile-violet" style="margin:0 auto 8px">${ic('plus')}</span><div style="font-weight:700;font-size:13px">${esc(T('addPet'))}</div></button>
      </div>
    </div>
    <div class="section"><div class="section-head"><h2>${esc(T('reminders'))}</h2></div><div class="stack sm" id="rem"></div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('upcomingAppts'))}</h2></div><div class="stack sm" id="up"></div></div>
  </div>`);
  const rem = body.querySelector('#rem');
  const vacc = reminders.vaccinations || [], soon = (reminders.appointments || []).slice(0, 3);
  if (!vacc.length && !soon.length) rem.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('allGood'))}</div>`;
  vacc.forEach((v) => rem.insertAdjacentHTML('beforeend', `<div class="row-item"><span class="stat-ic tile-warn" style="margin:0">${ic('syringe')}</span><div class="grow"><div class="ri-title">${esc(v.vaccine_name)}${v.pet_name ? ' · ' + esc(v.pet_name) : ''}</div><div class="ri-meta">${esc(T('nextDue'))}: ${esc(window.fmtDate(v.next_due))}</div></div></div>`));
  soon.forEach((a) => rem.insertAdjacentHTML('beforeend', apptRow(a, false)));
  const up = body.querySelector('#up');
  if (!upcoming.length) up.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noToday'))}</div>`;
  upcoming.forEach((a) => up.insertAdjacentHTML('beforeend', apptRow(a, false)));
  wireApptRows(body);
  body.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => Nav.go(b.dataset.q));
  const node = scrNode({ title: T('welcome') + ', ' + State.user.name.split(' ')[0], sub: T('welcomeBack'), trailing }, body, { hasTabs: true });
  wireSettings(node);
  return { node };
}

/* ===================== VET: dashboard ===================== */
async function vetDashboard() {
  const d = await api('/admin/dashboard');
  const s = d.stats;
  const trailing = iconbtn('settings-2', 'data-act="settings"');
  const statCard = (n, label, icon, tile) => `<div class="stat"><span class="stat-ic ${tile}">${ic(icon)}</span><div class="stat-n">${n}</div><div class="stat-l">${esc(label)}</div></div>`;
  const body = el(`<div>
    <div class="section"><div class="grid c2">
      ${statCard(s.pendingAppointments, T('pendingAppts'), 'calendar-clock', 'tile-warn')}
      ${statCard(s.openInquiries, T('openInquiries'), 'message-circle', 'tile-info')}
      ${statCard(s.openTasks || 0, T('openTasks'), 'list-checks', 'tile-violet')}
      ${statCard(s.totalPets, T('totalPets'), 'paw-print', 'tile-teal')}
    </div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('todayAppts'))}</h2></div><div class="stack sm" id="today"></div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('upcomingVacc'))}</h2></div><div class="stack sm" id="vacc"></div></div>
  </div>`);
  const today = body.querySelector('#today');
  if (!d.todayAppointments.length) today.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noToday'))}</div>`;
  d.todayAppointments.forEach((a) => today.insertAdjacentHTML('beforeend', apptRow(a, true)));
  const vacc = body.querySelector('#vacc');
  if (!d.upcomingVaccinations.length) vacc.innerHTML = `<div class="card flat muted" style="text-align:center">—</div>`;
  d.upcomingVaccinations.forEach((v) => vacc.insertAdjacentHTML('beforeend', `<div class="row-item"><span class="stat-ic tile-warn" style="margin:0">${ic('syringe')}</span><div class="grow"><div class="ri-title">${esc(v.vaccine_name)} · ${esc(v.pet_name)}</div><div class="ri-meta">${esc(v.owner_name || '')} · ${esc(T('nextDue'))}: ${esc(window.fmtDate(v.next_due))}</div></div></div>`));
  wireApptRows(body);
  const node = scrNode({ title: T('dashboard'), sub: TT({ he: 'ד״ר', en: 'Dr.' }) + ' ' + State.user.name, trailing }, body, { hasTabs: true });
  wireSettings(node);
  return { node, stats: s };
}

/* ===================== pets ===================== */
async function petsList() {
  const isVet = State.user.role === 'vet';
  const { pets } = await api('/pets');
  const body = el('<div class="section"><div class="stack" id="list"></div></div>');
  const list = body.querySelector('#list');
  if (!pets.length) list.innerHTML = `<div class="empty"><div class="empty-ic">${ic('paw-print')}</div><div class="empty-t">${esc(T('noPets'))}</div><div class="empty-s">${esc(T('noPetsSub'))}</div></div>`;
  pets.forEach((p) => list.insertAdjacentHTML('beforeend', `<div class="row-item click" data-pet="${p.id}">${petAvatar(p.species)}
    <div class="grow"><div class="ri-title">${esc(p.name)}</div><div class="ri-meta truncate">${esc(p.species)}${p.breed ? ' · ' + esc(p.breed) : ''}${window.ageFrom(p.birthdate) ? ' · ' + window.ageFrom(p.birthdate) : ''}${isVet && p.owner_name ? ' · ' + esc(p.owner_name) : ''}</div></div>
    <span class="row-chev">${ic('chevron-left')}</span></div>`));
  wirePetCards(body);
  const node = scrNode({ title: isVet ? T('pets') : T('myPets'), leading: isVet ? backBtnIfMore() : '' }, body, { hasTabs: true, hasFab: !isVet });
  return { node, fab: isVet ? null : fabBtn(T('addPet'), 'plus', () => petForm()) };
}
function backBtnIfMore() { return ''; } // vet reaches pets via More; tab bar handles nav

async function petDetail({ id }) {
  const isVet = State.user.role === 'vet';
  const { pet, vaccinations, records, prescriptions = [], weights = [] } = await api(`/pets/${id}`);
  const latest = weights.length ? weights[weights.length - 1].weight_kg : pet.weight_kg;
  const sub = `${esc(pet.species)}${pet.breed ? ' · ' + esc(pet.breed) : ''}`;
  const body = el(`<div>
    <div class="section"><div class="card" style="display:flex;gap:14px;align-items:center">
      ${petAvatar(pet.species, 'lg')}
      <div class="grow"><div style="font-family:var(--font-display);font-weight:700;font-size:21px">${esc(pet.name)}</div>
        <div class="muted" style="font-size:13.5px">${sub}</div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <span class="pill-tag">${ic('venus-mars')}${esc(TT(SEX[pet.sex]) || '—')}</span>
          ${window.ageFrom(pet.birthdate) ? `<span class="pill-tag">${ic('cake')}${window.ageFrom(pet.birthdate)}</span>` : ''}
          ${latest ? `<span class="pill-tag">${ic('weight')}${latest} ${esc(T('kg'))}</span>` : ''}
        </div></div></div>
      ${pet.notes ? `<div class="card flat mt12" style="font-size:13.5px">${esc(pet.notes)}</div>` : ''}
    </div>
    <div class="section"><div class="section-head"><h2>${esc(T('weightTrack'))}</h2>${isVet ? `<button class="link" data-add="weight">${ic('plus')}${esc(T('add'))}</button>` : ''}</div><div id="wt"></div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('prescriptions'))}</h2>${isVet ? `<button class="link" data-add="rx">${ic('plus')}${esc(T('add'))}</button>` : ''}</div><div class="stack sm" id="rx"></div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('vaccinations'))}</h2>${isVet ? `<button class="link" data-add="vacc">${ic('plus')}${esc(T('add'))}</button>` : ''}</div><div class="stack sm" id="vc"></div></div>
    <div class="section"><div class="section-head"><h2>${esc(T('medHistory'))}</h2>${isVet ? `<button class="link" data-add="record">${ic('plus')}${esc(T('add'))}</button>` : ''}</div><div class="stack sm" id="mr"></div></div>
  </div>`);
  // weight chart
  const wt = body.querySelector('#wt');
  if (weights.length >= 2) wt.appendChild(weightChart(weights)); else wt.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noWeights'))}</div>`;
  const rx = body.querySelector('#rx');
  if (!prescriptions.length) rx.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noRx'))}</div>`;
  prescriptions.forEach((p) => { const row = el(`<div class="row-item"><span class="stat-ic ${p.active ? 'tile-ok' : 'tile-danger'}" style="margin:0">${ic('pill')}</span>
    <div class="grow"><div class="ri-title">${esc(p.medication)}${p.dosage ? ' · ' + esc(p.dosage) : ''}</div><div class="ri-meta truncate">${p.instructions ? esc(p.instructions) + ' · ' : ''}${esc(window.fmtDate(p.start_date))}${p.end_date ? ' – ' + esc(window.fmtDate(p.end_date)) : ''}</div></div>
    <span class="badge ${p.active ? 'b-active' : 'b-stopped'}">${esc(p.active ? T('active') : T('stopped'))}</span></div>`);
    if (isVet) { row.style.cursor = 'pointer'; row.onclick = async () => { await api(`/prescriptions/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); render(); }; }
    rx.appendChild(row); });
  const vc = body.querySelector('#vc');
  if (!vaccinations.length) vc.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noVacc'))}</div>`;
  vaccinations.forEach((v) => vc.insertAdjacentHTML('beforeend', `<div class="row-item"><span class="stat-ic tile-teal" style="margin:0">${ic('syringe')}</span><div class="grow"><div class="ri-title">${esc(v.vaccine_name)}</div><div class="ri-meta truncate">${esc(T('given'))}: ${esc(window.fmtDate(v.date_given))}${v.next_due ? ' · ' + esc(T('next')) + ': ' + esc(window.fmtDate(v.next_due)) : ''}</div></div></div>`));
  const mr = body.querySelector('#mr');
  if (!records.length) mr.innerHTML = `<div class="card flat muted" style="text-align:center">${esc(T('noRecords'))}</div>`;
  records.forEach((r) => mr.insertAdjacentHTML('beforeend', `<div class="row-item"><span class="stat-ic tile-blue" style="margin:0">${ic('clipboard-list')}</span><div class="grow"><div class="ri-title">${esc(window.fmtDate(r.visit_date))}${r.diagnosis ? ' · ' + esc(r.diagnosis) : ''}</div><div class="ri-meta truncate">${r.treatment ? esc(r.treatment) : ''}${r.vet_name ? ' · ' + esc(r.vet_name) : ''}</div></div></div>`));

  const trailing = isVet ? '' : `<button class="iconbtn" data-act="editpet">${ic('pencil')}</button>`;
  const node = scrNode({ title: pet.name, sub, leading: backBtn(), trailing }, body);
  if (isVet) {
    body.querySelector('[data-add="weight"]').onclick = () => weightForm(id);
    body.querySelector('[data-add="rx"]').onclick = () => rxForm(id);
    body.querySelector('[data-add="vacc"]').onclick = () => vaccForm(id);
    body.querySelector('[data-add="record"]').onclick = () => recordForm(id);
  } else {
    node.querySelector('[data-act="editpet"]').onclick = () => petForm(pet);
  }
  return { node };
}

function weightChart(weights) {
  const w = 320, h = 110, pad = 14, padTop = 16, padBot = 22;
  const vals = weights.map((x) => Number(x.weight_kg));
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1, n = weights.length;
  const xAt = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const yAt = (v) => padTop + (1 - (v - min) / span) * (h - padTop - padBot);
  const line = vals.map((v, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1)).join(' ');
  const area = line + ` L${xAt(n - 1).toFixed(1)} ${h - padBot} L${xAt(0).toFixed(1)} ${h - padBot} Z`;
  const dots = vals.map((v, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="${i === n - 1 ? 4.5 : 3}" fill="#fff" stroke="#0fa39a" stroke-width="2.5"/>`).join('');
  return el(`<div class="card flat" style="padding:14px" dir="ltr">
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:110px;display:block" preserveAspectRatio="none">
      <defs><linearGradient id="wfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(15,163,154,.28)"/><stop offset="100%" stop-color="rgba(15,163,154,0)"/></linearGradient></defs>
      <path d="${area}" fill="url(#wfill)"/><path d="${line}" fill="none" stroke="#0fa39a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--ink-3);font-weight:600;margin-top:2px">
      <span>${window.fmtDateShort(weights[0].measured_at)}</span><span>${min}–${max} ${T('kg')}</span><span>${window.fmtDateShort(weights[n - 1].measured_at)}</span></div></div>`);
}

/* ===================== appointments ===================== */
let apptFilter = '';
async function apptsList() {
  const isVet = State.user.role === 'vet';
  const { appointments } = await api('/appointments' + (isVet && apptFilter ? '?status=' + apptFilter : ''));
  const body = el('<div></div>');
  if (isVet) {
    const chips = el('<div class="chips"></div>');
    [['', T('all')], ['requested', TT(APPT_STATUS.requested)], ['confirmed', TT(APPT_STATUS.confirmed)], ['completed', TT(APPT_STATUS.completed)], ['cancelled', TT(APPT_STATUS.cancelled)]]
      .forEach(([v, l]) => { const c = el(`<button class="chip${apptFilter === v ? ' active' : ''}">${esc(l)}</button>`); c.onclick = () => { apptFilter = v; render(); }; chips.appendChild(c); });
    body.appendChild(chips);
  }
  const sect = el('<div class="section"><div class="stack" id="list"></div></div>'); body.appendChild(sect);
  const list = sect.querySelector('#list');
  if (!appointments.length) list.innerHTML = `<div class="empty"><div class="empty-ic">${ic('calendar')}</div><div class="empty-t">${esc(T('noAppts'))}</div><div class="empty-s">${esc(T('noApptsSub'))}</div></div>`;
  appointments.forEach((a) => list.insertAdjacentHTML('beforeend', apptRow(a, isVet)));
  wireApptRows(body);
  const node = scrNode({ title: isVet ? T('appts') : T('myAppts') }, body, { hasTabs: true, hasFab: true });
  return { node, fab: fabBtn(isVet ? T('newAppt') : T('bookAppt'), 'plus', () => apptForm()) };
}

async function apptForm() {
  const opts = await petOptions();
  mountSheet(sheet({
    title: State.user.role === 'vet' ? T('newAppt') : T('requestAppt'),
    body: `<form id="af">
      ${fieldHtml(T('apptType'), `<select name="type">${optionList(APPT_TYPES, 'checkup')}</select>`)}
      ${fieldHtml(T('whichPet'), `<select name="pet_id"><option value="">—</option>${opts}</select>`)}
      ${fieldHtml(T('dateTime'), '<input type="datetime-local" name="scheduled_at" required>')}
      ${fieldHtml(T('reason'), `<textarea name="reason" placeholder="${esc(T('reasonPh'))}"></textarea>`)}
    </form>`,
    foot: btnEl(T('sendRequest'), 'btn block', async (b) => {
      const f = document.getElementById('af'); if (!f.scheduled_at.value) return toast(T('required'), 'err');
      b.disabled = true;
      try { await api('/appointments', { method: 'POST', body: { pet_id: f.pet_id.value || null, type: f.type.value, scheduled_at: f.scheduled_at.value.replace('T', ' '), reason: f.reason.value } });
        toast(State.user.role === 'vet' ? T('saved') : T('requestSent'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    }),
  }));
}

function apptManage(a) {
  const isVet = State.user.role === 'vet';
  const tp = APPT_TYPES[a.type] || APPT_TYPES.other;
  const info = `<div class="stack sm">
    <div class="drow"><div class="dk">${ic('activity')}${esc(T('status'))}</div><div class="dv">${badge(a.status, APPT_STATUS, a.status)}</div></div>
    <div class="drow"><div class="dk">${ic(tp.icon)}${esc(T('apptType'))}</div><div class="dv">${esc(TT(tp))}</div></div>
    <div class="drow"><div class="dk">${ic('clock')}${esc(T('dateTime'))}</div><div class="dv">${esc(window.fmtDateTime(a.scheduled_at))}</div></div>
    ${a.pet_name ? `<div class="drow"><div class="dk">${ic('paw-print')}${esc(T('whichPet'))}</div><div class="dv">${esc(a.pet_name)}</div></div>` : ''}
    ${isVet && a.client_name ? `<div class="drow"><div class="dk">${ic('user')}${esc(T('owner'))}</div><div class="dv">${esc(a.client_name)} · ${esc(a.client_phone || '')}</div></div>` : ''}
    ${a.reason ? `<div class="drow"><div class="dk">${ic('file-text')}${esc(T('reason'))}</div><div class="dv">${esc(a.reason)}</div></div>` : ''}
  </div>`;
  let bodyHtml = info;
  if (isVet) bodyHtml += `<div class="section-head"><h2>${esc(T('manageAppt'))}</h2></div>
    ${fieldHtml(T('changeStatus'), `<select id="m-status">${optionList(APPT_STATUS, a.status)}</select>`)}
    ${fieldHtml(T('reschedule'), `<input type="datetime-local" id="m-when" value="${a.scheduled_at ? a.scheduled_at.replace(' ', 'T').slice(0, 16) : ''}">`)}
    ${fieldHtml(T('vetNotes'), `<textarea id="m-notes">${esc(a.vet_notes || '')}</textarea>`)}
    <div id="m-rem"></div>`;
  const foot = isVet
    ? btnEl(T('saveChanges'), 'btn block', async (b) => { b.disabled = true; try { await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: document.getElementById('m-status').value, scheduled_at: document.getElementById('m-when').value.replace('T', ' '), vet_notes: document.getElementById('m-notes').value } }); toast(T('updated'), 'ok'); s.close(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } })
    : (['requested', 'confirmed'].includes(a.status) ? btnEl(T('cancelAppt'), 'btn danger block', async () => { if (!confirm(T('cancelAppt') + '?')) return; await api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: 'cancelled' } }); toast(T('updated'), 'ok'); s.close(); render(); }) : null);
  const s = mountSheet(sheet({ title: T('apptDetails'), body: bodyHtml, foot }));
  if (isVet) loadReminderLog(a.id);
}
async function loadReminderLog(apptId) {
  try { const { notifications } = await api(`/notifications?appointment_id=${apptId}`); const host = document.getElementById('m-rem'); if (!host || !notifications.length) return;
    host.insertAdjacentHTML('beforeend', `<div class="section-head" style="margin-top:8px"><h2>${esc(T('remindersLog'))}</h2></div>` + notifications.map((nt) => `<div class="row-item" style="margin-bottom:8px"><span class="stat-ic ${nt.status === 'sent' ? 'tile-ok' : nt.status === 'failed' ? 'tile-danger' : 'tile-info'}" style="margin:0">${ic('bell')}</span><div class="grow"><div class="ri-title">${esc(TT(NOTIF_TEMPLATE[nt.template]) || nt.template)}</div><div class="ri-meta">${esc(window.fmtDateTime(nt.send_at))} · ${esc(nt.status)}</div></div></div>`).join('')); drawIcons();
  } catch {}
}

/* ===================== inquiries + chat ===================== */
let inqFilter = '';
async function inquiriesList() {
  const isVet = State.user.role === 'vet';
  const { inquiries } = await api('/inquiries' + (isVet && inqFilter ? '?status=' + inqFilter : ''));
  const body = el('<div></div>');
  if (isVet) {
    const chips = el('<div class="chips"></div>');
    [['', T('all')], ['open', TT(INQ_STATUS.open)], ['in_progress', TT(INQ_STATUS.in_progress)], ['resolved', TT(INQ_STATUS.resolved)]]
      .forEach(([v, l]) => { const c = el(`<button class="chip${inqFilter === v ? ' active' : ''}">${esc(l)}</button>`); c.onclick = () => { inqFilter = v; render(); }; chips.appendChild(c); });
    body.appendChild(chips);
  }
  const sect = el('<div class="section"><div class="stack" id="list"></div></div>'); body.appendChild(sect);
  const list = sect.querySelector('#list');
  if (!inquiries.length) list.innerHTML = `<div class="empty"><div class="empty-ic">${ic('message-circle')}</div><div class="empty-t">${esc(T('noInq'))}</div><div class="empty-s">${esc(T('noInqSub'))}</div></div>`;
  inquiries.forEach((i) => list.insertAdjacentHTML('beforeend', inqRow(i, isVet)));
  wireInqRows(body);
  const node = scrNode({ title: isVet ? T('inquiries') : T('messages') }, body, { hasTabs: true, hasFab: !isVet });
  return { node, fab: isVet ? null : fabBtn(T('newInquiry'), 'plus', () => inquiryForm()) };
}

async function inquiryForm() {
  const opts = await petOptions();
  const s = mountSheet(sheet({
    title: T('newInquiryFull'),
    body: `<form id="if">
      ${fieldHtml(T('subject'), '<input name="subject" required>')}
      ${fieldHtml(T('relatedPet'), `<select name="pet_id"><option value="">—</option>${opts}</select>`)}
      ${fieldHtml(T('priority'), `<select name="priority">${optionList(PRIORITY, 'normal')}</select>`)}
      ${fieldHtml(T('messageBody'), `<textarea name="body" required placeholder="${esc(T('messagePh'))}"></textarea>`)}
    </form>`,
    foot: btnEl(T('send'), 'btn block', async (b) => { const f = document.getElementById('if'); if (!f.subject.value || !f.body.value) return toast(T('required'), 'err'); b.disabled = true;
      try { const { inquiry } = await api('/inquiries', { method: 'POST', body: { subject: f.subject.value, body: f.body.value, pet_id: f.pet_id.value || null, priority: f.priority.value } }); s.close(); Nav.push('chat', { id: inquiry.id }); } catch (e) { toast(e.message, 'err'); b.disabled = false; } }),
  }));
}

async function chatScreen({ id }) {
  const isVet = State.user.role === 'vet';
  const { inquiry, messages } = await api(`/inquiries/${id}`);
  const trailing = isVet ? `<button class="iconbtn" data-act="manageinq">${ic('sliders-horizontal')}</button>` : '';
  const body = el(`<div class="section"><div class="mb12" style="display:flex;gap:6px;flex-wrap:wrap">${badge(inquiry.status, INQ_STATUS, inquiry.status)}<span class="badge b-${inquiry.priority}">${esc(TT(PRIORITY[inquiry.priority]))}</span>${inquiry.pet_name ? `<span class="pill-tag">${ic('paw-print')}${esc(inquiry.pet_name)}</span>` : ''}</div><div class="thread" id="thread"></div></div>`);
  const thread = body.querySelector('#thread');
  const renderMsgs = (msgs) => { thread.innerHTML = ''; msgs.forEach((m) => { const mine = m.sender_id === State.user.id;
    thread.insertAdjacentHTML('beforeend', `<div class="msg ${mine ? 'mine' : 'theirs'}"><div class="who">${esc(m.sender_name)}${m.sender_role === 'vet' ? ' · ' + T('vetTitle') : ''}</div><div>${esc(m.body).replace(/\n/g, '<br>')}</div><div class="when">${esc(window.fmtDateTime(m.created_at))}</div></div>`); });
    setTimeout(() => thread.scrollIntoView(false), 20); };
  renderMsgs(messages);
  // composer (fixed bottom)
  const node = scrNode({ title: inquiry.subject, leading: backBtn(), trailing }, body);
  const composer = el(`<div class="composer"><input id="reply" placeholder="${esc(T('replyPh'))}"><button class="send" id="send">${ic('send')}</button></div>`);
  node.appendChild(composer);
  const send = async () => { const inp = node.querySelector('#reply'); const text = inp.value.trim(); if (!text) return;
    try { await api(`/inquiries/${id}/messages`, { method: 'POST', body: { body: text } }); inp.value = ''; const { messages: m } = await api(`/inquiries/${id}`); renderMsgs(m); } catch (e) { toast(e.message, 'err'); } };
  node.querySelector('#send').onclick = send;
  node.querySelector('#reply').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  if (isVet) node.querySelector('[data-act="manageinq"]').onclick = () => inquiryManage(inquiry);
  // realtime
  const channel = sb.channel('inq-' + id).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `inquiry_id=eq.${id}` },
    async () => { try { const { messages: m } = await api(`/inquiries/${id}`); renderMsgs(m); } catch {} }).subscribe();
  // clean up channel when leaving (next render removes node); store for safety
  if (window.__chatChannel) { try { sb.removeChannel(window.__chatChannel); } catch {} }
  window.__chatChannel = channel;
  drawIcons();
  return { node };
}
function inquiryManage(inq) {
  mountSheet(sheet({ title: T('manageInq'),
    body: `${fieldHtml(T('status'), `<select id="iq-status">${optionList(INQ_STATUS, inq.status)}</select>`)}${fieldHtml(T('priority'), `<select id="iq-pri">${optionList(PRIORITY, inq.priority)}</select>`)}`,
    foot: btnEl(T('saveChanges'), 'btn block', async () => { await api(`/inquiries/${inq.id}`, { method: 'PATCH', body: { status: document.getElementById('iq-status').value, priority: document.getElementById('iq-pri').value } }); toast(T('updated'), 'ok'); closeSheet(); render(); }) }));
}

/* ===================== tasks (vet) ===================== */
let taskFilter = 'open';
async function tasksScreen() {
  const { tasks } = await api('/tasks' + (taskFilter ? '?status=' + taskFilter : ''));
  const body = el('<div></div>');
  const chips = el('<div class="chips"></div>');
  [['open', T('openTasks')], ['done', T('complete')], ['', T('all')]].forEach(([v, l]) => { const c = el(`<button class="chip${taskFilter === v ? ' active' : ''}">${esc(l)}</button>`); c.onclick = () => { taskFilter = v; render(); }; chips.appendChild(c); });
  body.appendChild(chips);
  const sect = el('<div class="section"><div class="stack sm" id="list"></div></div>'); body.appendChild(sect);
  const list = sect.querySelector('#list');
  if (!tasks.length) list.innerHTML = `<div class="empty"><div class="empty-ic">${ic('list-checks')}</div><div class="empty-t">${esc(T('noTasks'))}</div><div class="empty-s">${esc(T('noTasksSub'))}</div></div>`;
  tasks.forEach((tk) => { const done = tk.status === 'done';
    const row = el(`<div class="row-item"><button class="stat-ic ${done ? 'tile-ok' : 'tile-blue'}" data-toggle style="margin:0;border:none">${ic(done ? 'check-circle-2' : 'circle')}</button>
      <div class="grow" data-edit><div class="ri-title" style="${done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(tk.title)}</div><div class="ri-meta truncate">${tk.due_date ? esc(T('dueDate')) + ': ' + esc(window.fmtDate(tk.due_date)) : ''}${tk.client_name ? ' · ' + esc(tk.client_name) : ''}</div></div>
      <span class="badge b-${tk.priority}">${esc(TT(PRIORITY[tk.priority]))}</span></div>`);
    row.querySelector('[data-toggle]').onclick = async (e) => { e.stopPropagation(); await api(`/tasks/${tk.id}`, { method: 'PATCH', body: { status: done ? 'open' : 'done' } }); render(); };
    row.querySelector('[data-edit]').onclick = () => taskForm(tk);
    list.appendChild(row); });
  const node = scrNode({ title: T('tasks') }, body, { hasTabs: true, hasFab: true });
  return { node, fab: fabBtn(T('newTask'), 'plus', () => taskForm()) };
}
async function taskForm(task) {
  const [opts, { clients }] = await Promise.all([petOptions(task && task.pet_id), api('/admin/clients')]);
  const clientOpts = clients.map((c) => `<option value="${c.id}" ${task && c.id === task.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const footBtns = [btnEl(task ? T('save') : T('add'), 'btn block', async (b) => { const f = document.getElementById('tf'); if (!f.title.value) return toast(T('required'), 'err'); b.disabled = true;
    const payload = { title: f.title.value, due_date: f.due_date.value, priority: f.priority.value, client_id: f.client_id.value || null, pet_id: f.pet_id.value || null, notes: f.notes.value };
    try { await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PATCH' : 'POST', body: payload }); toast(T('saved'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } })];
  if (task) footBtns.unshift(btnEl(T('del'), 'btn danger', async () => { if (!confirm(T('confirmDelete'))) return; await api(`/tasks/${task.id}`, { method: 'DELETE' }); toast(T('deleted'), 'ok'); closeSheet(); render(); }));
  mountSheet(sheet({ title: task ? T('edit') : T('newTask'),
    body: `<form id="tf">
      ${fieldHtml(T('taskTitle'), `<input name="title" required value="${esc(task?.title || '')}">`)}
      <div class="field-row">${fieldHtml(T('dueDate'), `<input type="date" name="due_date" value="${esc(task?.due_date || '')}">`)}${fieldHtml(T('priority'), `<select name="priority">${optionList(PRIORITY, task?.priority || 'normal')}</select>`)}</div>
      ${fieldHtml(T('relatedClient'), `<select name="client_id"><option value="">—</option>${clientOpts}</select>`)}
      ${fieldHtml(T('relatedPet'), `<select name="pet_id"><option value="">—</option>${opts}</select>`)}
      ${fieldHtml(T('notes'), `<textarea name="notes">${esc(task?.notes || '')}</textarea>`)}
    </form>`, foot: footBtns }));
}

/* ===================== clients (vet) ===================== */
async function clientsScreen() {
  const { clients } = await api('/admin/clients');
  const body = el('<div class="section"><div class="stack sm" id="list"></div></div>');
  const list = body.querySelector('#list');
  if (!clients.length) list.innerHTML = `<div class="empty"><div class="empty-ic">${ic('users')}</div><div class="empty-t">${esc(T('noClients'))}</div></div>`;
  clients.forEach((c) => list.insertAdjacentHTML('beforeend', `<div class="row-item">${personAvatar(false)}<div class="grow"><div class="ri-title">${esc(c.name)}</div><div class="ri-meta truncate">${esc(c.email)}${c.phone ? ' · ' + esc(c.phone) : ''} · ${c.pet_count} ${esc(T('petsCount'))}</div></div></div>`));
  return { node: scrNode({ title: T('clients') }, body, { hasTabs: true }) };
}

/* ===================== clinic ===================== */
async function clinicScreen() {
  const isVet = State.user.role === 'vet';
  const { clinic } = await api('/clinic');
  let body;
  if (isVet) {
    body = el(`<div class="section"><div class="card pad-lg">
      ${fieldHtml(T('clinicName'), `<input id="cl-name" value="${esc(clinic.clinic_name || '')}">`)}
      <div class="field-row">${fieldHtml(T('phone'), `<input id="cl-phone" value="${esc(clinic.phone || '')}">`)}${fieldHtml(T('address'), `<input id="cl-addr" value="${esc(clinic.address || '')}">`)}</div>
      ${fieldHtml(T('hours'), `<textarea id="cl-hours">${esc(clinic.hours || '')}</textarea>`)}
      ${fieldHtml(T('emergency'), `<textarea id="cl-emerg">${esc(clinic.emergency_info || '')}</textarea>`)}
    </div></div>`);
    const save = btnEl(T('saveClinic'), 'btn block', async (b) => { b.disabled = true; try { await api('/clinic', { method: 'PUT', body: { clinic_name: document.getElementById('cl-name').value, phone: document.getElementById('cl-phone').value, address: document.getElementById('cl-addr').value, hours: document.getElementById('cl-hours').value, emergency_info: document.getElementById('cl-emerg').value } }); toast(T('saved'), 'ok'); } catch (e) { toast(e.message, 'err'); } b.disabled = false; });
    const wrap = el('<div class="section"></div>'); wrap.appendChild(save); body.appendChild(wrap);
  } else {
    const empty = !clinic.clinic_name && !clinic.phone && !clinic.address && !clinic.hours;
    body = el(`<div class="section">${empty ? `<div class="card flat muted" style="text-align:center">${esc(T('clinicEmpty'))}</div>` : `<div class="card pad-lg stack sm">
      ${clinic.phone ? `<div class="drow"><div class="dk">${ic('phone')}${esc(T('phone'))}</div><div class="dv">${esc(clinic.phone)}</div></div>` : ''}
      ${clinic.address ? `<div class="drow"><div class="dk">${ic('map-pin')}${esc(T('address'))}</div><div class="dv">${esc(clinic.address)}</div></div>` : ''}
      ${clinic.hours ? `<div class="drow"><div class="dk">${ic('clock')}${esc(T('hours'))}</div><div class="dv" style="white-space:pre-line">${esc(clinic.hours)}</div></div>` : ''}
      ${clinic.emergency_info ? `<div class="drow"><div class="dk">${ic('siren')}${esc(T('emergency'))}</div><div class="dv" style="white-space:pre-line">${esc(clinic.emergency_info)}</div></div>` : ''}
    </div>${clinic.phone ? `<a class="btn block mt12" href="tel:${esc(clinic.phone)}">${ic('phone')}${esc(T('callClinic'))}</a>` : ''}`}</div>`);
  }
  return { node: scrNode({ title: clinic.clinic_name || T('clinic') }, body, { hasTabs: true }) };
}

/* ===================== pet / medical forms ===================== */
function petForm(pet) {
  const footBtns = [btnEl(pet ? T('save') : T('add'), 'btn block', async (b) => { const f = document.getElementById('pf'); if (!f.name.value || !f.species.value) return toast(T('required'), 'err'); b.disabled = true;
    const payload = { name: f.name.value, species: f.species.value, breed: f.breed.value, sex: f.sex.value, birthdate: f.birthdate.value, weight_kg: f.weight_kg.value, notes: f.notes.value };
    try { await api(pet ? `/pets/${pet.id}` : '/pets', { method: pet ? 'PUT' : 'POST', body: payload }); toast(T('saved'), 'ok'); closeSheet(); if (pet) Nav.back(); else render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } })];
  if (pet) footBtns.unshift(btnEl(T('del'), 'btn danger', async () => { if (!confirm(T('confirmDelete'))) return; await api(`/pets/${pet.id}`, { method: 'DELETE' }); toast(T('deleted'), 'ok'); closeSheet(); Nav.go('pets'); }));
  mountSheet(sheet({ title: pet ? T('edit') : T('addNewPet'),
    body: `<form id="pf">
      ${fieldHtml(T('petName'), `<input name="name" required value="${esc(pet?.name || '')}">`)}
      <div class="field-row">${fieldHtml(T('species'), `<input name="species" required placeholder="${esc(TT({ he: 'כלב / חתול', en: 'Dog / Cat' }))}" value="${esc(pet?.species || '')}">`)}${fieldHtml(T('breed'), `<input name="breed" value="${esc(pet?.breed || '')}">`)}</div>
      <div class="field-row">${fieldHtml(T('sex'), `<select name="sex">${optionList(SEX, pet?.sex || 'unknown')}</select>`)}${fieldHtml(T('weight') + ' (' + T('kg') + ')', `<input type="number" step="0.01" name="weight_kg" value="${esc(pet?.weight_kg || '')}">`)}</div>
      ${fieldHtml(T('birthdate'), `<input type="date" name="birthdate" value="${esc(pet?.birthdate || '')}">`)}
      ${fieldHtml(T('notes'), `<textarea name="notes">${esc(pet?.notes || '')}</textarea>`)}
    </form>`, foot: footBtns }));
}
function rxForm(petId) {
  mountSheet(sheet({ title: T('addRx'),
    body: `<form id="rf">${fieldHtml(T('medication'), '<input name="medication" required>')}<div class="field-row">${fieldHtml(T('dosage'), '<input name="dosage">')}${fieldHtml(T('instructions'), '<input name="instructions">')}</div><div class="field-row">${fieldHtml(T('startDate'), `<input type="date" name="start_date" value="${new Date().toISOString().slice(0, 10)}">`)}${fieldHtml(T('endDate'), '<input type="date" name="end_date">')}</div></form>`,
    foot: btnEl(T('save'), 'btn block', async (b) => { const f = document.getElementById('rf'); if (!f.medication.value) return toast(T('required'), 'err'); b.disabled = true; try { await api('/prescriptions', { method: 'POST', body: { pet_id: petId, medication: f.medication.value, dosage: f.dosage.value, instructions: f.instructions.value, start_date: f.start_date.value, end_date: f.end_date.value } }); toast(T('saved'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } }) }));
}
function weightForm(petId) {
  mountSheet(sheet({ title: T('addWeight'),
    body: `<form id="wf"><div class="field-row">${fieldHtml(T('weight') + ' (' + T('kg') + ')', '<input type="number" step="0.01" name="weight_kg" required>')}${fieldHtml(T('dateGiven'), `<input type="date" name="measured_at" value="${new Date().toISOString().slice(0, 10)}">`)}</div>${fieldHtml(T('notes'), '<input name="notes">')}</form>`,
    foot: btnEl(T('save'), 'btn block', async (b) => { const f = document.getElementById('wf'); if (!f.weight_kg.value) return toast(T('required'), 'err'); b.disabled = true; try { await api('/weights', { method: 'POST', body: { pet_id: petId, weight_kg: f.weight_kg.value, measured_at: f.measured_at.value, notes: f.notes.value } }); toast(T('saved'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } }) }));
}
function vaccForm(petId) {
  mountSheet(sheet({ title: T('addVacc'),
    body: `<form id="vf">${fieldHtml(T('vaccineName'), '<input name="vaccine_name" required>')}<div class="field-row">${fieldHtml(T('dateGiven'), `<input type="date" name="date_given" value="${new Date().toISOString().slice(0, 10)}">`)}${fieldHtml(T('nextDue'), '<input type="date" name="next_due">')}</div>${fieldHtml(T('notes'), '<input name="notes">')}</form>`,
    foot: btnEl(T('save'), 'btn block', async (b) => { const f = document.getElementById('vf'); if (!f.vaccine_name.value) return toast(T('required'), 'err'); b.disabled = true; try { await api('/medical/vaccinations', { method: 'POST', body: { pet_id: petId, vaccine_name: f.vaccine_name.value, date_given: f.date_given.value, next_due: f.next_due.value, notes: f.notes.value } }); toast(T('saved'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } }) }));
}
function recordForm(petId) {
  mountSheet(sheet({ title: T('addRecord'),
    body: `<form id="mf">${fieldHtml(T('visitDate'), `<input type="date" name="visit_date" value="${new Date().toISOString().slice(0, 10)}">`)}${fieldHtml(T('diagnosis'), '<input name="diagnosis">')}${fieldHtml(T('treatment'), '<input name="treatment">')}${fieldHtml(T('notes'), '<textarea name="notes"></textarea>')}</form>`,
    foot: btnEl(T('save'), 'btn block', async (b) => { const f = document.getElementById('mf'); b.disabled = true; try { await api('/medical/records', { method: 'POST', body: { pet_id: petId, visit_date: f.visit_date.value, diagnosis: f.diagnosis.value, treatment: f.treatment.value, notes: f.notes.value } }); toast(T('saved'), 'ok'); closeSheet(); render(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } }) }));
}

/* ===================== more + settings ===================== */
function openMore() {
  const row = (icon, tile, label, onClick) => { const b = el(`<button class="row-item click"><span class="stat-ic ${tile}" style="margin:0;width:40px;height:40px">${ic(icon)}</span><div class="grow"><div class="ri-title">${esc(label)}</div></div><span class="row-chev">${ic('chevron-left')}</span></button>`); b.onclick = onClick; return b; };
  mountSheet(sheet({ title: T('more'), body: [
    row('paw-print', 'tile-blue', T('pets'), () => Nav.go('pets')),
    row('users', 'tile-teal', T('clients'), () => Nav.go('clients')),
    row('building-2', 'tile-violet', T('clinic'), () => Nav.go('clinic')),
    el('<div class="hairline" style="margin:6px 0"></div>'),
    row('settings-2', 'tile-info', T('settings'), () => { closeSheet(); openSettings(); }),
    row('log-out', 'tile-danger', T('logout'), async () => { await api('/auth/logout', { method: 'POST' }); State.user = null; State.stack = []; renderLogin(); }),
  ] }));
}
function openSettings() {
  const langSeg = el(`<div class="seg"><button data-l="he" class="${window.I18N.lang === 'he' ? 'active' : ''}">עברית</button><button data-l="en" class="${window.I18N.lang === 'en' ? 'active' : ''}">English</button></div>`);
  langSeg.querySelectorAll('button').forEach((b) => b.onclick = () => { window.I18N.setLang(b.dataset.l); closeSheet(); render(); });
  const cur = currentTheme();
  const swatches = el(`<div class="theme-swatches">${Object.entries(THEMES).map(([k, th]) => `<button data-th="${k}" title="${esc(TT(th.label))}" style="background:${th.swatch};${k === cur ? 'box-shadow:0 0 0 3px var(--card),0 0 0 5.5px ' + th.swatch + ';transform:scale(1.06)' : ''}"></button>`).join('')}</div>`);
  swatches.querySelectorAll('button').forEach((b) => b.onclick = () => { applyTheme(b.dataset.th); closeSheet(); openSettings(); });
  const logout = btnEl(T('logout'), 'btn danger block', async () => { await api('/auth/logout', { method: 'POST' }); State.user = null; State.stack = []; renderLogin(); });
  const s = mountSheet(sheet({ title: T('settings'),
    body: [el(`<div class="card flat" style="display:flex;gap:12px;align-items:center;margin-bottom:14px">${personAvatar(State.user.role === 'vet')}<div class="grow"><div class="ri-title">${esc(State.user.name)}</div><div class="ri-meta">${esc(State.user.role === 'vet' ? T('vetTitle') : T('clientTitle'))}</div></div></div>`),
      el(`<div class="field"><label>${esc(T('language'))}</label></div>`), langSeg,
      el(`<div class="field" style="margin-top:14px"><label>${esc(T('theme'))}</label></div>`), swatches],
    foot: logout }));
}
function wireSettings(node) { const b = node.querySelector('[data-act="settings"]'); if (b) b.onclick = () => openSettings(); }

/* ===================== sheet/button low-level helpers ===================== */
function btnEl(label, cls, onClick) { const b = el(`<button class="${cls}">${esc(label)}</button>`); b.onclick = () => onClick(b); return b; }
function mountSheet(s) { openSheet(s.scrim); return s; }
