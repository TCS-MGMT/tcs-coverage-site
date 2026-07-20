/* =========================================================================
   TCS Office Coverage Scheduler  —  runs 100% locally (no backend)
   Coverage window: 8:00 AM – 6:00 PM, Mon–Sun.
   8-hour shifts with a mandatory 1-hour lunch in the middle.
   ========================================================================= */

'use strict';

/* ----------------------------- CONFIG ---------------------------------- */
const OPEN_MIN = 8 * 60;     // 08:00
const CLOSE_MIN = 18 * 60;   // 18:00
const SLOT = 30;             // minutes per timeline slot
const N_SLOTS = (CLOSE_MIN - OPEN_MIN) / SLOT;   // 20

// Four INDEPENDENT cities. Each is assigned & covered on its own — pick and
// choose freely. Barbara owns Austin + San Antonio, Kitzia owns Dallas + Fort
// Worth as defaults (see PEOPLE.home), but any city can be staffed by anyone.
const GROUPS = [
  { id: 'AUS', name: 'Austin',       short: 'Austin',       color: 'var(--c-aus)' },
  { id: 'SAT', name: 'San Antonio',  short: 'San Antonio',  color: 'var(--c-sat)' },
  { id: 'DAL', name: 'Dallas',       short: 'Dallas',       color: 'var(--c-dal)' },
  { id: 'FTW', name: 'Fort Worth',   short: 'Fort Worth',   color: 'var(--c-ftw)' },
];
const GROUP = id => GROUPS.find(g => g.id === id);
// Legacy → new: older saved weeks / presence used the 2-group ids. Expand them
// so nothing crashes after the split (G1 "Austin/SA" -> both AUS & SAT, etc.).
const LEGACY = { G1: ['AUS', 'SAT'], G2: ['DAL', 'FTW'] };

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* role: rep = OWNS specific cities (its `home` list) + OpenPhone-exclusive to them.
         floater = backs up ANY city, on every number set (Mary).
         backup  = secondary floater / sub-manager (Tiffany).
         owner   = you; last-resort, gets full access when escalated.
   `home` is now a LIST of city ids a rep owns (a rep covers all of them).      */
// lunch:false => works a straight 9-hour day with NO break (Tiffany). Everyone
// else works 8 hours with a mandatory 1-hour lunch.
const PEOPLE = [
  { id: 'barbara', name: 'Barbara',     role: 'rep',     home: ['AUS', 'SAT'], color: 'var(--c-aus)' },
  { id: 'kitzia',  name: 'Kitzia',      role: 'rep',     home: ['DAL', 'FTW'], color: 'var(--c-dal)' },
  { id: 'maria',   name: 'Mary',        role: 'floater', home: [], color: 'var(--ok)' },
  { id: 'tiffany', name: 'Tiffany',     role: 'backup',  home: [], color: '#db2777', lunch: false, workMin: 570 },
  { id: 'owner',   name: 'You (Owner)', role: 'owner',   home: [], color: 'var(--owner)' },
];
const PERSON = id => PEOPLE.find(p => p.id === id);
const ROLE_LABEL = { rep: 'Owner', floater: 'Backup', backup: 'Backup', owner: 'Full access · last resort' };
const isFlexible = p => p.role !== 'rep';            // floater / backup / owner may cover any city
const homeCities = p => (p && Array.isArray(p.home)) ? p.home : [];   // cities a rep owns
const ownsCity = (p, gid) => p && p.role === 'rep' && homeCities(p).includes(gid);
const ownerOfCity = gid => PEOPLE.find(p => ownsCity(p, gid));        // the rep who owns a city (or undefined)
const takesLunch = p => !p || p.lunch !== false;     // Tiffany = false (no break)
// the person's working minutes: explicit workMin wins, else 8h (with lunch) / 9h (no break)
const maxWorkMin = p => (p && p.workMin) ? p.workMin : (takesLunch(p) ? 480 : 540);

/* shift presets — each is exactly 8 working hours + a 1-hour midday lunch */
// Lunch begins 3 hours after clock-in: 8a start -> 11a–12p, 9a start -> 12p–1p.
const SHIFTS = {
  open:  { label: 'Opener · 8a–5p',     start: 480,  end: 1020, lunchStart: 660, lunchEnd: 720 }, // 8–5, lunch 11–12
  close: { label: 'Closer · 9a–6p',     start: 540,  end: 1080, lunchStart: 720, lunchEnd: 780 }, // 9–6, lunch 12–1
  mid:   { label: 'Mid · 8:30a–5:30p',  start: 510,  end: 1050, lunchStart: 690, lunchEnd: 750 }, // 8:30–5:30, lunch 11:30–12:30
};

/* ----------------------------- HELPERS --------------------------------- */
const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

