'use strict';

const STORE = 'overstreet-v1';
const TYPES = {
  regular: { label: 'Regular', color: '#1F4E79' },
  deep: { label: 'Deep clean', color: '#7A2F45' },
  airbnb: { label: 'Airbnb', color: '#1F6A62' },
  post: { label: 'Post-construction', color: '#8A5A22' },
  org: { label: 'Organization', color: '#3D4C7A' },
  other: { label: 'Other', color: '#4A4A4A' },
};
const EXTRAS = [
  ['baseboards', 'Baseboards'],
  ['blinds', 'Blinds / shutters'],
  ['windows_in', 'Interior windows'],
  ['windows_out', 'Exterior windows'],
  ['fans', 'Ceiling fans'],
  ['fridge', 'Inside fridge'],
  ['oven', 'Inside oven'],
  ['microwave', 'Inside microwave'],
  ['cabinets', 'Inside cabinets'],
  ['laundry', 'Wash / fold laundry'],
  ['basement', 'Basement'],
  ['patio', 'Patio / deck / porch'],
  ['walls', 'Walls / spot cleaning'],
];
const DEEP_DEFAULTS = ['baseboards', 'blinds', 'windows_in', 'fridge', 'oven', 'microwave'];
const PAY_METHODS = ['Cash', 'Zelle', 'Cash App', 'Check'];
const WORK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let db = emptyDb();
let route = parseHash();
let codesOpen = false;
let pinInput = '';

function emptyDb() {
  return {
    settings: {
      business: 'Overstreet Cleaning Solutions',
      phone: '',
      pin: '',
      minCharge: 200,
      start: '08:00',
      end: '14:00',
      workDays: [1, 2, 3, 4, 5],
      unlocked: true,
    },
    clients: [],
    houses: [],
    jobs: [],
    waitlist: [],
  };
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || ('id' + Date.now() + Math.random().toString(16).slice(2));
}
function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
function addMonths(iso, n) {
  const d = parseISO(iso);
  d.setMonth(d.getMonth() + n);
  return todayISO(d);
}
function weekday(iso) { return parseISO(iso).getDay(); }
function fmtDate(iso) {
  return parseISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const am = h < 12;
  const hr = ((h + 11) % 12) + 1;
  return hr + ':' + String(m).padStart(2, '0') + (am ? ' AM' : ' PM');
}
function endTime(start, hours) {
  const [h, m] = (start || '08:00').split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  d.setMinutes(d.getMinutes() + hours * 60);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (raw && typeof raw === 'object') db = Object.assign(emptyDb(), raw, { settings: Object.assign(emptyDb().settings, raw.settings || {}) });
  } catch { db = emptyDb(); }
  if (db.settings.pin && sessionStorage.getItem('overstreet-ok') !== '1') db.settings.unlocked = false;
  else db.settings.unlocked = true;
}
function save() {
  localStorage.setItem(STORE, JSON.stringify(db));
}

function parseHash() {
  const h = (location.hash || '#today').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'today', id: parts[1] || '', extra: parts[2] || '' };
}
function go(hash) {
  location.hash = hash.startsWith('#') ? hash : '#' + hash;
}

function clientById(id) { return db.clients.find(c => c.id === id); }
function houseById(id) { return db.houses.find(h => h.id === id); }
function jobById(id) { return db.jobs.find(j => j.id === id); }
function housesFor(clientId) { return db.houses.filter(h => h.clientId === clientId); }
function jobsOn(iso) { return db.jobs.filter(j => j.date === iso && j.status !== 'canceled').sort((a, b) => (a.start || '').localeCompare(b.start || '')); }
function jobsBetween(a, b) { return db.jobs.filter(j => j.date >= a && j.date <= b && j.status !== 'canceled'); }

function mondayOf(iso) {
  const d = parseISO(iso);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return todayISO(d);
}

function mapsUrl(address) {
  return 'https://maps.google.com/?q=' + encodeURIComponent(address || '');
}
function smsUrl(phone, body) {
  const n = String(phone || '').replace(/[^\d+]/g, '');
  return 'sms:' + n + '?body=' + encodeURIComponent(body || '');
}
function extraLabels(ids) {
  return (ids || []).map(id => (EXTRAS.find(e => e[0] === id) || [id, id])[1]);
}

function shell(inner, tab) {
  const s = db.settings;
  return `<div class="app">
    <div class="topbar">
      <img class="mark" src="icon.svg" alt="">
      <div class="brand">
        <h1>Overstreet</h1>
        <p>${esc(s.business)}</p>
      </div>
      <button class="icon-btn" onclick="go('job/new')" title="Add job">+</button>
    </div>
    <main>${inner}</main>
    <nav class="nav">
      <button class="${tab === 'today' ? 'on' : ''}" onclick="go('today')">Today</button>
      <button class="${tab === 'week' ? 'on' : ''}" onclick="go('week')">Week</button>
      <button class="${tab === 'month' ? 'on' : ''}" onclick="go('month')">Month</button>
      <button class="${tab === 'money' ? 'on' : ''}" onclick="go('money')">Money</button>
      <button class="${tab === 'more' ? 'on' : ''}" onclick="go('more')">More</button>
    </nav>
  </div>`;
}

