'use strict';

/* ============================ Helpers ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || 'אירעה שגיאה');
  return data;
}

function toast(msg, type = '') {
  const t = el(`<div class="toast ${type}">${esc(msg)}</div>`);
  $('#toast-container').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

function openModal(title, bodyNode, footNode) {
  const overlay = el(`<div class="modal-overlay"><div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="x">×</button></div>
    <div class="modal-body"></div></div></div>`);
  overlay.querySelector('.modal-body').appendChild(bodyNode);
  if (footNode) { const f = el('<div class="modal-foot"></div>'); f.appendChild(footNode); overlay.querySelector('.modal').appendChild(f); }
  const close = () => overlay.remove();
  overlay.querySelector('.x').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  $('#modal-root').appendChild(overlay);
  return { close, overlay };
}

/* ============================ Dictionaries ============================ */
const APPT_TYPES = { checkup: 'בדיקה כללית', vaccination: 'חיסון', surgery: 'ניתוח', dental: 'טיפול שיניים',
  grooming: 'טיפוח', emergency: 'חירום', follow_up: 'מעקב', other: 'אחר' };
const APPT_STATUS = { requested: 'ממתין לאישור', confirmed: 'מאושר', completed: 'הושלם', cancelled: 'בוטל' };
const INQ_STATUS = { open: 'פתוח', in_progress: 'בטיפול', resolved: 'נסגר' };
const PRIORITY = { low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', urgent: 'דחוף' };
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
  try { const { user } = await api('/auth/me'); State.user = user; renderApp(); }
  catch { renderAuth(); }
})();

/* ============================ Auth screen ============================ */
function renderAuth() {
  const root = $('#app');
  root.innerHTML = '';
  const wrap = el(`<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">🐾</div>
    <h1>AmitVet</h1>
    <p class="sub">המרפאה הווטרינרית שלך, במרחק קליק</p>
    <div class="tabs"><button data-t="login" class="active">התחברות</button><button data-t="register">הרשמה</button></div>
    <div id="auth-form"></div>
  </div></div>`);
  root.appendChild(wrap);
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
    { id: 'dashboard', label: 'לוח בקרה', ico: '📊' },
    { id: 'appointments', label: 'פגישות', ico: '📅' },
    { id: 'inquiries', label: 'פניות', ico: '💬' },
    { id: 'clients', label: 'לקוחות', ico: '👥' },
    { id: 'pets', label: 'מטופלים', ico: '🐾' },
  ],
  client: [
    { id: 'dashboard', label: 'בית', ico: '🏠' },
    { id: 'pets', label: 'החיות שלי', ico: '🐾' },
    { id: 'appointments', label: 'הפגישות שלי', ico: '📅' },
    { id: 'inquiries', label: 'הפניות שלי', ico: '💬' },
  ],
};

function renderApp() {
  const root = $('#app');
  const isVet = State.user.role === 'vet';
  root.innerHTML = '';
  const shell = el(`<div>
    <div class="topbar">
      <div class="brand">🐾 AmitVet</div>
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
    const b = el(`<button data-v="${item.id}"><span class="ico">${item.ico}</span><span>${item.label}</span></button>`);
    b.onclick = () => navigate(item.id);
    nav.appendChild(b);
  });
  shell.querySelector('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); State.user = null; renderAuth(); };
  navigate('dashboard');
}

function navigate(view) {
  document.querySelectorAll('.sidebar nav button').forEach((b) => b.classList.toggle('active', b.dataset.v === view));
  const fn = { dashboard: viewDashboard, pets: viewPets, appointments: viewAppointments, inquiries: viewInquiries, clients: viewClients }[view];
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
  const [{ appointments }, { inquiries }, { pets }] = await Promise.all([
    api('/appointments'), api('/inquiries'), api('/pets')]);
  const upcoming = appointments.filter((a) => a.status !== 'cancelled' && a.status !== 'completed').slice(0, 3);
  const node = el(`<div>
    <div class="page-head"><h2>שלום, ${esc(State.user.name)} 👋</h2></div>
    <div class="grid cols-3 mb">
      <div class="card click" id="q-appt"><div class="avatar">📅</div><h3 class="mt">קביעת פגישה</h3><p class="muted">בקש/י תור לחיה שלך</p></div>
      <div class="card click" id="q-inq"><div class="avatar">💬</div><h3 class="mt">פנייה לווטרינר</h3><p class="muted">יש לך שאלה? כתוב/כתבי לנו</p></div>
      <div class="card click" id="q-pet"><div class="avatar">🐾</div><h3 class="mt">הוספת חיה</h3><p class="muted">${pets.length} חיות רשומות</p></div>
    </div>
    <div class="section-title">📅 הפגישות הקרובות שלך</div>
    <div id="up"></div>
  </div>`);
  node.querySelector('#q-appt').onclick = () => navigate('appointments');
  node.querySelector('#q-inq').onclick = () => navigate('inquiries');
  node.querySelector('#q-pet').onclick = () => navigate('pets');
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
  const { pet, vaccinations, records } = await api(`/pets/${id}`);
  const isVet = State.user.role === 'vet';
  const body = el(`<div>
    <div class="detail-row"><div class="k">סוג / גזע</div><div class="v">${esc(pet.species)}${pet.breed ? ' · ' + esc(pet.breed) : ''}</div></div>
    <div class="detail-row"><div class="k">מין</div><div class="v">${SEX[pet.sex] || '—'}</div></div>
    <div class="detail-row"><div class="k">גיל</div><div class="v">${ageFrom(pet.birthdate) || '—'}${pet.birthdate ? ' (' + fmtDate(pet.birthdate) + ')' : ''}</div></div>
    <div class="detail-row"><div class="k">משקל</div><div class="v">${pet.weight_kg ? pet.weight_kg + ' ק"ג' : '—'}</div></div>
    <div class="detail-row"><div class="k">הערות</div><div class="v">${esc(pet.notes) || '—'}</div></div>
    <div class="section-title">💉 חיסונים ${isVet ? '<button class="btn sm" id="add-vac">＋</button>' : ''}</div>
    <div id="vac"></div>
    <div class="section-title">📋 היסטוריה רפואית ${isVet ? '<button class="btn sm" id="add-rec">＋</button>' : ''}</div>
    <div id="rec"></div>
  </div>`);
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
  }
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

function apptDetail(a) {
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
      <div class="when">${fmtDateTime(m.created_at)}</div></div>`)); };
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

  const { close } = openModal(inquiry.subject, body);
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

/* ============================ small utils ============================ */
function wrapBtns(...btns) { const d = document.createElement('div'); d.style.display = 'flex'; d.style.gap = '10px'; btns.forEach((b) => d.appendChild(b)); return d; }