function fmt(min) {
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12; if (h === 0) h = 12;
  return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, '0')}${ap}`;
}
function shiftTimes(a) {                 // resolve preset -> explicit minutes
  const t = (a.preset && SHIFTS[a.preset])
    ? { ...SHIFTS[a.preset] }
    : { start: a.start, end: a.end, lunchStart: a.lunchStart, lunchEnd: a.lunchEnd };
  const p = PERSON(a.personId);
  if (!takesLunch(p)) {                  // no break -> one continuous shift of their full workday
    const work = maxWorkMin(p);
    if (t.end >= CLOSE_MIN) t.start = t.end - work;   // closer: keep the 6pm finish, start earlier
    else t.end = t.start + work;                       // opener/mid: keep the start, finish later
    if (t.start < OPEN_MIN) { t.start = OPEN_MIN; t.end = OPEN_MIN + work; }   // clamp into 8a–6p
    if (t.end > CLOSE_MIN) { t.end = CLOSE_MIN; t.start = CLOSE_MIN - work; }
    t.lunchStart = t.start; t.lunchEnd = t.start;      // no lunch
  }
  return t;
}
const hasLunch = t => t.lunchEnd > t.lunchStart;
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const off = (x.getDay() + 6) % 7; x.setDate(x.getDate() - off); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = d => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

/* --------------------------- STATE / STORAGE --------------------------- */
let weekStart = mondayOf(new Date());
let selectedDay = DAYS[Math.min((new Date().getDay() + 6) % 7, 6)];   // default to today if in week
let S = null;   // { Mon: {status:{pid:'work'|'off'|'pto'}, assign:[{id,personId,group,preset}]}, ... }

let weekPublished = true;     // (online) did the DB actually have this week?

/* --------------------------- BACKEND / AUTH ---------------------------- */
const CFG = window.TCS_CONFIG || {};
const ONLINE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
const sb = ONLINE ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
let ME = null;                                   // { personId, role, email } once signed in
const isManager = () => !ME || ME.role === 'manager';   // offline/local = manager (single-user)

const storageKey = () => 'tcs-cov-' + isoDate(weekStart);

function blankDay() {
  const status = {};
  PEOPLE.forEach(p => { status[p.id] = 'work'; });
  return { status, assign: [] };
}
function ensureDays() {
  if (!S || !S.Mon) { S = {}; DAYS.forEach(d => S[d] = blankDay()); autoBuildAll(); }
  DAYS.forEach(d => { if (!S[d]) S[d] = blankDay(); });
}
// Rewrite any old 2-group assignment (group:'G1'/'G2') into the new per-city
// ones so a week saved before the split renders cleanly. Returns true if it
// changed anything (so the manager can re-save the migrated schedule).
function migrateLegacy() {
  if (!S) return false;
  let changed = false;
  DAYS.forEach(d => {
    const day = S[d]; if (!day || !Array.isArray(day.assign)) return;
    const out = [];
    day.assign.forEach(a => {
      if (LEGACY[a.group]) { changed = true; LEGACY[a.group].forEach(cid => out.push({ ...a, id: newId(), group: cid })); }
      else out.push(a);
    });
    day.assign = out;
  });
  return changed;
}

async function loadWeek() {
  S = null; weekPublished = true;
  if (ONLINE && sb) {
    try {
      const { data, error } = await sb.from('schedules').select('data')
        .eq('week_start', isoDate(weekStart)).maybeSingle();
      if (!error && data && data.data) S = data.data; else weekPublished = false;
    } catch (e) { weekPublished = false; }
  } else {
    let raw = null;
    try { raw = localStorage.getItem(storageKey()); } catch (e) { /* file:// */ }
    if (raw) { try { S = JSON.parse(raw); } catch (e) { S = null; } }
  }
  ensureDays();                                  // build a starter week if empty
  const migrated = migrateLegacy();              // upgrade any pre-split (G1/G2) week in place
  if (ONLINE && isManager() && (!weekPublished || migrated)) await saveWeek();  // publish / persist the upgrade
}

let _saveTimer = null;
async function saveWeek() {
  if (ONLINE && sb) {
    if (!isManager()) return;                    // members never write (DB rules also block it)
    try {
      const { error } = await sb.from('schedules')
        .upsert({ week_start: isoDate(weekStart), data: S, updated_at: new Date().toISOString() });
      if (error) flashSync('Could not save to the server: ' + error.message, true);
      else { weekPublished = true; flashSync('Saved & shared with the team ✓', false); }
    } catch (e) { flashSync('Could not reach the server — your last change may not be saved.', true); }
  } else {
    try { localStorage.setItem(storageKey(), JSON.stringify(S)); } catch (e) { /* ignore */ }
  }
}
function persist() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveWeek, 500); }  // debounced

// Assignment ids must be unique across reloads AND across managers editing the same
// shared week (a per-page counter reset to 1 collides with stored a1..aN ids — then
// delete-by-id would remove BOTH rows). Time + randomness makes collisions practically
// impossible; old counter-style ids already in saved weeks stay valid.
const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* --------------------------- AUTO-BUILD -------------------------------- */
/* Build a sensible default for one day, per city:
   • Each city's OWNER (the rep) opens it. A rep owns 2 cities, so they open
     both. If the owner is off, the floater chain (Mary -> Tiffany -> You) steps
     into that city.
   • Then ONE free floater (Mary, else You, else Tiffany) is the staggered closer
     across every city — they carry lunches/edges so no city goes empty mid-day. */
function autoBuildDay(d) {
  const day = S[d];
  day.assign = [];
  const working = id => day.status[id] === 'work';
  const fallback = ['maria', 'tiffany', 'owner'];   // who covers a city when its owner is off

  // Pass 1 — primary (opener) for each city: its owner, else the first free floater.
  GROUPS.forEach(g => {
    const own = ownerOfCity(g.id);
    const primary = (own && working(own.id)) ? own.id : fallback.find(id => working(id));
    if (primary) day.assign.push({ id: newId(), personId: primary, group: g.id, preset: 'open' });
  });

  // Pass 2 — one floating backup (closer) on every city, to stagger lunches so
  // single-owner cities stay covered while the owner is on break. Pick a free
  // floater who isn't already a primary (one person works ONE shift).
  const primaries = new Set(day.assign.map(a => a.personId));
  const backup = ['maria', 'owner', 'tiffany'].find(id => working(id) && !primaries.has(id));
  if (backup) GROUPS.forEach(g => {
    if (!day.assign.some(a => a.personId === backup && a.group === g.id))
      day.assign.push({ id: newId(), personId: backup, group: g.id, preset: 'close' });
  });
}
function autoBuildAll() { DAYS.forEach(autoBuildDay); saveWeek(); }

/* --------------------------- COVERAGE ENGINE --------------------------- */
function slotRange(i) { return [OPEN_MIN + i * SLOT, OPEN_MIN + (i + 1) * SLOT]; }

function isActive(a, slotStart, slotEnd) {
  const t = shiftTimes(a);
  if (t.start > slotStart || t.end < slotEnd) return false;          // outside shift
  if (slotStart < t.lunchEnd && slotEnd > t.lunchStart) return false; // on lunch
  return true;
}
/* coverage[group] = array of N_SLOTS, each = array of personIds active then */
function computeCoverage(d) {
  const day = S[d];
  const cov = {}; GROUPS.forEach(g => cov[g.id] = []);
  for (let i = 0; i < N_SLOTS; i++) {
    const [s, e] = slotRange(i);
    GROUPS.forEach(g => {
      const present = day.assign
        .filter(a => a.group === g.id && isActive(a, s, e))
        .map(a => a.personId);
      cov[g.id].push([...new Set(present)]);
    });
  }
  return cov;
}
/* contiguous windows where coverage count == target, for messaging */
function windowsWhere(covArr, predicate) {
  const out = []; let run = null;
  for (let i = 0; i < N_SLOTS; i++) {
    if (predicate(covArr[i].length)) { if (!run) run = [i, i]; else run[1] = i; }
    else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out.map(([a, b]) => `${fmt(OPEN_MIN + a * SLOT)}–${fmt(OPEN_MIN + (b + 1) * SLOT)}`);
}

/* ----------------------------- RULES ----------------------------------- */
function escalated(d) {   // Mary AND Tiffany both unavailable
  const st = S[d].status;
  return st.maria !== 'work' && st.tiffany !== 'work';
}

function validateDay(d) {
  const day = S[d], cov = computeCoverage(d), out = [];
  const add = (level, text) => out.push({ level, text });
  const gShort = id => (GROUP(id) || { short: id }).short;   // crash-proof on an orphan/unmapped id

  // 1 & 2 — coverage per group
  GROUPS.forEach(g => {
    const arr = cov[g.id];
    const zeros = windowsWhere(arr, n => n === 0);
    const ones = windowsWhere(arr, n => n === 1);
    if (zeros.length) add('bad', `${g.short}: NO coverage at ${zeros.join(', ')} — assign someone.`);
    if (!zeros.length && ones.length) {
      const bk = backupName(d, g.id);
      add('warn', `${g.short}: single coverage at ${ones.join(', ')} (lunch/edges). On-call backup: ${bk}.`);
    }
    if (!zeros.length && !ones.length && arr.length) add('ok', `${g.short}: two-person coverage all day. ✓`);
    if (!day.assign.some(a => a.group === g.id)) add('bad', `${g.short}: nobody assigned.`);
  });

  // 3 & 4 — per-shift hours + mandatory lunch (Tiffany works 9h with no break)
  day.assign.forEach(a => {
    if (!GROUP(a.group)) return;          // skip any orphan/unmapped assignment (defensive)
    const t = shiftTimes(a), p = PERSON(a.personId);
    const work = (t.end - t.start) - (t.lunchEnd - t.lunchStart);
    const cap = maxWorkMin(p);
    if (work > cap) add('bad', `${p.name} (${GROUP(a.group).short}) is scheduled ${(work / 60).toFixed(1)}h — over the ${cap / 60}-hour limit.`);
    if (takesLunch(p)) {
      const lunch = t.lunchEnd - t.lunchStart;
      if (lunch < 60) add('bad', `${p.name}: lunch is only ${lunch}m — the 1-hour break is mandatory.`);
      else if (t.lunchStart <= t.start || t.lunchEnd >= t.end) add('warn', `${p.name}: lunch should sit in the middle of the shift.`);
    }
    if (day.status[a.personId] !== 'work') add('warn', `${p.name} is marked ${day.status[a.personId].toUpperCase()} but is assigned to ${GROUP(a.group).short}.`);
  });

  // 5 — rep exclusivity: a rep should only be on the cities it owns.
  const esc = escalated(d);
  PEOPLE.forEach(p => {
    const gs = [...new Set(day.assign.filter(a => a.personId === p.id).map(a => a.group))];
    if (p.role === 'rep') {
      const wrong = gs.filter(g => !homeCities(p).includes(g));
      if (wrong.length && !esc) add('warn', `${p.name} owns ${homeCities(p).map(g => gShort(g)).join(' & ')} but is also on ${wrong.map(g => gShort(g)).join(' & ')} — that breaks number/notification separation.`);
    } else if (gs.length > 1) {
      add('ok', `${p.name} covers ${gs.map(g => gShort(g)).join(', ')} as the floater (covers any city).`);
    }
  });

  // 6 — backup rules: when a city's owner is off, Mary (or You) should cover it.
  const st = day.status;
  PEOPLE.filter(p => p.role === 'rep' && st[p.id] !== 'work').forEach(rep => {
    homeCities(rep).forEach(gid => {
      const on = day.assign.filter(a => a.group === gid).map(a => a.personId);
      if (!on.includes('maria') && !on.includes('owner')) add('warn', `${rep.name} is ${st[rep.id].toUpperCase()} — Mary (or You) should cover ${GROUP(gid).short}.`);
      else add('ok', `${rep.name} off → ${on.includes('maria') ? 'Mary' : 'You'} covering ${GROUP(gid).short}. ✓`);
    });
  });

  // 7 — escalation note
  if (esc) add('warn', `Mary and Tiffany are both out — full access granted to the remaining rep(s) and You (number/notification separation lifted for today).`);

  return out;
}

/* the on-call backup name for single-coverage windows */
function backupName(d, g) {
  const day = S[d];
  if (day.status.maria === 'work') return 'Mary';
  if (day.status.owner === 'work') return 'You';
  if (day.status.tiffany === 'work') return 'Tiffany';
  return 'no backup available';   // only floaters count as on-call backup; the sole coverer isn't their own backup
}

/* day-level coverage summary for the week grid */
function daySummary(d) {
  const cov = computeCoverage(d);
  let worst = 2;
  GROUPS.forEach(g => cov[g.id].forEach(s => { if (s.length < worst) worst = s.length; }));
  if (worst >= 2) return { cls: 'ok', text: '2+ all day' };
  if (worst === 1) return { cls: 'warn', text: 'single cover' };
  return { cls: 'bad', text: 'gap!' };
}

/* ============================== RENDER ================================= */
function render() {
  renderWeekLabel();
  renderAvail();
  renderWeekGrid();
  renderDayDetail();
  renderBanner();
  renderStatusUI();
}

function renderWeekLabel() {
  const end = addDays(weekStart, 6);
  $('#weekLabel').textContent = `${prettyDate(weekStart)} – ${prettyDate(end)}, ${end.getFullYear()}`;
}

function renderBanner() {
  const b = $('#banner');
  const escDays = DAYS.filter(escalated);
  let worst = null;
  DAYS.forEach(d => { const s = daySummary(d); if (s.cls === 'bad') worst = 'bad'; else if (s.cls === 'warn' && worst !== 'bad') worst = 'warn'; });
  if (worst === 'bad') {
    b.hidden = false; b.className = 'banner bad';
    b.textContent = '⚠ Some city has an uncovered gap this week — open the red day below and assign someone.';
  } else if (escDays.length) {
    b.hidden = false; b.className = 'banner warn';
    b.textContent = `Heads-up: Mary & Tiffany are both out on ${escDays.join(', ')} — full access is granted to the remaining team those days.`;
  } else if (worst === 'warn') {
    b.hidden = false; b.className = 'banner ok';
    b.textContent = '✓ Every city is covered all week. Amber slots are normal lunch/edge windows — the backup is on call.';
  } else {
    b.hidden = false; b.className = 'banner ok';
    b.textContent = '✓ Full two-person coverage on every city, all week.';
  }
}

/* ---- availability table ---- */
function renderAvail() {
  const tbl = $('#availTable');
  const thead = tbl.tHead.rows[0];
  while (thead.cells.length > 2) thead.deleteCell(2);
  DAYS.forEach((d, i) => {
    const th = document.createElement('th');
    th.innerHTML = `${d}<span style="display:block;font-weight:500;color:#94a3b8">${prettyDate(addDays(weekStart, i))}</span>`;
    thead.appendChild(th);
  });

  const tb = tbl.tBodies[0]; tb.innerHTML = '';
  PEOPLE.forEach(p => {
    const tr = el('tr');
    const cities = p.role === 'rep' ? homeCities(p).map(g => GROUP(g).name).join(' · ') : 'Any city (backup)';
    const hrs = takesLunch(p) ? '8-hr day · 1-hr lunch' : (maxWorkMin(p) / 60) + '-hr day · no break';
    tr.appendChild(el('td', 'person-col', `<div class="person-cell"><span class="dot" style="background:${p.color}"></span>${p.name}</div>`));
    tr.appendChild(el('td', 'role-col', `<div class="role-tag">${ROLE_LABEL[p.role]}<span class="cap" style="display:block">${cities}</span><span class="cap" style="display:block;color:#94a3b8">${hrs}</span></div>`));
    DAYS.forEach(d => {
      const td = el('td');
      const seg = el('div', 'status-seg');
      [['work', 'Work'], ['off', 'Off'], ['pto', 'PTO']].forEach(([v, lbl]) => {
        const btn = el('button', S[d].status[p.id] === v ? 'on' : '', lbl);
        btn.dataset.v = v;
        // changing availability re-fills THAT day so the backup rules apply
        // automatically (e.g. Barbara off -> Mary covers Austin/SA).
        btn.onclick = () => { S[d].status[p.id] = v; autoBuildDay(d); persist(); render(); };
        seg.appendChild(btn);
      });
      td.appendChild(seg); tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

/* ---- week grid ---- */
function renderWeekGrid() {
  const grid = $('#weekGrid'); grid.innerHTML = '';
  const todayIso = isoDate(new Date());
  DAYS.forEach((d, i) => {
    const date = addDays(weekStart, i);
    const col = el('div', 'daycol');
    if (isoDate(date) === todayIso) col.classList.add('today');
    if (d === selectedDay) col.classList.add('sel');
    col.appendChild(el('h3', '', `${d}<span class="date">${prettyDate(date)}</span>`));
    col.querySelector('h3').onclick = () => { selectedDay = d; render(); };

    const cov = computeCoverage(d);
    GROUPS.forEach(g => {
      const block = el('div', 'grp-block');
      block.appendChild(el('div', 'grp-title', `<span class="gdot" style="background:${g.color}"></span>${g.short}`));
      const list = S[d].assign.filter(a => a.group === g.id);
      if (!list.length) block.appendChild(el('div', 'empty-mini', 'no one assigned'));
      list.forEach(a => {
        const p = PERSON(a.personId), t = shiftTimes(a);
        const row = el('div', 'assign');
        const isBk = list.indexOf(a) > 0;
        if (isBk) row.classList.add('bk');
        row.innerHTML = `<span class="who"><span class="dot" style="width:7px;height:7px;background:${p.color};display:inline-block;border-radius:50%;margin-right:4px"></span>${p.name}</span>`
          + `<span class="sh">${fmt(t.start)}–${fmt(t.end)}</span>`;
        block.appendChild(row);
      });
      // coverage pill
      const arr = cov[g.id];
      const worst = Math.min(...arr.map(s => s.length));
      const pill = el('div', 'cov-pill ' + (worst >= 2 ? 'ok' : worst === 1 ? 'warn' : 'bad'),
        worst >= 2 ? '✓ 2+ covered' : worst === 1 ? '1 + backup' : '✗ gap');
      block.appendChild(pill);
      col.appendChild(block);
    });
    grid.appendChild(col);
  });
}

/* ---- day detail ---- */
function renderDayDetail() {
  // day picker
  const dp = $('#dayPicker'); dp.innerHTML = '';
  DAYS.forEach(d => {
    const btn = el('button', d === selectedDay ? 'on' : '', d);
    btn.onclick = () => { selectedDay = d; render(); };
    dp.appendChild(btn);
  });

  const host = $('#dayDetail'); host.innerHTML = '';
  const d = selectedDay;
  const cov = computeCoverage(d);
  const issues = validateDay(d);

  GROUPS.forEach(g => {
    const wrap = el('div', 'grp-detail');
    const arr = cov[g.id];
    const worst = Math.min(...arr.map(s => s.length));
    const statusTxt = worst >= 2 ? 'Fully covered' : worst === 1 ? 'Single coverage in spots' : 'HAS A GAP';
    const own = ownerOfCity(g.id);
    const head = el('div', 'gd-head');
    head.style.background = g.color;
    head.innerHTML = `<span class="gd-name">${g.name}</span><span class="gd-cities">${own ? 'Owner: ' + own.name : 'No fixed owner'}</span><span class="gd-status">${statusTxt}</span>`;
    wrap.appendChild(head);

    const body = el('div', 'gd-body');
    body.appendChild(buildTimeline(d, g, arr));
    body.appendChild(buildEditor(d, g));
    wrap.appendChild(body);
    host.appendChild(wrap);
  });

  // warnings / rule checks
  const warnWrap = el('div', 'panel');
  warnWrap.appendChild(el('h3', '', `<span class="ic">✅</span>Coverage rules — ${d}`));
  const warns = el('div', 'warns');
  issues.sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.level] - { bad: 0, warn: 1, ok: 2 }[b.level]));
  issues.forEach(it => warns.appendChild(el('div', 'warn-line ' + it.level,
    `<span>${it.level === 'bad' ? '✗' : it.level === 'warn' ? '!' : '✓'}</span><span>${it.text}</span>`)));
  warnWrap.appendChild(warns);

  // side panels: OpenPhone + leads
  const panels = el('div', 'panels');
  panels.appendChild(buildOpenPhonePanel(d));
  panels.appendChild(buildLeadsPanel(d));

  host.appendChild(warnWrap);
  host.appendChild(panels);
}

function buildTimeline(d, g, arr) {
  const tl = el('div', 'timeline');
  const grid = el('div', 'tl-grid');

  // hour header
  const hours = el('div', 'tl-hours');
  hours.appendChild(el('div', 'corner', 'Schedule'));
  for (let i = 0; i < N_SLOTS; i++) {
    const m = OPEN_MIN + i * SLOT;
    const cell = el('div', 'h' + (m % 60 === 0 ? ' hourstart' : ''), m % 60 === 0 ? fmt(m) : '');
    hours.appendChild(cell);
  }
  grid.appendChild(hours);

  // one row per assignment
  const list = S[d].assign.filter(a => a.group === g.id);
  list.forEach((a, idx) => {
    const p = PERSON(a.personId), t = shiftTimes(a);
    const row = el('div', 'tl-row');
    row.appendChild(el('div', 'tl-name', `<span class="dot" style="background:${p.color}"></span>${p.name}${idx > 0 ? ' <span style="font-size:9px;color:#94a3b8">(2nd)</span>' : ''}`));
    for (let i = 0; i < N_SLOTS; i++) {
      const [s, e] = slotRange(i);
      const cell = el('div', 'cell');
      const inShift = t.start <= s && t.end >= e;
      const onLunch = s < t.lunchEnd && e > t.lunchStart;
      if (inShift && onLunch) cell.classList.add('lunch');
      else if (inShift) { cell.classList.add('work'); cell.style.background = g.color; }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  });

  // coverage row
  const covRow = el('div', 'tl-cov');
  covRow.appendChild(el('div', 'lab', 'Covered'));
  for (let i = 0; i < N_SLOTS; i++) {
    const n = arr[i].length;
    covRow.appendChild(el('div', 'covcell c' + Math.min(n, 2), n));
  }
  grid.appendChild(covRow);

  tl.appendChild(grid);
  return tl;
}

function buildEditor(d, g) {
  const ed = el('div', 'assign-editor');
  const list = S[d].assign.filter(a => a.group === g.id);
  list.forEach((a, idx) => {
    const row = el('div', 'ae-row' + (idx > 0 ? ' bk' : ''));
    const p = PERSON(a.personId);

    // person select
    const sel = el('select');
    PEOPLE.forEach(pp => {
      const o = el('option', '', `${pp.name}${pp.role === 'rep' && !homeCities(pp).includes(g.id) ? ' (other-city owner)' : ''}${S[d].status[pp.id] !== 'work' ? ' — ' + S[d].status[pp.id].toUpperCase() : ''}`);
      o.value = pp.id; if (pp.id === a.personId) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => { a.personId = sel.value; persist(); render(); };

    // shift select — labels show the ACTUAL hours for this person (Tiffany has no
    // lunch + a 9.5h span, so her times differ from the default preset labels).
    const ssel = el('select');
    Object.entries(SHIFTS).forEach(([k, v]) => {
      const tt = shiftTimes({ personId: a.personId, preset: k });
      const baseName = v.label.split('·')[0].trim();
      const o = el('option', '', `${baseName} · ${fmt(tt.start)}–${fmt(tt.end)}${hasLunch(tt) ? '' : ' (no break)'}`);
      o.value = k; if ((a.preset || 'open') === k) o.selected = true;
      ssel.appendChild(o);
    });
    ssel.onchange = () => { a.preset = ssel.value; persist(); render(); };

    row.appendChild(el('span', 'role-pin', idx === 0 ? 'Primary' : '2nd / Backup'));
    row.appendChild(sel);
    row.appendChild(ssel);
    const x = el('button', 'x', '×'); x.title = 'Remove';
    x.onclick = () => { S[d].assign = S[d].assign.filter(z => z.id !== a.id); persist(); render(); };
    row.appendChild(x);
    ed.appendChild(row);
  });

  const add = el('button', 'add-assign', '+ Add person to ' + g.short);
  add.onclick = () => {
    const taken = list.map(a => a.personId);
    const cand = PEOPLE.find(p => !taken.includes(p.id) && (isFlexible(p) || ownsCity(p, g.id)) && S[d].status[p.id] === 'work')
      || PEOPLE.find(p => !taken.includes(p.id));
    S[d].assign.push({ id: newId(), personId: cand ? cand.id : 'owner', group: g.id, preset: list.length ? 'close' : 'open' });
    persist(); render();
  };
  ed.appendChild(add);
  return ed;
}

function buildOpenPhonePanel(d) {
  const esc = escalated(d);
  const panel = el('div', 'panel');
  panel.appendChild(el('h3', '', `<span class="ic">📞</span>OpenPhone numbers & notifications`));
  GROUPS.forEach(g => {
    const block = el('div', 'op-grp');
    block.appendChild(el('div', 'og-title', g.name));
    const people = el('div', 'op-people');
    // who is ON this group's numbers today = anyone assigned to it (+ reps of it),
    // honoring exclusivity unless escalated
    const onIds = new Set(S[d].assign.filter(a => a.group === g.id).map(a => a.personId));
    if (esc) PEOPLE.forEach(p => { if (S[d].status[p.id] === 'work') onIds.add(p.id); });
    if (!onIds.size) { people.appendChild(el('span', 'op-none', '⚠ no one on these numbers')); }
    PEOPLE.forEach(p => {
      if (!onIds.has(p.id)) return;
      const off = S[d].status[p.id] !== 'work';
      people.appendChild(el('span', 'op-tag' + (off ? ' off' : ''), p.name + (off ? ' (out)' : '')));
    });
    block.appendChild(people);
    // exclusivity note — shown once per owning rep (under their first city)
    const reps = PEOPLE.filter(p => ownsCity(p, g.id));
    reps.forEach(r => {
      if (esc || homeCities(r)[0] !== g.id) return;
      const others = GROUPS.filter(x => !homeCities(r).includes(x.id)).map(x => x.short);
      block.appendChild(el('div', 'role-tag', `${r.name} is exclusive to ${homeCities(r).map(c => GROUP(c).short).join(' & ')}${others.length ? ` — removed from ${others.join(', ')} numbers` : ''}.`));
    });
    panel.appendChild(block);
  });
  if (esc) panel.appendChild(el('div', 'warn-line warn', `<span>!</span><span>Mary & Tiffany out — number separation lifted; everyone working has full access today.</span>`));
  return panel;
}

function buildLeadsPanel(d) {
  const panel = el('div', 'panel');
  panel.appendChild(el('h3', '', `<span class="ic">📋</span>Follow-up sheets & lead reports — by city`));
  panel.appendChild(el('div', 'role-tag', 'Missed calls / after-hours go to whoever owns that city and is available — primary first, then the backup.'));
  GROUPS.forEach(g => {
    const list = S[d].assign.filter(a => a.group === g.id).map(a => PERSON(a.personId).name);
    const row = el('div', 'city-row');
    const primary = list[0] || '⚠ unassigned';
    const backup = list[1] || backupName(d, g.id);
    row.innerHTML = `<span class="cname">${g.name}</span><span class="owners">Owner: <b>${primary}</b> · Backup: <b>${backup}</b></span>`;
    panel.appendChild(row);
  });
  return panel;
}

/* ========================= LIVE STATUS & ALERTS ======================== */
let PRESENCE = {};                       // person_id -> { state, updated_at }
let TODAY = null;                        // today's schedule day { status, assign }
const todayKey = () => DAYS[(new Date().getDay() + 6) % 7];
const PRES_STATES = { working: 'Working', break: 'On break', away: 'Stepped away', out: 'Clocked out' };
const isAvailable = st => st === 'working';
const GAP_DELAY_MS = 5000;               // wait before alarming "no coverage" (5s) — brief guard against accidental taps
let _alertedGaps = {}, _gapTimers = {};
let _suppress = {};                      // person_id -> Set of states I just set (so my own changes don't ping me back; a Set so rapid taps like In→Break don't lose the first echo)
// Manager option (default ON): when a person clocks back in, auto-remove any stand-in who was
// ad-hoc covering that person's cities ("I've got it" clears itself once the owner is back).
let AUTO_RELIEVE = (() => { try { return localStorage.getItem('tcs-auto-relieve') !== 'off'; } catch (e) { return true; } })();

async function loadPresence() {
  if (ONLINE && sb) {
    try {
      const { data } = await sb.from('presence').select('*');
      PRESENCE = {}; (data || []).forEach(r => PRESENCE[r.person_id] = { state: r.state, covering: r.covering || null, updated_at: r.updated_at });
    } catch (e) { /* keep cache */ }
  } else {
    try { PRESENCE = JSON.parse(localStorage.getItem('tcs-presence') || '{}'); } catch (e) { PRESENCE = {}; }
  }
}
// expand a day's assignments from any legacy 2-group ids to the new per-city ones
function expandDayLegacy(day) {
  if (!day || !Array.isArray(day.assign)) return day;
  const out = [];
  day.assign.forEach(a => { if (LEGACY[a.group]) LEGACY[a.group].forEach(cid => out.push({ ...a, group: cid })); else out.push(a); });
  return { ...day, assign: out };
}
async function loadToday() {
  if (ONLINE && sb) {
    try {
      const { data } = await sb.from('schedules').select('data').eq('week_start', isoDate(mondayOf(new Date()))).maybeSingle();
      TODAY = (data && data.data) ? expandDayLegacy(data.data[todayKey()]) : null;
    } catch (e) { TODAY = null; }
  } else { TODAY = (S && S[todayKey()]) ? expandDayLegacy(S[todayKey()]) : null; }
}
// set ANY person's live status. Members may only set themselves (DB rule);
// a manager/owner may set anyone — that's "clock in for others / they've got it".
// state = working|break|away|out. covering = a city id (AUS|SAT|DAL|FTW) or null,
// or undefined to leave the current assignment unchanged.
async function setStatus(personId, state, covering) {
  if (!personId) return;
  const prev = PRESENCE[personId] || {};
  const cov = state === 'out' ? null : (covering !== undefined ? covering : (prev.covering || null));
  (_suppress[personId] = _suppress[personId] || new Set()).add(state);   // don't heads-up myself on the realtime echo of my own action
  PRESENCE[personId] = { state, covering: cov, updated_at: new Date().toISOString() };
  if (ONLINE && sb) {
    const stamp = new Date().toISOString();
    // NOTE: supabase upsert returns { error } (it does not throw) — we MUST check it,
    // or a rejected write fails silently and nothing ever syncs.
    let { error } = await sb.from('presence').upsert({ person_id: personId, state, covering: cov, updated_at: stamp });
    if (error && /covering/i.test(error.message || '')) {
      // The API can't see the 'covering' column right now (it exists, but PostgREST's
      // schema cache can be stale for a minute after it's added). Save core status so
      // clock-in still works — but DON'T pretend the city stuck: roll the local covering
      // back to what it was, so the board shows reality (not a value that the realtime
      // echo would then wipe), and tell the manager exactly how to fix it.
      PRESENCE[personId] = { state, covering: (prev.covering || null), updated_at: new Date().toISOString() };
      ({ error } = await sb.from('presence').upsert({ person_id: personId, state, updated_at: stamp }));
      if (!error) flashSync('Saved their status, but the CITY assignment didn’t save — your database needs a quick refresh. In Supabase → SQL editor run:  notify pgrst, \'reload schema\';  then try adding them again.', true);
    }
    if (error) flashSync('Could not save status: ' + (error.message || 'unknown error'), true);
  } else {
    try { localStorage.setItem('tcs-presence', JSON.stringify(PRESENCE)); } catch (e) {}
  }
  renderStatusUI(); evaluateGaps();            // self-initiated: refresh + re-check coverage, no self heads-up
  // if I (a manager) just clocked someone back IN, relieve stand-ins on their cities now —
  // the optimistic update above would otherwise hide the transition from the realtime echo.
  if (state === 'working' && !isAvailable(prev.state)) autoRelieveCoverers(personId);
}
function setMyStatus(state) { if (ME && ME.personId) setStatus(ME.personId, state); }

// covering can be MULTIPLE cities (comma-joined): covering one city must NOT drop the others.
const coveringSet = pid => [...new Set(((PRESENCE[pid] || {}).covering || '').split(',').map(s => s.trim()).filter(Boolean).flatMap(c => LEGACY[c] || [c]))];
const coveringStr = arr => arr.length ? [...new Set(arr)].join(',') : null;
const coveringNames = pid => coveringSet(pid).map(g => GROUP(g) ? GROUP(g).short : g).join(' & ');
function addCovering(personId, cityId) {        // ADD a city to what they already cover (keeps existing ones)
  const set = coveringSet(personId); if (!set.includes(cityId)) set.push(cityId);
  setStatus(personId, 'working', coveringStr(set));
}

// who is responsible for a city today, and who of them is actively working now
function liveCityStatus(gid) {
  const planned = TODAY ? TODAY.assign.filter(a => a.group === gid).map(a => a.personId) : [];
  const adhoc = PEOPLE.filter(p => coveringSet(p.id).includes(gid)).map(p => p.id);  // anyone covering this city ad-hoc
  const assigned = [...new Set([...planned, ...adhoc])];
  const working = assigned.filter(pid => isAvailable((PRESENCE[pid] || {}).state));
  return { assigned, working };
}
const canCover = (pid, gid) => { const p = PERSON(pid); return !!p && (isFlexible(p) || ownsCity(p, gid)); };
function withinHours() { const n = new Date(); const m = n.getHours() * 60 + n.getMinutes(); return m >= OPEN_MIN && m < CLOSE_MIN; }
// cities a person is responsible for right now (today's plan + any live ad-hoc assignment)
function personCitiesNow(pid) { return GROUPS.filter(g => liveCityStatus(g.id).assigned.includes(pid)).map(g => g.id); }
function isTodayCurrentWeek(dayKey) { return dayKey === todayKey() && isoDate(weekStart) === isoDate(mondayOf(new Date())); }

function beep() {
  try {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.07;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 320);
  } catch (e) {}
}
function osNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification(title, { body, requireInteraction: true, tag: 'tcs-' + Math.floor(performance.now()), renotify: false });
  } catch (e) {}
}
function alertHost() { return $(ME && ME.role === 'member' ? '#mAlerts' : '#gAlerts'); }
function showAlert(html, urgent, actions) {        // actions: [{ label, fn }]
  const host = alertHost(); if (!host) return;
  const box = el('div', 'alert-card ' + (urgent ? 'urgent' : 'info'));
  box.appendChild(el('div', 'ac-msg', html));
  if (actions && actions.length) {
    const row = el('div', 'ac-actions');
    actions.forEach(a => { const b = el('button', 'alert-act', a.label); b.onclick = () => { if (a.fn) a.fn(); box.remove(); }; row.appendChild(b); });
    box.appendChild(row);
  }
  const x = el('button', 'alert-x', '×'); x.onclick = () => box.remove(); box.appendChild(x);
  host.prepend(box);
  if (urgent) beep();
}

const firstName = p => p.name.replace(' (Owner)', '');
function fireGapAlert(g) {
  if (!ME || !ME.personId) return;
  // EMERGENCY: a city dropped to nobody. Alert EVERYONE (even people not assigned here)
  // so anyone can jump in, and let the managers mark who's picking it up.
  osNotify('⚠ Coverage needed', `${g.name} has no one on right now.`);
  const actions = [{ label: "I'll cover it", fn: () => addCovering(ME.personId, g.id) }];
  if (ME.role === 'manager') {
    PEOPLE.filter(p => p.id !== ME.personId && !isAvailable((PRESENCE[p.id] || {}).state))
      .forEach(p => actions.push({ label: `${firstName(p)} has it`, fn: () => addCovering(p.id, g.id) }));
  }
  showAlert(`⚠ <b>${g.name}</b> has <b>no one covering</b> right now — anyone can jump in.`, true, actions);
}
function evaluateGaps() {
  GROUPS.forEach(g => {
    const s = liveCityStatus(g.id);
    const gap = withinHours() && s.assigned.length > 0 && s.working.length === 0;
    if (gap && !_alertedGaps[g.id] && !_gapTimers[g.id]) {
      _gapTimers[g.id] = setTimeout(() => {
        _gapTimers[g.id] = null;
        const s2 = liveCityStatus(g.id);
        if (withinHours() && s2.assigned.length > 0 && s2.working.length === 0) { _alertedGaps[g.id] = true; fireGapAlert(g); }
      }, GAP_DELAY_MS);
    }
    if (!gap) { _alertedGaps[g.id] = false; if (_gapTimers[g.id]) { clearTimeout(_gapTimers[g.id]); _gapTimers[g.id] = null; } }
  });
}
// When `returningPid` clocks back in, drop anyone who was AD-HOC covering the cities that
// person is responsible for (their plan today or the cities they own). Runs on MANAGER
// clients only (they can write any row) and only when the AUTO_RELIEVE option is on.
function autoRelieveCoverers(returningPid) {
  if (!AUTO_RELIEVE || !isManager() || !ME) return;
  const R = PERSON(returningPid); if (!R) return;
  if (!isAvailable((PRESENCE[returningPid] || {}).state)) return;          // only when they're actually back
  const rCities = GROUPS.filter(g =>
    (TODAY && TODAY.assign.some(a => a.group === g.id && a.personId === returningPid)) || ownsCity(R, g.id)
  ).map(g => g.id);
  if (!rCities.length) return;
  PEOPLE.forEach(C => {
    if (C.id === returningPid) return;
    const cov = coveringSet(C.id);
    // only drop cities that are genuinely AD-HOC for C (not their own home, not their plan)
    const drop = cov.filter(x => rCities.includes(x)
      && !homeCities(C).includes(x)
      && !(TODAY && TODAY.assign.some(a => a.group === x && a.personId === C.id)));
    if (!drop.length) return;
    const keep = cov.filter(x => !drop.includes(x));
    setStatus(C.id, (PRESENCE[C.id] || {}).state || 'working', coveringStr(keep));
    const dropNames = drop.map(x => GROUP(x) ? GROUP(x).short : x).join(' & ');
    showAlert(`✅ ${firstName(C)} auto-removed from <b>${dropNames}</b> — ${firstName(R)} is back on.`, false);
  });
}
function onPresenceChange(payload) {
  const row = payload && (payload.new || payload.old);
  if (!row) { renderStatusUI(); evaluateGaps(); return; }
  const pid = row.person_id, old = PRESENCE[pid] || {};
  const st = payload.new ? payload.new.state : 'out';
  const cov = payload.new ? (payload.new.covering || null) : null;
  PRESENCE[pid] = payload.new ? { state: st, covering: cov, updated_at: payload.new.updated_at } : { state: 'out', covering: null };
  if (ME && ME.role === 'member') renderMember(); else renderStatusUI();

  const suppressed = !!(_suppress[pid] && _suppress[pid].has(st));
  if (suppressed) _suppress[pid].delete(st);

  const warnTeam = (cities, title, msgState, urgent) => {   // notify that city's team + managers
    const who = PERSON(pid);
    const iAmManager = ME.role === 'manager';
    const iAmTeammate = ME.personId && cities.some(c => liveCityStatus(c).assigned.includes(ME.personId));
    if (!(iAmManager || iAmTeammate)) return;
    const cn = cities.map(c => GROUP(c).short).join(' & ') || 'their city';
    osNotify(title, `${who ? who.name : pid} ${msgState}.`);
    showAlert(`<b>${who ? who.name : pid}</b> ${msgState} — <b>${cn}</b>.`, !!urgent);
  };

  // directed: my covering set changed -> tell me which cities I'm now ON (UNMUTE them in
  // OpenPhone) or OFF (you can re-mute). Spells out "you are covering what".
  if (ME && pid === ME.personId && !suppressed) {
    const oldSet = (old.covering || '').split(',').map(s => s.trim()).filter(Boolean).flatMap(c => LEGACY[c] || [c]);
    const nowSet = coveringSet(ME.personId);
    const added = nowSet.filter(c => !oldSet.includes(c));
    const removed = oldSet.filter(c => !nowSet.includes(c));
    const myName = PERSON(ME.personId) ? firstName(PERSON(ME.personId)) : 'You';
    if (added.length) {
      const names = added.map(g => GROUP(g) ? GROUP(g).name : g).join(' & ');
      const short = added.map(g => GROUP(g) ? GROUP(g).short : g).join(' & ');
      osNotify(`📍 ${myName}: cover ${short}`, `${myName}, you're now covering ${names}. Unmute these numbers in OpenPhone.`);
      showAlert(`📍 <b>${myName}</b>, you're now <b>covering ${names}</b> — <b>unmute ${names} in OpenPhone</b> so you get their calls & texts, then tap “On it”.`, true, [{ label: 'On it', fn: () => setMyStatus('working') }]);
    }
    if (removed.length) {
      const names = removed.map(g => GROUP(g) ? GROUP(g).name : g).join(' & ');
      osNotify(`✅ ${myName}: off ${names}`, `${myName}, you're off ${names} — you can mute those numbers again.`);
      showAlert(`✅ <b>${myName}</b>, you're <b>off ${names}</b> now — you can <b>mute ${names} in OpenPhone</b> again.`, false);
    }
  }
  if (ME && pid !== ME.personId && !suppressed) {
    // someone stopped working -> warn their city's team + managers
    if (!isAvailable(st)) warnTeam(personCitiesNow(pid), 'Heads-up', `is now ${(PRES_STATES[st] || st).toLowerCase()} — coverage may be needed`, false);
    // someone clocked in / came back -> let the team + managers know coverage is restored
    else if (!isAvailable(old.state)) warnTeam(personCitiesNow(pid), 'Back on', 'just clocked in / is back on', false);
  }
  // when someone clocks back IN, auto-clear any stand-in who was ad-hoc covering their cities
  if (isAvailable(st) && !isAvailable(old.state)) autoRelieveCoverers(pid);
  evaluateGaps();
}