function jobCard(j) {
  const t = TYPES[j.type] || TYPES.other;
  const c = clientById(j.clientId);
  const h = houseById(j.houseId);
  const extras = extraLabels(j.extras);
  const paid = j.paid;
  return `<button class="card job" onclick="go('job/${j.id}')">
    <div class="row-between">
      <span class="time">${esc(fmtTime(j.start))} – ${esc(fmtTime(endTime(j.start, j.hours || 2)))}</span>
      <span class="badge" style="background:${t.color}">${esc(t.label)}</span>
    </div>
    <strong>${esc(c ? c.name : 'Client')}</strong>
    <div class="meta">${esc(h ? h.address : '')}${h && h.beds ? ' · ' + h.beds + ' bd / ' + h.baths + ' ba' : ''}${h && h.sqft ? ' · ' + h.sqft + ' sq ft' : ''}</div>
    ${extras.length ? `<div class="chips">${extras.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '<div class="meta">Standard clean — no extras</div>'}
    <div class="meta">${paid ? '<span class="paid">Paid ' + esc(j.payMethod || '') + '</span>' : '<span class="unpaid">Unpaid · $' + esc(j.amount || db.settings.minCharge) + '</span>'}${j.who ? ' · ' + esc(j.who) : ''}</div>
  </button>`;
}

function renderLock() {
  return `<div class="app lock"><div class="lock-screen">
    <img src="icon.svg" width="72" height="72" alt="">
    <h1>Overstreet</h1>
    <p>Enter PIN to see addresses and codes</p>
    <input id="pin" type="password" inputmode="numeric" maxlength="8" placeholder="PIN" onkeydown="if(event.key==='Enter')unlockPin()">
    <div class="actions"><button class="btn gold" onclick="unlockPin()">Unlock</button></div>
    <p id="pin-err" class="meta"></p>
  </div></div>`;
}

function renderToday() {
  const iso = route.id && /^\d{4}-\d{2}-\d{2}$/.test(route.id) ? route.id : todayISO();
  const list = jobsOn(iso);
  const isToday = iso === todayISO();
  const tomorrow = addDays(todayISO(), 1);
  const hour = new Date().getHours();
  const tomorrowJobs = jobsOn(tomorrow);
  const banner = (isToday && hour >= 17 && tomorrowJobs.length) ? `<div class="banner">
    <strong>Tomorrow · ${tomorrowJobs.length} job${tomorrowJobs.length === 1 ? '' : 's'}</strong>
    <p class="meta">${tomorrowJobs.map(j => fmtTime(j.start) + ' ' + (TYPES[j.type] || {}).label + ' · ' + (clientById(j.clientId) || {}).name).join('<br>')}</p>
    <div class="actions"><button class="btn sm primary" onclick="textTomorrow()">Text me tomorrow’s list</button></div>
  </div>` : '';
  return shell(`
    <div class="row-between">
      <button class="btn sm" onclick="go('today/${addDays(iso,-1)}')">‹</button>
      <div>
        <h2 class="page-title" style="margin:0">${isToday ? 'Today' : fmtDate(iso)}</h2>
        <p class="lede" style="margin:0">${fmtDate(iso)}</p>
      </div>
      <button class="btn sm" onclick="go('today/${addDays(iso,1)}')">›</button>
    </div>
    ${banner}
    ${list.length ? list.map(jobCard).join('') : `<div class="empty card"><h3>No jobs</h3><p>Paper calendar days like this used to be blank too. Add a job when you book one.</p></div>`}
    <div class="actions">
      <button class="btn primary full" onclick="go('job/new/${iso}')">Add job</button>
    </div>
  `, 'today');
}

function renderWeek() {
  const start = mondayOf(route.id && /^\d{4}-\d{2}-\d{2}$/.test(route.id) ? route.id : todayISO());
  const days = [0, 1, 2, 3, 4].map(i => addDays(start, i));
  const cols = days.map(iso => {
    const jobs = jobsOn(iso);
    return `<div class="daycol ${iso === todayISO() ? 'today' : ''}">
      <h3>${fmtDate(iso)}</h3>
      ${jobs.length ? jobs.map(j => {
        const t = TYPES[j.type] || TYPES.other;
        const c = clientById(j.clientId);
        return `<button class="pill" style="background:${t.color}" onclick="go('job/${j.id}')">${esc(fmtTime(j.start))}<br>${esc(c ? c.name : t.label)}</button>`;
      }).join('') : '<p class="meta">—</p>'}
    </div>`;
  }).join('');
  return shell(`
    <div class="row-between">
      <button class="btn sm" onclick="go('week/${addDays(start,-7)}')">‹ Week</button>
      <h2 class="page-title" style="margin:0">Week</h2>
      <button class="btn sm" onclick="go('week/${addDays(start,7)}')">Week ›</button>
    </div>
    <p class="lede">${fmtDate(start)} – ${fmtDate(addDays(start, 4))}</p>
    <div class="week">${cols}</div>
  `, 'week');
}

function renderMonth() {
  const base = route.id && /^\d{4}-\d{2}$/.test(route.id) ? route.id + '-01' : todayISO().slice(0, 7) + '-01';
  const first = parseISO(base);
  const ym = base.slice(0, 7);
  const startWeekday = first.getDay();
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const prev = first.getMonth() === 0 ? (first.getFullYear() - 1) + '-12' : first.getFullYear() + '-' + String(first.getMonth()).padStart(2, '0');
  const nextM = first.getMonth() === 11 ? (first.getFullYear() + 1) + '-01' : first.getFullYear() + '-' + String(first.getMonth() + 2).padStart(2, '0');
  let cells = WORK_DAYS.map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < startWeekday; i++) cells += `<div class="mday off"></div>`;
  for (let d = 1; d <= daysIn; d++) {
    const iso = ym + '-' + String(d).padStart(2, '0');
    const jobs = jobsOn(iso);
    cells += `<button class="mday ${iso === todayISO() ? 'today' : ''}" onclick="go('today/${iso}')">
      ${d}
      <div class="dots">${jobs.map(j => `<span class="dot" style="background:${(TYPES[j.type] || TYPES.other).color}"></span>`).join('')}</div>
    </button>`;
  }
  return shell(`
    <div class="row-between">
      <button class="btn sm" onclick="go('month/${prev}')">‹</button>
      <h2 class="page-title" style="margin:0">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <button class="btn sm" onclick="go('month/${nextM}')">›</button>
    </div>
    <p class="lede">Dots are jobs, colored by type. Tap a day.</p>
    <div class="month">${cells}</div>
  `, 'month');
}

function renderJob() {
  if (route.id === 'new' || route.extra === 'edit') return renderJobForm();
  const j = jobById(route.id);
  if (!j) return shell('<p class="lede">Job not found.</p>', 'today');
  const t = TYPES[j.type] || TYPES.other;
  const c = clientById(j.clientId) || {};
  const h = houseById(j.houseId) || {};
  const extras = extraLabels(j.extras);
  const clocked = j.clockIn && !j.clockOut;
  return shell(`
    <p class="lede">${fmtDate(j.date)}</p>
    <h2 class="page-title">${esc(c.name || 'Job')}</h2>
    <span class="badge" style="background:${t.color}">${esc(t.label)}</span>
    <p class="time" style="margin:10px 0">${esc(fmtTime(j.start))} – ${esc(fmtTime(endTime(j.start, j.hours || 2)))} · ${esc(j.hours || 2)} hr</p>
    <div class="card">
      <dl class="kv">
        <dt>Address</dt><dd>${esc(h.address || '—')}</dd>
        <dt>Size</dt><dd>${esc([h.sqft && (h.sqft + ' sq ft'), h.beds && (h.beds + ' bd'), h.baths && (h.baths + ' ba'), h.stories && (h.stories + ' stories')].filter(Boolean).join(' · ') || '—')}</dd>
        <dt>Pets</dt><dd>${esc(h.pets || 'None noted')}</dd>
        <dt>Who’s home</dt><dd>${esc(j.whoHome || h.whoHome || '—')}</dd>
        <dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</dd>
        <dt>Surfaces</dt><dd>${esc(h.surfaces || '—')}</dd>
        <dt>Do not touch</dt><dd>${esc(h.dontTouch || '—')}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="row-between"><strong>Door / gate codes</strong>
        <button class="btn sm" onclick="toggleCodes()">${codesOpen ? 'Hide' : 'Show'}</button></div>
      <p class="meta ${codesOpen ? 'open' : 'reveal'}" id="codes">${esc(h.access || 'No access notes')} ${h.codes ? ' · ' + esc(h.codes) : ''}</p>
      <p class="hint">Only you. Codes stay on this phone.</p>
    </div>
    ${extras.length ? `<div class="card"><strong>Extras this visit</strong><div class="chips" style="margin-top:8px">${extras.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div></div>` : `<div class="card"><strong>Standard clean</strong><p class="meta">No add-ons. Baseboards, blinds, windows, and insides of appliances are not included unless listed.</p></div>`}
    <div class="actions">
      ${h.address ? `<a class="btn primary" href="${esc(mapsUrl(h.address))}" target="_blank" rel="noopener">Directions</a>` : ''}
      ${c.phone ? `<a class="btn" href="${esc(smsUrl(c.phone, `You're booked ${fmtDate(j.date)} at ${fmtTime(j.start)} for a ${(TYPES[j.type] || {}).label} clean with Overstreet Cleaning Solutions. Reply if you need to change anything.`))}">Confirm booking</a>` : ''}
      ${c.phone ? `<a class="btn" href="${esc(smsUrl(c.phone, clientReminder(j, c, h)))}">Day-before text</a>` : ''}
    </div>
    <div class="card">
      <strong>Clock</strong>
      <p class="meta">${j.clockIn ? 'In ' + new Date(j.clockIn).toLocaleTimeString() : 'Not clocked in'}${j.clockOut ? ' · Out ' + new Date(j.clockOut).toLocaleTimeString() : ''}</p>
      <div class="actions">
        ${!j.clockIn ? `<button class="btn gold" onclick="clockIn('${j.id}')">Clock in</button>` : ''}
        ${clocked ? `<button class="btn primary" onclick="clockOut('${j.id}')">Clock out</button>` : ''}
      </div>
      <label>Miles this job</label>
      <input type="number" step="0.1" value="${esc(j.miles || '')}" onchange="setMiles('${j.id}', this.value)">
    </div>
    <div class="card">
      <strong>Payment</strong>
      <p>${j.paid ? '<span class="paid">Paid $' + esc(j.amount) + ' · ' + esc(j.payMethod) + '</span>' : '<span class="unpaid">Unpaid · $' + esc(j.amount || db.settings.minCharge) + '</span>'}</p>
      ${j.paid ? '' : `<div class="actions">${PAY_METHODS.map(m => `<button class="btn sm" onclick="markPaid('${j.id}','${m}')">${m}</button>`).join('')}</div>`}
    </div>
    <div class="actions">
      <button class="btn" onclick="addToGoogle('${j.id}')">Google Calendar</button>
      <button class="btn" onclick="downloadIcs('${j.id}')">Apple / .ics</button>
      <button class="btn" onclick="go('job/${j.id}/edit')">Edit</button>
      <button class="btn danger" onclick="cancelJob('${j.id}')">Cancel job</button>
    </div>
  `, 'today');
}

function renderJobForm() {
  const editing = route.extra === 'edit' ? jobById(route.id) : null;
  const housePrefill = editing ? (houseById(editing.houseId) || {}) : {};
  const clientPrefill = editing ? (clientById(editing.clientId) || {}) : {};
  const dateDefault = /^\d{4}-\d{2}-\d{2}$/.test(route.extra) ? route.extra : todayISO();
  const j = editing || {
    date: dateDefault,
    start: db.settings.start,
    hours: 3,
    type: 'regular',
    extras: [],
    amount: db.settings.minCharge,
    recur: '',
    who: 'Me',
  };
  const clientOpts = db.clients.map(c => `<option value="${c.id}" ${j.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const houseOpts = db.houses.map(h => {
    const c = clientById(h.clientId);
    return `<option value="${h.id}" ${j.houseId === h.id ? 'selected' : ''}>${esc((c && c.name) || '')} — ${esc(h.address)}</option>`;
  }).join('');
  return shell(`
    <h2 class="page-title">${editing ? 'Edit job' : 'New job'}</h2>
    <p class="lede">Type is color-coded on the calendar. Extras show on the day so you do not forget blinds or appliances.</p>
    <form onsubmit="return saveJob(event, '${editing ? editing.id : ''}')">
      <div class="field"><label>Client</label>
        <select name="clientId">${clientOpts}<option value="">— New client below —</option></select>
      </div>
      <div class="field"><label>New client name</label><input name="newClient" placeholder="If they are not in the list"></div>
      <div class="field"><label>Phone</label><input name="phone" type="tel" placeholder="For reminders" value="${esc(clientPrefill.phone || '')}"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(clientPrefill.email || '')}"></div>
      <div class="field"><label>House</label>
        <select name="houseId">${houseOpts}<option value="">— New house below —</option></select>
      </div>
      <div class="field"><label>Address</label><input name="address" placeholder="Full address" value="${esc(housePrefill.address || '')}"></div>
      <div class="field"><label>Square footage</label><input name="sqft" inputmode="numeric" value="${esc(housePrefill.sqft || '')}"></div>
      <div class="field"><label>Bedrooms</label><input name="beds" inputmode="numeric" value="${esc(housePrefill.beds || '')}"></div>
      <div class="field"><label>Bathrooms</label><input name="baths" inputmode="numeric" value="${esc(housePrefill.baths || '')}"></div>
      <div class="field"><label>Stories</label><input name="stories" inputmode="numeric" value="${esc(housePrefill.stories || '')}"></div>
      <div class="field"><label>Pets</label><input name="pets" placeholder="Type and where they go during the clean" value="${esc(housePrefill.pets || '')}"></div>
      <div class="field"><label>How you get in</label><input name="access" placeholder="Client home, lockbox, hide-a-key…" value="${esc(housePrefill.access || '')}"></div>
      <div class="field"><label>Codes</label><input name="codes" placeholder="Gate / door / alarm" value="${esc(housePrefill.codes || '')}"></div>
      <div class="field"><label>Special surfaces</label><input name="surfaces" placeholder="Marble, hardwood, plants" value="${esc(housePrefill.surfaces || '')}"></div>
      <div class="field"><label>Do not touch</label><input name="dontTouch" value="${esc(housePrefill.dontTouch || '')}"></div>
      <div class="field"><label>Who will be home</label><input name="whoHome" value="${esc((editing && editing.whoHome) || housePrefill.whoHome || '')}"></div>
      <div class="field"><label>Job type</label>
        <select name="type" onchange="onTypeChange(this)">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${j.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Extras (not in a standard clean)</label>
        <div class="choices" id="extras">${EXTRAS.map(([id, lab]) => `<label class="choice"><input type="checkbox" name="extras" value="${id}" ${(j.extras || []).includes(id) || (!editing && j.type === 'deep' && DEEP_DEFAULTS.includes(id)) ? 'checked' : ''}><span>${lab}</span></label>`).join('')}</div>
      </div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${esc(j.date)}" required></div>
      <div class="field"><label>Start</label><input name="start" type="time" value="${esc(j.start || '08:00')}" required></div>
      <div class="field"><label>Length</label>
        <select name="hours">${[2, 3, 4].map(n => `<option value="${n}" ${Number(j.hours) === n ? 'selected' : ''}>${n} hours</option>`).join('')}</select>
      </div>
      <div class="field"><label>Price (minimum $200)</label><input name="amount" type="number" min="200" step="1" value="${esc(j.amount || 200)}"></div>
      <div class="field"><label>Repeat</label>
        <select name="recur">
          <option value="">One-time</option>
          <option value="weekly" ${j.recur === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="biweekly" ${j.recur === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
          <option value="monthly" ${j.recur === 'monthly' ? 'selected' : ''}>Monthly</option>
        </select>
      </div>
      <div class="field"><label>Assigned</label>
        <select name="who"><option>Me</option><option ${j.who === 'Helper' ? 'selected' : ''}>Helper</option></select>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(j.notes || '')}</textarea></div>
      <button class="btn primary full" type="submit">Save job</button>
    </form>
  `, 'today');
}

function onTypeChange(sel) {
  if (sel.value !== 'deep') return;
  document.querySelectorAll('#extras input').forEach(i => {
    if (DEEP_DEFAULTS.includes(i.value)) i.checked = true;
  });
}

function saveJob(ev, editId) {
  ev.preventDefault();
  const f = ev.target;
  const g = n => (f[n] && f[n].value || '').trim();
  let clientId = g('clientId');
  if (!clientId) {
    if (!g('newClient')) { alert('Add a client name.'); return false; }
    clientId = uid();
    db.clients.push({ id: clientId, name: g('newClient'), phone: g('phone'), email: g('email') });
  } else {
    const c = clientById(clientId);
    if (c) {
      if (g('phone')) c.phone = g('phone');
      if (g('email')) c.email = g('email');
    }
  }
  let houseId = g('houseId');
  const houseFields = {
    address: g('address'), sqft: g('sqft'), beds: g('beds'), baths: g('baths'), stories: g('stories'),
    pets: g('pets'), access: g('access'), codes: g('codes'), surfaces: g('surfaces'), dontTouch: g('dontTouch'), whoHome: g('whoHome'),
  };
  if (!houseId) {
    if (!houseFields.address) { alert('Add the house address.'); return false; }
    houseId = uid();
    db.houses.push(Object.assign({ id: houseId, clientId }, houseFields));
  } else {
    const h = houseById(houseId);
    if (h) {
      Object.entries(houseFields).forEach(([k, v]) => { if (v) h[k] = v; });
      h.clientId = clientId;
    }
  }
  const extras = [...f.querySelectorAll('[name=extras]:checked')].map(i => i.value);
  const amount = Math.max(200, Number(g('amount') || 200));
  const base = {
    clientId, houseId, date: g('date'), start: g('start'), hours: Number(g('hours') || 3),
    type: g('type'), extras, amount, who: g('who'), notes: g('notes'), whoHome: g('whoHome'),
    recur: g('recur'), paid: false, status: 'scheduled',
  };
  if (editId) {
    const j = jobById(editId);
    if (j) Object.assign(j, base);
    save();
    go('job/' + editId);
    return false;
  }
  const series = uid();
  const first = Object.assign({ id: uid(), seriesId: series }, base);
  db.jobs.push(first);
  if (base.recur) {
    let iso = base.date;
    for (let i = 0; i < 15; i++) {
      iso = base.recur === 'weekly' ? addDays(iso, 7) : base.recur === 'biweekly' ? addDays(iso, 14) : addMonths(iso, 1);
      db.jobs.push(Object.assign({}, first, { id: uid(), date: iso, paid: false, clockIn: null, clockOut: null, miles: '' }));
    }
  }
  save();
  go('job/' + first.id);
  return false;
}

function renderClients() {
  const list = db.clients.slice().sort((a, b) => a.name.localeCompare(b.name));
  return shell(`
    <h2 class="page-title">Clients</h2>
    <p class="lede">Name, mobile, email — plus the house notes behind each one.</p>
    ${list.length ? list.map(c => {
      const hs = housesFor(c.id);
      return `<button class="card job" onclick="go('client/${c.id}')"><strong>${esc(c.name)}</strong>
        <div class="meta">${esc(c.phone || '')} ${esc(c.email || '')}</div>
        <div class="meta">${hs.map(h => h.address).join(' · ') || 'No house yet'}</div></button>`;
    }).join('') : `<div class="empty card"><h3>No clients yet</h3><p>Add one when you book the first job.</p></div>`}
    <div class="actions"><button class="btn primary full" onclick="go('job/new')">Add with a job</button></div>
  `, 'more');
}

function renderClient() {
  const c = clientById(route.id);
  if (!c) return shell('<p>Not found.</p>', 'more');
  const hs = housesFor(c.id);
  const upcoming = db.jobs.filter(j => j.clientId === c.id && j.date >= todayISO() && j.status !== 'canceled').sort((a, b) => a.date.localeCompare(b.date));
  return shell(`
    <h2 class="page-title">${esc(c.name)}</h2>
    <p class="meta">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''} ${esc(c.email || '')}</p>
    ${hs.map(h => `<div class="card"><strong>${esc(h.address)}</strong>
      <p class="meta">${esc([h.sqft && h.sqft + ' sq ft', h.beds && h.beds + ' bd', h.baths && h.baths + ' ba'].filter(Boolean).join(' · '))}</p>
      <p class="meta">Pets: ${esc(h.pets || '—')}</p>
    </div>`).join('')}
    <h3 style="margin:16px 0 8px">Upcoming</h3>
    ${upcoming.length ? upcoming.map(jobCard).join('') : '<p class="meta">None scheduled.</p>'}
    <div class="actions"><a class="btn" href="${c.phone ? smsUrl(c.phone, 'Thank you for choosing Overstreet Cleaning Solutions. We appreciate you!') : '#'}">Thank-you text</a></div>
  `, 'more');
}

function renderMoney() {
  const month = todayISO().slice(0, 7);
  const monthJobs = db.jobs.filter(j => j.date.startsWith(month) && j.status !== 'canceled');
  const owed = db.jobs.filter(j => !j.paid && j.status !== 'canceled' && j.date <= todayISO()).sort((a, b) => a.date.localeCompare(b.date));
  const taken = monthJobs.filter(j => j.paid).reduce((s, j) => s + Number(j.amount || 0), 0);
  const due = monthJobs.filter(j => !j.paid).reduce((s, j) => s + Number(j.amount || 0), 0);
  return shell(`
    <h2 class="page-title">Money</h2>
    <p class="lede">You collect at the job (cash, Zelle, Cash App, check). This only tracks what they owe.</p>
    <div class="card"><strong>This month</strong>
      <p class="paid">Collected $${taken.toFixed(0)}</p>
      <p class="unpaid">Still out $${due.toFixed(0)}</p>
    </div>
    <h3 style="margin:16px 0 8px">Unpaid</h3>
    ${owed.length ? owed.map(j => {
      const c = clientById(j.clientId);
      return `<div class="card"><strong>${esc(c ? c.name : '')}</strong>
        <p class="meta">${fmtDate(j.date)} · $${esc(j.amount)} · ${(TYPES[j.type] || {}).label}</p>
        <div class="actions">${PAY_METHODS.map(m => `<button class="btn sm" onclick="markPaid('${j.id}','${m}')">${m}</button>`).join('')}
        <button class="btn sm" onclick="go('job/${j.id}')">Open</button></div></div>`;
    }).join('') : '<p class="meta">Nothing unpaid. Nice.</p>'}
  `, 'money');
}

function renderReminders() {
  const tom = addDays(todayISO(), 1);
  const tjobs = jobsOn(tom);
  const todayJobs = jobsOn(todayISO());
  return shell(`
    <h2 class="page-title">Texts</h2>
    <p class="lede">True auto-texts need a texting service later. For now, one tap opens Messages with the right words filled in — night-before list, client reminder, thank-you.</p>
    <div class="card">
      <strong>Tomorrow (${fmtDate(tom)})</strong>
      ${tjobs.length ? tjobs.map(j => `<p class="meta">${fmtTime(j.start)} · ${(TYPES[j.type] || {}).label} · ${esc((clientById(j.clientId) || {}).name || '')}</p>`).join('') : '<p class="meta">No jobs tomorrow.</p>'}
      <div class="actions"><button class="btn primary" onclick="textTomorrow()">Text me the list</button></div>
    </div>
    <div class="card">
      <strong>Text clients for today</strong>
      ${todayJobs.length ? todayJobs.map(j => {
        const c = clientById(j.clientId);
        const h = houseById(j.houseId);
        if (!c || !c.phone) return `<p class="meta">${esc((c && c.name) || 'Client')} — no phone</p>`;
        return `<div class="row-between" style="margin:8px 0"><span>${esc(c.name)}</span><a class="btn sm" href="${esc(smsUrl(c.phone, clientReminder(j, c, h)))}">Text</a></div>`;
      }).join('') : '<p class="meta">No jobs today.</p>'}
    </div>
  `, 'more');
}

function clientReminder(j, c, h) {
  return `Hi ${c.name || ''}, this is Overstreet Cleaning confirming your ${(TYPES[j.type] || {}).label} clean on ${fmtDate(j.date)} at ${fmtTime(j.start)}. Reply if you need to change anything.`;
}
function tomorrowBody() {
  const tom = addDays(todayISO(), 1);
  const lines = [`Tomorrow ${fmtDate(tom)} — Overstreet`];
  jobsOn(tom).forEach(j => {
    const c = clientById(j.clientId);
    const h = houseById(j.houseId);
    const extras = extraLabels(j.extras).join(', ') || 'standard';
    lines.push(`${fmtTime(j.start)} ${(TYPES[j.type] || {}).label} — ${c ? c.name : ''} — ${h ? h.address : ''} — ${extras}`);
  });
  if (lines.length === 1) lines.push('No jobs.');
  return lines.join('\n');
}
function textTomorrow() {
  const phone = db.settings.phone;
  if (!phone) {
    alert('Add your mobile number in More → Settings so this can text you.');
    go('settings');
    return;
  }
  location.href = smsUrl(phone, tomorrowBody());
}

function renderWaitlist() {
  return shell(`
    <h2 class="page-title">Waitlist</h2>
    <p class="lede">When a slot opens, offer it from here.</p>
    ${db.waitlist.map(w => `<div class="card"><strong>${esc(w.name)}</strong>
      <p class="meta">${esc(w.phone)} · ${esc(w.note || '')}</p>
      <div class="actions">
        ${w.phone ? `<a class="btn sm" href="${esc(smsUrl(w.phone, 'A time opened on the Overstreet Cleaning calendar. Would you like it?'))}">Offer slot</a>` : ''}
        <button class="btn sm danger" onclick="dropWait('${w.id}')">Remove</button>
      </div></div>`).join('') || '<p class="meta">Waitlist is empty.</p>'}
    <form class="card" onsubmit="return addWait(event)">
      <div class="field"><label>Name</label><input name="name" required></div>
      <div class="field"><label>Phone</label><input name="phone" type="tel"></div>
      <div class="field"><label>Note</label><input name="note" placeholder="Looking for biweekly, east side…"></div>
      <button class="btn primary full" type="submit">Add to waitlist</button>
    </form>
  `, 'more');
}

function addWait(ev) {
  ev.preventDefault();
  const f = ev.target;
  db.waitlist.push({ id: uid(), name: f.name.value.trim(), phone: f.phone.value.trim(), note: f.note.value.trim() });
  save(); render(); return false;
}
function dropWait(id) {
  db.waitlist = db.waitlist.filter(w => w.id !== id);
  save(); render();
}

function renderSettings() {
  const s = db.settings;
  return shell(`
    <h2 class="page-title">Settings</h2>
    <form onsubmit="return saveSettings(event)">
      <div class="field"><label>Your mobile (for tomorrow’s list and the booking link)</label>
        <input name="phone" type="tel" value="${esc(s.phone)}" placeholder="Your number"></div>
      <div class="field"><label>PIN to open the app (optional)</label>
        <input name="pin" inputmode="numeric" value="${esc(s.pin)}" placeholder="Leave blank for none"></div>
      <div class="field"><label>Minimum charge</label>
        <input name="minCharge" type="number" value="${esc(s.minCharge)}"></div>
      <p class="hint">Hours are Mon–Fri, 8:00 AM – 2:00 PM, about two jobs a day. Change that later if you need to.</p>
      <button class="btn primary full" type="submit">Save</button>
    </form>
    <div class="card" style="margin-top:16px">
      <strong>Public booking page</strong>
      <p class="meta">No client accounts. They fill a form; it texts or emails you the request. You accept it on the calendar.</p>
      <div class="actions"><button class="btn" onclick="copyBookLink()">Copy booking link</button>
      <a class="btn" href="book.html" target="_blank" rel="noopener">Open page</a></div>
      <p class="hint" id="book-status"></p>
    </div>
  `, 'more');
}

function saveSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  db.settings.phone = f.phone.value.trim();
  db.settings.pin = f.pin.value.trim();
  db.settings.minCharge = Number(f.minCharge.value || 200);
  save();
  alert('Saved.');
  go('more');
  return false;
}

function copyBookLink() {
  const url = new URL('book.html', location.href);
  if (db.settings.phone) url.searchParams.set('to', db.settings.phone);
  const status = document.getElementById('book-status');
  navigator.clipboard.writeText(url.toString()).then(() => {
    if (status) status.textContent = 'Copied. Put this on flyers or text it to a new client.';
  }).catch(() => { if (status) status.textContent = url.toString(); });
}

function renderMore() {
  const miles = db.jobs.filter(j => j.date.slice(0, 7) === todayISO().slice(0, 7)).reduce((s, j) => s + Number(j.miles || 0), 0);
  return shell(`
    <h2 class="page-title">More</h2>
    <button class="card job" onclick="go('clients')"><strong>Clients & houses</strong><div class="meta">Addresses, pets, codes, square footage</div></button>
    <button class="card job" onclick="go('reminders')"><strong>Texts & tomorrow’s list</strong><div class="meta">Night-before list, client reminders, thank-you</div></button>
    <button class="card job" onclick="go('waitlist')"><strong>Waitlist</strong><div class="meta">Offer a slot when one opens</div></button>
    <button class="card job" onclick="go('settings')"><strong>Settings</strong><div class="meta">PIN, your number, booking link</div></button>
    <div class="card"><strong>This month’s miles</strong><p>${miles ? miles.toFixed(1) + ' mi' : 'Clock jobs and enter miles on each job card.'}</p></div>
    <p class="meta">Add to your Android home screen: browser menu → Add to Home screen.</p>
  `, 'more');
}

function toggleCodes() {
  codesOpen = !codesOpen;
  const el = document.getElementById('codes');
  if (el) el.classList.toggle('open', codesOpen);
  render();
}
function clockIn(id) {
  const j = jobById(id);
  if (j) { j.clockIn = new Date().toISOString(); save(); render(); }
}
function clockOut(id) {
  const j = jobById(id);
  if (j) { j.clockOut = new Date().toISOString(); save(); render(); }
}
function setMiles(id, v) {
  const j = jobById(id);
  if (j) { j.miles = v; save(); }
}
function markPaid(id, method) {
  const j = jobById(id);
  if (j) { j.paid = true; j.payMethod = method; j.paidAt = new Date().toISOString(); save(); render(); }
}
function cancelJob(id) {
  if (!confirm('Cancel this job?')) return;
  const j = jobById(id);
  if (j) { j.status = 'canceled'; save(); go('today'); }
}

function icsFor(j) {
  const c = clientById(j.clientId) || {};
  const h = houseById(j.houseId) || {};
  const start = j.date.replace(/-/g, '') + 'T' + (j.start || '08:00').replace(':', '') + '00';
  const endH = endTime(j.start, j.hours || 2).replace(':', '');
  const end = j.date.replace(/-/g, '') + 'T' + endH + '00';
  const title = (TYPES[j.type] || {}).label + ' — ' + (c.name || 'Clean');
  return `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${title}\nLOCATION:${(h.address || '').replace(/\n/g, ' ')}\nDESCRIPTION:${extraLabels(j.extras).join(', ')}\nEND:VEVENT\nEND:VCALENDAR`;
}
function downloadIcs(id) {
  const j = jobById(id);
  if (!j) return;
  const blob = new Blob([icsFor(j)], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'overstreet-job.ics';
  a.click();
}
function addToGoogle(id) {
  const j = jobById(id);
  if (!j) return;
  const c = clientById(j.clientId) || {};
  const h = houseById(j.houseId) || {};
  const start = j.date.replace(/-/g, '') + 'T' + (j.start || '08:00').replace(':', '') + '00';
  const end = j.date.replace(/-/g, '') + 'T' + endTime(j.start, j.hours || 2).replace(':', '') + '00';
  const url = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent((TYPES[j.type] || {}).label + ' — ' + (c.name || ''))
    + '&dates=' + start + '/' + end
    + '&location=' + encodeURIComponent(h.address || '')
    + '&details=' + encodeURIComponent(extraLabels(j.extras).join(', '));
  window.open(url, '_blank');
}

function unlockPin() {
  const v = (document.getElementById('pin') || {}).value || '';
  if (v === db.settings.pin) {
    sessionStorage.setItem('overstreet-ok', '1');
    db.settings.unlocked = true;
    render();
  } else {
    const err = document.getElementById('pin-err');
    if (err) err.textContent = 'Wrong PIN';
  }
}

function render() {
  route = parseHash();
  if (route.name === 'job' && route.id && route.id !== 'new' && location.hash.endsWith('/edit')) route.extra = 'edit';
  const root = document.getElementById('app');
  if (db.settings.pin && !db.settings.unlocked) {
    root.innerHTML = renderLock();
    return;
  }
  const map = {
    today: renderToday,
    week: renderWeek,
    month: renderMonth,
    job: renderJob,
    clients: renderClients,
    client: renderClient,
    money: renderMoney,
    reminders: renderReminders,
    waitlist: renderWaitlist,
    settings: renderSettings,
    more: renderMore,
  };
  const fn = map[route.name] || renderToday;
  root.innerHTML = fn();
  if (route.name === 'job' && (route.id === 'new' || route.extra === 'edit')) {
    const hash = location.hash;
    // keep form
  }
}

window.addEventListener('hashchange', () => { codesOpen = false; render(); });
load();
if (!location.hash) location.hash = '#today';
render();

if ('serviceWorker' in navigator) {
  const base = location.pathname.replace(/\/[^/]*$/, '/');
  navigator.serviceWorker.register(base + 'sw.js', { scope: base }).catch(() => {});
}