function notifButton() {
  if (!('Notification' in window) || Notification.permission === 'granted') return null;
  const b = el('button', 'btn ghost small notif-btn', '🔔 Turn on pop-up alerts');
  b.onclick = () => { try { Notification.requestPermission().then(() => renderStatusUI()); } catch (e) {} };
  return b;
}
// One-click diagnostic: proves pop-ups, OS notifications, and the realtime round-trip
// from THIS logged-in device. Run it on two devices to confirm cross-device delivery.
function runSelfTest() {
  const host = alertHost(); if (!host) return;
  const box = el('div', 'alert-card info selftest');
  const body = el('div', 'ac-msg'); box.appendChild(body);
  const x = el('button', 'alert-x', '×'); x.onclick = () => box.remove(); box.appendChild(x);
  host.prepend(box);
  const lines = []; const add = s => { lines.push(s); body.innerHTML = '<b>🧪 Self-test</b><br>' + lines.join('<br>'); };
  (async () => {
    if ('Notification' in window) {
      if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) {} }
      add('Browser notifications: ' + (Notification.permission === 'granted' ? 'ON ✓' : Notification.permission === 'denied' ? 'BLOCKED ✗ — turn on in your browser’s site settings' : 'not enabled'));
    } else add('Browser notifications: not supported on this browser');
    osNotify('🧪 Test notification', 'If this showed as a system notification, OS alerts work.');
    beep();
    add('On-screen pop-up: this box IS the pop-up ✓');
    add('Live connection: ' + (RT_STATUS === 'SUBSCRIBED' ? 'connected ✓' : RT_STATUS + ' ✗'));
    if (!(ONLINE && sb && ME && ME.personId)) { add('(local mode — live round-trip not applicable)'); return; }
    add('Live round-trip: testing…');
    let writeErr = null;
    const got = await new Promise(resolve => {
      let done = false;
      const ch = sb.channel('selftest-' + Math.floor(performance.now()))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'presence', filter: 'person_id=eq.' + ME.personId },
          () => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (e) {} resolve(true); } })
        .subscribe(async (st) => {
          if (st !== 'SUBSCRIBED') return;
          (_suppress[ME.personId] = _suppress[ME.personId] || new Set()).add('working');
          PRESENCE[ME.personId] = { state: 'working', covering: (PRESENCE[ME.personId] || {}).covering || null, updated_at: new Date().toISOString() };
          renderStatusUI();
          // minimal columns only — proves write+realtime independent of the optional 'covering' column
          const { error } = await sb.from('presence').upsert({ person_id: ME.personId, state: 'working', updated_at: new Date().toISOString() });
          if (error && !done) { writeErr = error.message; done = true; try { sb.removeChannel(ch); } catch (e) {} resolve(false); }
        });
      setTimeout(() => { if (!done) { done = true; try { sb.removeChannel(ch); } catch (e) {} resolve(false); } }, 7000);
    });
    if (writeErr) { add('Save your status: FAILED ✗ — ' + writeErr); return; }
    add('Save your status: ok ✓ (you’re now marked Working)');
    add('Live round-trip: ' + (got ? 'event received ✓' : 'NO event in 7s ✗'));
    add(got ? '<b style="color:#16a34a">✅ Everything works on this device.</b>'
            : '<b style="color:#dc2626">❌ Realtime isn’t delivering to this device — refresh; if it persists, tell your developer.</b>');
  })();
}

async function testSms() {
  if (!(ONLINE && sb)) { flashSync('Text alerts require the online app.', true); return; }
  flashSync('Sending a test text to the alert number…', false);
  try {
    const { data, error } = await sb.functions.invoke('coverage-sms', { body: { test: true } });
    if (error) flashSync('Test text FAILED: ' + (error.message || error) + ' — is the “coverage-sms” function deployed? (see DEPLOY-SMS.md)', true);
    else flashSync('Test text sent ✓ — check the phone.', false);
  } catch (e) { flashSync('Test text error: ' + (e.message || e), true); }
}

const rtLive = () => ONLINE ? (RT_STATUS === 'SUBSCRIBED' ? '<span class="rt-ind ok">● live</span>' : '<span class="rt-ind bad">● not connected</span>') : '';
function statusBar() {
  const pr = PRESENCE[ME.personId] || {}, my = pr.state || 'out';
  const wrap = el('div', 'status-bar state-' + my);
  // login not linked to a person -> buttons would do nothing; say so instead of failing silently
  if (ONLINE && !ME.personId) {
    wrap.appendChild(el('div', 'status-now', `Your login isn’t linked to a team member yet ${rtLive()}`));
    const t0 = el('button', 'test-btn', '🧪 Test alerts'); t0.onclick = runSelfTest; wrap.appendChild(t0);
    return wrap;
  }
  let now = `Your status: <b>${PRES_STATES[my] || my}</b>`;
  if (coveringSet(ME.personId).length && isAvailable(my)) now += ` · covering <b>${coveringNames(ME.personId)}</b>`;
  now += ' ' + rtLive();
  wrap.appendChild(el('div', 'status-now', now));
  // persistent reminder: while you're covering an ad-hoc city, keep its OpenPhone unmuted
  const _cov = coveringSet(ME.personId);
  if (_cov.length && isAvailable(my)) {
    wrap.appendChild(el('div', 'unmute-reminder', `🔔 Covering <b>${coveringNames(ME.personId)}</b> — make sure ${_cov.length > 1 ? 'these are' : 'it’s'} <b>unmuted in OpenPhone</b> so you get their calls &amp; texts.`));
  }
  const btns = el('div', 'status-btns');
  const mk = (state, label, cls) => { const b = el('button', 'sbtn ' + cls + (my === state ? ' on' : ''), label); b.onclick = () => setMyStatus(state); return b; };
  btns.appendChild(mk('working', 'Clock in / Back', 'go'));
  btns.appendChild(mk('break', 'Break / Lunch', 'amber'));
  btns.appendChild(mk('away', 'Step away', 'amber'));
  btns.appendChild(mk('out', 'Clock out', 'out'));
  wrap.appendChild(btns);
  const t = el('button', 'test-btn', '🧪 Test alerts'); t.onclick = runSelfTest; wrap.appendChild(t);
  if (ME.role === 'manager') { const ts = el('button', 'test-btn', '✉️ Test text'); ts.onclick = testSms; wrap.appendChild(ts); }
  return wrap;
}
function renderBoard() {
  const host = $('#gBoard'); if (!host) return; host.innerHTML = '';
  GROUPS.forEach(g => {
    const s = liveCityStatus(g.id);
    const cls = s.working.length >= 2 ? 'ok' : s.working.length === 1 ? 'warn' : 'bad';
    const names = s.working.length ? s.working.map(p => PERSON(p).name).join(', ') : 'NO ONE ON';
    const row = el('div', 'board-city ' + cls);
    row.innerHTML = `<span class="bc-dot"></span><span class="bc-name">${g.name}</span><span class="bc-count">${s.working.length} working now</span><span class="bc-who">${names}</span>`;
    // assign someone to cover this city right now -> they get notified + start counting here
    const sel = el('select', 'cover-sel');
    sel.appendChild(el('option', '', '＋ Add someone to cover…'));
    PEOPLE.filter(p => !coveringSet(p.id).includes(g.id))   // EVERYONE not already covering this city
      .forEach(p => { const o = el('option', '', firstName(p)); o.value = p.id; sel.appendChild(o); });
    sel.querySelector('option').value = '';
    sel.onchange = () => {
      const pid = sel.value; sel.value = '';
      if (!pid) return;
      const p = PERSON(pid);
      // ADD this city (keeps any city they're already covering)
      if (confirm(`Add ${p ? p.name : pid} to cover ${g.name} now?\nThey'll be marked working and notified — this does NOT remove them from any other city.`)) addCovering(pid, g.id);
    };
    row.appendChild(sel);
    host.appendChild(row);
  });
  host.appendChild(el('div', 'board-sub', 'Set anyone’s status (clock them in, send to break, etc.):'));
  const ppl = el('div', 'board-people');
  PEOPLE.forEach(p => {
    const pr = PRESENCE[p.id] || {}, st = pr.state || 'out';
    const covTag = coveringSet(p.id).length && isAvailable(st) ? ` · <span class="bp-cov">covering ${coveringNames(p.id)}</span>` : '';
    const row = el('div', 'bp-row state-' + st);
    row.appendChild(el('div', 'bp-name', `<span class="bp-dot"></span>${p.name} <span class="bp-state">· ${PRES_STATES[st] || st}</span>${covTag}`));
    const ctl = el('div', 'bp-ctl');
    const mk = (state, label) => { const b = el('button', 'mini' + (st === state ? ' on' : ''), label); b.onclick = () => setStatus(p.id, state); return b; };
    ctl.appendChild(mk('working', 'In'));
    ctl.appendChild(mk('break', 'Break'));
    ctl.appendChild(mk('away', 'Away'));
    ctl.appendChild(mk('out', 'Out'));
    row.appendChild(ctl);
    ppl.appendChild(row);
  });
  host.appendChild(ppl);
  // manager option: auto-remove a stand-in once the person they covered clocks back in
  const opt = el('label', 'auto-relieve-opt');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = AUTO_RELIEVE;
  cb.onchange = () => { AUTO_RELIEVE = cb.checked; try { localStorage.setItem('tcs-auto-relieve', cb.checked ? 'on' : 'off'); } catch (e) {} };
  opt.appendChild(cb);
  opt.appendChild(el('span', '', 'Auto-remove a stand-in when the person they covered clocks back in'));
  host.appendChild(opt);
}
// prominent "turn on notifications" banner — shown until the person enables them
function renderNotifPrompt(host) {
  if (!host) return; host.innerHTML = '';
  if (!('Notification' in window) || Notification.permission === 'granted') return;
  const card = el('div', 'notif-prompt');
  if (Notification.permission === 'denied') {
    card.classList.add('blocked');
    card.appendChild(el('div', 'np-msg', '🔕 Notifications are blocked for this page. Turn them on in your browser’s settings for this site, then reload.'));
  } else {
    card.appendChild(el('div', 'np-msg', '🔔 <b>Turn on notifications</b> so you get a pop-up and a sound the moment coverage is needed.'));
    const b = el('button', 'btn primary', 'Turn on notifications');
    b.onclick = () => { try { Notification.requestPermission().then(() => renderStatusUI()); } catch (e) {} };
    card.appendChild(b);
  }
  host.appendChild(card);
}

/* ---- team access (owner promotes/demotes managers) ---- */
let PROFILES = [];
async function loadProfiles() {
  PROFILES = [];
  if (!(ONLINE && sb) || !(ME && ME.personId === 'owner')) return;
  try { const { data } = await sb.from('profiles').select('person_id, email, role'); PROFILES = data || []; } catch (e) {}
}
async function setRole(personId, role) {
  if (!(ONLINE && sb)) return;
  try {
    const { error } = await sb.from('profiles').update({ role }).eq('person_id', personId);
    if (error) flashSync('Could not change access: ' + error.message, true);
    else { flashSync('Access updated ✓', false); await loadProfiles(); renderTeamAccess(); }
  } catch (e) { flashSync('Could not change access — check your connection.', true); }
}
function renderTeamAccess() {
  const card = $('#accessCard'), host = $('#gAccess');
  if (!card || !host) return;
  const owner = ME && ME.personId === 'owner';
  card.hidden = !owner;
  if (!owner) return;
  host.innerHTML = '';
  if (!ONLINE) { host.appendChild(el('div', 'hint', 'Available once the app is online with logins.')); return; }
  if (!PROFILES.length) { host.appendChild(el('div', 'hint', 'No logins loaded. If this stays empty, run <b>access-setup.sql</b> in Supabase to turn this on.')); return; }
  PROFILES.slice().sort((a, b) => a.person_id === 'owner' ? -1 : b.person_id === 'owner' ? 1 : (a.person_id > b.person_id ? 1 : -1)).forEach(pr => {
    const person = PERSON(pr.person_id), name = person ? person.name : (pr.email || pr.person_id || 'Unknown');
    const row = el('div', 'access-row');
    row.appendChild(el('div', 'ar-name', `${name}${pr.email ? ` <span class="ar-email">${pr.email}</span>` : ''}`));
    const seg = el('div', 'seg');
    [['member', 'Member'], ['manager', 'Manager']].forEach(([r, label]) => {
      const b = el('button', 'seg-btn' + (pr.role === r ? ' on' : ''), label);
      if (pr.person_id === 'owner') b.disabled = true;      // the owner can't be changed
      else b.onclick = () => setRole(pr.person_id, r);
      seg.appendChild(b);
    });
    row.appendChild(seg);
    host.appendChild(row);
  });
}

function renderStatusUI() {
  const live = $('#liveCard');
  if (!ME) { if (live) live.hidden = true; const ac = $('#accessCard'); if (ac) ac.hidden = true; return; }   // local single-user
  if (ME.role === 'member') {
    const host = $('#mStatus'); if (host) { host.innerHTML = ''; host.appendChild(statusBar()); }
    renderNotifPrompt($('#mNotif'));
  } else {
    if (live) live.hidden = false;
    renderBoard();
    const host = $('#gOwnerStatus'); if (host) { host.innerHTML = ''; host.appendChild(statusBar()); }
    renderNotifPrompt($('#gNotif'));
    renderTeamAccess();
  }
}

/* ----------------------------- EVENTS ---------------------------------- */
function bind() {
  const go = async fn => { fn(); await loadWeek(); render(); };
  $('#prevWeek').onclick = () => go(() => { weekStart = addDays(weekStart, -7); });
  $('#nextWeek').onclick = () => go(() => { weekStart = addDays(weekStart, 7); });
  $('#thisWeek').onclick = () => go(() => { weekStart = mondayOf(new Date()); });
  $('#autoBtn').onclick = () => { if (confirm('Auto-build the whole week from current availability? This replaces the current assignments.')) { autoBuildAll(); render(); } };
  $('#resetBtn').onclick = () => { if (confirm('Reset this week to a blank schedule (everyone Working, then auto-built)?')) { S = {}; DAYS.forEach(x => S[x] = blankDay()); autoBuildAll(); render(); } };
  $('#printBtn').onclick = () => window.print();
  $('#gSignOut').onclick = doSignOut;
}
function bindMember() {
  const go = async fn => { fn(); await loadWeek(); renderMember(); };
  $('#mPrevWeek').onclick = () => go(() => { weekStart = addDays(weekStart, -7); });
  $('#mNextWeek').onclick = () => go(() => { weekStart = addDays(weekStart, 7); });
  $('#mThisWeek').onclick = () => go(() => { weekStart = mondayOf(new Date()); });
  $('#mSignOut').onclick = doSignOut;
}
function bindAuth() {
  const form = $('#loginForm');
  if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    if (!sb) return;
    const email = $('#loginEmail').value.trim(), password = $('#loginPass').value;
    const errBox = $('#loginErr'), btn = $('#loginBtn');
    errBox.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) { errBox.hidden = false; errBox.textContent = error.message; }   // success → onAuthStateChange
  };
}

/* notification strip (save status / errors) */
function flashSync(msg, isError) {
  const n = $('#syncNote'); if (!n) return;
  n.textContent = msg; n.className = 'sync-note ' + (isError ? 'err' : 'ok'); n.hidden = false;
  clearTimeout(flashSync._t); flashSync._t = setTimeout(() => { n.hidden = true; }, isError ? 6000 : 2200);
}

/* --------------------------- AUTH / ROUTING ---------------------------- */
function showScreen(which) {
  $('#loginScreen').hidden = which !== 'login';
  $('#managerApp').hidden = which !== 'manager';
  $('#memberApp').hidden = which !== 'member';
  if (which === 'manager') {
    $('#gWho').textContent = ONLINE && ME ? (PERSON(ME.personId)?.name || ME.email) + ' · Manager' : '';
    $('#gSignOut').hidden = !ONLINE;
    $('#footNote').textContent = ONLINE
      ? 'Saved to the shared schedule — your team sees changes live.'
      : 'Running locally — saved in this browser only.';
  }
}
async function doSignOut() { if (sb) await sb.auth.signOut(); ME = null; showScreen('login'); }

async function resolveProfile(user) {
  try {
    const { data } = await sb.from('profiles').select('person_id, role').eq('id', user.id).maybeSingle();
    if (data) return { personId: data.person_id, role: data.role || 'member', email: user.email };
  } catch (e) { /* no profile */ }
  return { personId: null, role: 'member', email: user.email };
}
async function enter(session) {
  const user = session.user || session;
  // CRITICAL: hand the auth JWT to the realtime socket BEFORE subscribing, or
  // postgres_changes events are RLS-filtered to nothing and the client gets no
  // live updates at all (no pop-ups, no flagging).
  try { if (session && session.access_token) sb.realtime.setAuth(session.access_token); } catch (e) {}
  ME = await resolveProfile(user);
  subscribeRealtime();
  await loadToday(); await loadPresence();
  if (ME.personId === 'owner') await loadProfiles();
  if (ME.role === 'manager') { showScreen('manager'); await loadWeek(); render(); }
  else { showScreen('member'); await loadWeek(); renderMember(); }
  renderStatusUI(); evaluateGaps();
}

// Catch-up re-fetch: realtime events missed while the tab was backgrounded or the
// socket was down are NEVER replayed, so on wake/reconnect we re-pull live state.
// Without this, a phone user returning to the app can see a stale board under a
// green "● live" dot (supabase-js reconnects silently after the OS kills the socket).
let _refreshing = false;
async function refreshLive() {
  if (!ONLINE || !sb || !ME || _refreshing) return;
  _refreshing = true;
  try {
    await loadToday(); await loadPresence();
    if (ME.role === 'member') renderMember(); else renderStatusUI();
    evaluateGaps();
  } catch (e) { /* next event or manual reload will heal */ }
  finally { _refreshing = false; }
}
try {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshLive();
  });
} catch (e) { /* non-browser environment */ }

let _rt = null, RT_STATUS = 'connecting', _rtWasDown = false;
function subscribeRealtime() {
  if (!ONLINE || _rt) return;
  _rt = sb.channel('tcs-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules' }, async () => {
      await loadWeek(); await loadToday(); isManager() ? render() : renderMember(); evaluateGaps();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, (payload) => onPresenceChange(payload))
    .subscribe((status) => {
      RT_STATUS = status;
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
        flashSync('Live updates aren’t connecting — alerts may be delayed. Try refreshing the page.', true);
      if (status !== 'SUBSCRIBED') _rtWasDown = true;
      else if (_rtWasDown) { _rtWasDown = false; refreshLive(); }   // reconnected -> catch up on missed events
      renderStatusUI();
    });
}

/* local-only preview of the member view: index.html?preview=member&as=tiffany */
function previewOverride() {
  const q = new URLSearchParams(location.search), pv = q.get('preview');
  if (pv === 'member') { ME = { personId: q.get('as') || 'barbara', role: 'member', email: 'preview' }; return true; }
  if (pv === 'owner' || pv === 'manager') { ME = { personId: 'owner', role: 'manager', email: 'preview' }; return true; }
  return false;
}

/* ----------------------------- MEMBER VIEW ----------------------------- */
function renderMember() {
  const p = PERSON(ME.personId);
  $('#memberHi').textContent = p ? `Hi, ${p.name.replace(' (Owner)', '')}` : 'Your week';
  $('#mWho').textContent = p ? p.name : (ME.email || '');
  const end = addDays(weekStart, 6);
  $('#mWeekLabel').textContent = `${prettyDate(weekStart)} – ${prettyDate(end)}, ${end.getFullYear()}`;
  renderStatusUI();   // status bar always shows, even if no schedule posted

  const host = $('#memberMain'); host.innerHTML = '';
  const card = (title, hint) => { const c = el('section', 'card'); c.appendChild(el('div', 'card-head', `<h2>${title}</h2>${hint ? `<p class="hint">${hint}</p>` : ''}`)); return c; };

  if (ONLINE && !weekPublished) { host.appendChild(card('Not posted yet', 'Your manager hasn’t published this week’s schedule. Check back soon, or use ‹ › to view another week.')); return; }
  if (!p) { host.appendChild(card('Welcome', 'Your login isn’t linked to a team member yet. Ask your manager to finish setup.')); return; }

  const wrap = card('Your shifts this week', takesLunch(p)
    ? 'Read-only. Each shift includes a 1-hour lunch in the middle — your city is covered while you’re out.'
    : `Read-only. You work a ${maxWorkMin(p) / 60}-hour day with no scheduled break.`);
  const list = el('div', 'member-days');
  DAYS.forEach((d, i) => {
    const day = S[d], mine = day.assign.filter(a => a.personId === ME.personId);
    const c = el('div', 'mday');
    c.appendChild(el('div', 'mday-h', `${d} <span>${prettyDate(addDays(weekStart, i))}</span>`));
    if (!mine.length) {
      const st = day.status[ME.personId];
      const txt = st === 'off' ? 'Off' : st === 'pto' ? 'PTO' : 'Not scheduled';
      c.appendChild(el('div', 'mday-off ' + (st === 'pto' ? 'pto' : 'off'), txt));
    } else {
      // Group the member's assignments by shift so the cities they cover on the
      // same hours (e.g. Barbara on Austin + San Antonio) show as ONE card that
      // lists every city — that's how the 4-city split reflects in their portal.
      const shifts = {};
      mine.forEach(a => {
        const g = GROUP(a.group); if (!g) return;
        const t = shiftTimes(a);
        const key = `${t.start}-${t.end}-${t.lunchStart}-${t.lunchEnd}`;
        if (!shifts[key]) shifts[key] = { t, cities: [] };
        shifts[key].cities.push(g);
      });
      Object.values(shifts).forEach(({ t, cities }) => {
        const cityNames = cities.map(g => g.name).join(' · ');
        const primary = cities[0];
        // Only surface coverage info when a teammate on one of MY cities is away/out
        // today — then show who's covering (no static "on with" otherwise).
        let liveRow = '';
        if (isTodayCurrentWeek(d)) {
          const coveringNow = new Set(); let teammateAway = false;
          cities.forEach(g => {
            const ls = liveCityStatus(g.id);
            if (ls.assigned.some(id => id !== ME.personId && !isAvailable((PRESENCE[id] || {}).state))) teammateAway = true;
            ls.working.filter(id => id !== ME.personId).forEach(id => coveringNow.add(PERSON(id).name));
          });
          if (teammateAway) {
            liveRow = coveringNow.size
              ? `<div class="ms-row cover"><b>Covering now</b><span>${[...coveringNow].join(', ')}</span></div>`
              : `<div class="ms-row cover bad"><b>Coverage</b><span>needs someone — manager alerted</span></div>`;
          }
        }
        const b = el('div', 'mday-shift'); b.style.borderLeftColor = primary.color;
        b.innerHTML =
          `<div class="ms-city" style="color:${primary.color}">${cityNames}</div>` +
          `<div class="ms-row"><b>Hours</b><span>${fmt(t.start)}–${fmt(t.end)}</span></div>` +
          `<div class="ms-row"><b>Lunch</b><span>${hasLunch(t) ? fmt(t.lunchStart) + '–' + fmt(t.lunchEnd) : 'No break (' + (maxWorkMin(p) / 60) + '-hr day)'}</span></div>` +
          liveRow +
          `<div class="ms-row"><b>Follow-ups &amp; leads</b><span>${cityNames}</span></div>`;
        c.appendChild(b);
      });
    }
    list.appendChild(c);
  });
  wrap.appendChild(list);
  host.appendChild(wrap);
}

/* ------------------------------ INIT ----------------------------------- */
async function boot() {
  bind(); bindMember(); bindAuth();
  if (!ONLINE) {                                   // local single-user / preview mode
    await loadWeek();
    if (previewOverride()) {
      await loadToday(); await loadPresence();
      if (ME.role === 'member') { showScreen('member'); renderMember(); }
      else { showScreen('manager'); render(); }
      renderStatusUI(); evaluateGaps();
    } else { ME = null; showScreen('manager'); render(); }
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(session); else showScreen('login');
  sb.auth.onAuthStateChange((_e, sess) => {
    if (sess) { try { sb.realtime.setAuth(sess.access_token); } catch (e) {} if (!ME) enter(sess); }
    else { ME = null; showScreen('login'); }
  });
}
boot();
