/* =============================================================================
   TCS Coverage Scheduler — shared rules engine (ONE source of truth).

   The SAME file runs in the browser app, in the Supabase Edge Functions (Deno)
   and in the Node test suite: a plain ES module with no imports and no DOM.
   It owns: the team setup (people, cities, OpenPhone SALES lines, default week,
   switches), building a day's schedule, the coverage checks, who is on a city
   right now, automatic break handoff / pickup / relief, every text message,
   which calls count as missed, the activity feed and the end-of-day report.

   Times are minutes past midnight, Central time (America/Chicago).
   NEVER change a person's or city's id: ids link logins, live status and saved weeks.
   ============================================================================= */

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const LEGACY = { G1: ['AUS', 'SAT'], G2: ['DAL', 'FTW'] };   // pre-split 2-group ids
export const OPEN_MIN = 8 * 60;     // coverage window 8:00 AM …
export const CLOSE_MIN = 18 * 60;   // … to 6:00 PM
export const SLOT = 30;
export const N_SLOTS = (CLOSE_MIN - OPEN_MIN) / SLOT;
export const TEAM_VERSION = 2;      // bumped when the staffing model changes (see upgradeTeam)
export const GRACE_MS = 6000;       // a break undone within this long was an accidental tap

/* Shift presets: 8 working hours + a 1-hour lunch 3 hours in (no-break people work straight through). */
export const SHIFTS = {
  open:  { label: 'Opener', start: 480, end: 1020, lunchStart: 660, lunchEnd: 720 },  // 8–5, lunch 11–12
  close: { label: 'Closer', start: 540, end: 1080, lunchStart: 720, lunchEnd: 780 },  // 9–6, lunch 12–1
  mid:   { label: 'Mid',    start: 510, end: 1050, lunchStart: 690, lunchEnd: 750 },  // 8:30–5:30, lunch 11:30–12:30
};
export const STATES = { working: 'Working', break: 'On break', away: 'Stepped away', out: 'Clocked out' };
export const ROLES = {
  rep: 'City owner',          // owns the cities in `home`; the default person for them
  backup: 'Any city',         // covers any city (Tiffany: manager, usually the Sunday solo)
  owner: 'Last resort',       // you: only scheduled / handed cities when nobody else can
  floater: 'Any city',        // legacy role, treated like backup
};
const PHONE_ROLES = ['rep', 'backup', 'floater'];
const STATE_WORD = { break: 'on break/lunch', away: 'stepped away', out: 'clocked out' };
const STATE_JUST = { break: 'went on break/lunch', away: 'stepped away', out: 'clocked out' };

/* Built-in team setup. The live copy is the app_config row (edited on the Team
   screen); this is the fallback and the first seed. SALES lines only: the
   customer-service and scheduler lines are not the reps' job. */
export const DEFAULT_CONFIG = {
  cities: [
    { id: 'AUS', name: 'Austin', short: 'Austin', color: '#2589c7',
      salesLines: [{ id: 'PN3nuGKInc', number: '+15129341967', name: 'Sales Austin' }] },
    { id: 'SAT', name: 'San Antonio', short: 'San Antonio', color: '#7c4dff',
      salesLines: [{ id: 'PNgkyjeeOC', number: '+12104044270', name: '#1 Sales San Antonio' },
                   { id: 'PN7O43OTc1', number: '+12105601857', name: '#2 San Antonio Sales' }] },
    { id: 'DAL', name: 'Dallas', short: 'Dallas', color: '#0e9488',
      salesLines: [{ id: 'PNGpd53BLO', number: '+12148171371', name: '#1 Sales Dallas' },
                   { id: 'PNMfEIGFiX', number: '+14698755949', name: '#2 Dallas Sales' },
                   { id: 'PNQudqsEaM', number: '+19722659779', name: '#3 Dallas Sales' }] },
    { id: 'FTW', name: 'Fort Worth', short: 'Fort Worth', color: '#d4357a',
      salesLines: [{ id: 'PNIrI1n7V6', number: '+18172257774', name: 'Sales Fort Worth' }] },
  ],
  people: [
    { id: 'barbara', name: 'Barbara', role: 'rep', home: ['AUS', 'SAT'], color: '#2589c7' },
    { id: 'kitzia', name: 'Kitzia', role: 'rep', home: ['DAL', 'FTW'], color: '#0e9488' },
    { id: 'tiffany', name: 'Tiffany', role: 'backup', home: [], color: '#db2777', lunch: false, workMin: 570 },
    { id: 'owner', name: 'You (Owner)', role: 'owner', home: [], color: '#eb7c54' },
    { id: 'maria', name: 'Mary', role: 'floater', home: [], color: '#94a3b8', former: true },
  ],
  defaultWeek: {
    Mon: ['barbara', 'kitzia'], Tue: ['barbara', 'kitzia'], Wed: ['barbara', 'kitzia'],
    Thu: ['barbara', 'kitzia'], Fri: ['barbara', 'kitzia'], Sat: ['barbara', 'kitzia'],
    Sun: ['tiffany'],
  },
  settings: {
    autoHandoff: true,     // someone goes on break -> their cities go to whoever is free
    autoRelieve: true,     // they're back -> the stand-in comes off those cities
    reportEnabled: true,   // end-of-day text to the office line
    reportAt: '18:05',     // Central
    alertTo: '',           // '' = the ALERT_TO secret (the office line +1 254-318-4440)
  },
};

const clone = o => JSON.parse(JSON.stringify(o));
const pad2 = n => String(n).padStart(2, '0');

/** Repair a stored config: anything missing or malformed falls back to the built-in setup. */
export function normalizeConfig(raw) {
  const d = clone(DEFAULT_CONFIG);
  const src = raw && typeof raw === 'object' ? raw : {};
  const cities = (Array.isArray(src.cities) && src.cities.length ? src.cities : d.cities)
    .filter(c => c && c.id)
    .map(c => ({
      id: String(c.id),
      name: String(c.name || c.id),
      short: String(c.short || c.name || c.id),
      color: String(c.color || '#64748b'),
      salesLines: (Array.isArray(c.salesLines) ? c.salesLines : [])
        .filter(l => l && (l.id || l.number))
        .map(l => ({ id: String(l.id || ''), number: String(l.number || ''), name: String(l.name || l.number || l.id) })),
    }));
  const cityIds = new Set(cities.map(c => c.id));
  const people = (Array.isArray(src.people) && src.people.length ? src.people : d.people)
    .filter(p => p && p.id)
    .map(p => {
      const o = {
        id: String(p.id), name: String(p.name || p.id), role: ROLES[p.role] ? p.role : 'backup',
        home: (Array.isArray(p.home) ? p.home : []).map(String).filter(id => cityIds.has(id)),
        color: String(p.color || '#64748b'),
      };
      if (p.lunch === false) o.lunch = false;
      if (Number(p.workMin) > 0) o.workMin = Math.round(Number(p.workMin));
      if (p.former) o.former = true;
      return o;
    });
  const ids = new Set(people.map(p => p.id));
  const dw = src.defaultWeek && typeof src.defaultWeek === 'object' ? src.defaultWeek : d.defaultWeek;
  const defaultWeek = {};
  DAYS.forEach(k => { defaultWeek[k] = (Array.isArray(dw[k]) ? dw[k] : (d.defaultWeek[k] || [])).map(String).filter(id => ids.has(id)); });
  const s = { ...d.settings, ...(src.settings && typeof src.settings === 'object' ? src.settings : {}) };
  return {
    cities, people, defaultWeek,
    settings: {
      autoHandoff: s.autoHandoff !== false,
      autoRelieve: s.autoRelieve !== false,
      reportEnabled: s.reportEnabled !== false,
      reportAt: /^\d{1,2}:\d{2}$/.test(String(s.reportAt)) ? String(s.reportAt) : d.settings.reportAt,
      alertTo: String(s.alertTo || '').trim(),
    },
  };
}

/* ------------------------------- lookups -------------------------------- */
export const person = (cfg, id) => cfg.people.find(p => p.id === id) || null;
export const isFormer = (cfg, id) => !!(person(cfg, id) || {}).former;
export const activePeople = cfg => cfg.people.filter(p => !p.former);
export const firstName = p => (p ? String(p.name).replace(/\s*\(Owner\)\s*$/, '') : '');
export const nameOf = (cfg, id) => { const p = person(cfg, id); return p ? firstName(p) : String(id); };
export const city = (cfg, id) => cfg.cities.find(c => c.id === id) || null;
export const cityShort = (cfg, id) => (city(cfg, id) || { short: id }).short;
export const cityName = (cfg, id) => (city(cfg, id) || { name: id }).name;
export const homeCities = p => (p && Array.isArray(p.home) ? p.home : []);
export const ownsCity = (p, cid) => !!p && p.role === 'rep' && homeCities(p).includes(cid);
export const ownerOfCity = (cfg, cid) => activePeople(cfg).find(p => ownsCity(p, cid)) || null;
export const isFlexible = p => !!p && p.role !== 'rep';
export const expandCity = id => LEGACY[id] || [id];
export const isWorking = st => st === 'working';
export function parseCovering(v) {
  return [...new Set(String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean).flatMap(expandCity))];
}
export const coveringString = arr => (arr && arr.length ? [...new Set(arr)].join(',') : null);
/** The phone team: city owners + any-city people (the owner is only the last resort). */
export const phoneTeam = cfg => activePeople(cfg).filter(p => PHONE_ROLES.includes(p.role)).map(p => p.id);
const byRole = (cfg, roles) => activePeople(cfg).filter(p => roles.includes(p.role)).map(p => p.id);
/** Who fills an absent owner's cities when BUILDING a schedule: any-city people, then You, then owners. */
export const fillOrder = cfg => [...byRole(cfg, ['backup', 'floater']), ...byRole(cfg, ['owner']), ...byRole(cfg, ['rep'])];
/** Who takes a city LIVE when someone steps away: any-city people, then owners, You last. */
export const coverOrder = cfg => [...byRole(cfg, ['backup', 'floater']), ...byRole(cfg, ['rep']), ...byRole(cfg, ['owner'])];
/** City ids in the configured city order (unknown ids kept at the end). */
export function inCityOrder(cfg, ids) {
  const set = new Set(ids);
  return [...cfg.cities.map(c => c.id).filter(id => set.has(id)), ...[...set].filter(id => !city(cfg, id))];
}

/* -------------------------------- time ---------------------------------- */
const TZ = 'America/Chicago';
const _fmt = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch (e) { return null; } })();
const isoUTC = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
/** Central-time facts for a moment: date, day key, minutes past midnight, the week's
 *  Monday, and midnight (as a UTC timestamp) for "is this status from today?" checks. */
export function central(date = new Date()) {
  const t = Math.floor(date.getTime() / 1000) * 1000;
  let y, mo, d, h, mi, s;
  if (_fmt) {
    const p = {}; _fmt.formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; });
    y = +p.year; mo = +p.month; d = +p.day; h = +p.hour % 24; mi = +p.minute; s = +p.second;
  } else {                                     // no Intl time zones: use the device clock
    const x = new Date(t); y = x.getFullYear(); mo = x.getMonth() + 1; d = x.getDate(); h = x.getHours(); mi = x.getMinutes(); s = x.getSeconds();
  }
  const offset = Date.UTC(y, mo - 1, d, h, mi, s) - t;          // Central minus UTC, in ms
  const startMs = Date.UTC(y, mo - 1, d) - offset;               // today's midnight, Central
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();      // 0 = Sunday
  const back = (dow + 6) % 7;
  return {
    iso: `${y}-${pad2(mo)}-${pad2(d)}`, dayKey: DAYS[back], mins: h * 60 + mi, startMs,
    mondayIso: isoUTC(new Date(Date.UTC(y, mo - 1, d - back))),
  };
}
/** Minutes past Central midnight for a timestamp, given that midnight. */
export const minuteOf = (ts, startMs) => Math.floor((Date.parse(ts) - startMs) / 60000);

/* --------------------------- live status rows --------------------------- */
/** presence rows -> { pid: {state, covering, updated_at, updated_by, stale} }. A status left
 *  over from a previous day (somebody never clocked out) counts as clocked out. */
export function freshPresence(rows, startMs) {
  const out = {};
  (rows || []).forEach(r => {
    if (!r || !r.person_id) return;
    const t = r.updated_at ? Date.parse(r.updated_at) : NaN;
    const old = !(t >= startMs);
    out[r.person_id] = old
      ? { state: 'out', covering: null, updated_at: r.updated_at || null, updated_by: r.updated_by || null, stale: r.state !== 'out' }
      : { state: r.state, covering: r.covering || null, updated_at: r.updated_at || null, updated_by: r.updated_by || null };
  });
  return out;
}
const stateOf = (presence, pid) => (presence[pid] || {}).state;

/* ============================ schedule engine =========================== */
export const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const takesLunch = p => !p || p.lunch !== false;
/** working minutes: explicit workMin, else 8h with lunch / 9h without */
export const maxWorkMin = p => (p && p.workMin) ? p.workMin : (takesLunch(p) ? 480 : 540);
export function shiftTimes(a, cfg) {
  const preset = SHIFTS[a.preset] || (a.start == null ? SHIFTS.open : null);
  const t = preset ? { ...preset } : { start: a.start, end: a.end, lunchStart: a.lunchStart, lunchEnd: a.lunchEnd };
  const p = person(cfg, a.personId);
  if (!takesLunch(p)) {                          // no break: one straight shift of their full day
    const work = maxWorkMin(p);
    if (t.end >= CLOSE_MIN) t.start = t.end - work; else t.end = t.start + work;
    if (t.start < OPEN_MIN) { t.start = OPEN_MIN; t.end = OPEN_MIN + work; }
    if (t.end > CLOSE_MIN) { t.end = CLOSE_MIN; t.start = CLOSE_MIN - work; }
    t.lunchStart = t.start; t.lunchEnd = t.start;
  }
  return t;
}
export const hasLunch = t => t.lunchEnd > t.lunchStart;
export const defaultStatus = (cfg, dayKey, pid) =>
  (!isFormer(cfg, pid) && (cfg.defaultWeek[dayKey] || []).includes(pid)) ? 'work' : 'off';
export function blankDay(cfg, dayKey) {
  const status = {};
  cfg.people.forEach(p => { status[p.id] = defaultStatus(cfg, dayKey, p.id); });
  return { status, assign: [] };
}
export function blankWeek(cfg) {
  const W = { _team: TEAM_VERSION };
  DAYS.forEach(d => { W[d] = buildDay(blankDay(cfg, d), cfg); });
  return W;
}

/* Build one day from who is marked Working:
   • one person  -> a "solo day": they take every city ('mid'); uncovered minutes are expected.
   • each owner's cities are a side: the owner takes it if working, else the next free
     person (fillOrder). Cities nobody owns form their own side.
   • a pair staggers (opener + closer) and each is the planned BACKUP on the other side.
   • anyone extra is the floating backup (closer) on every city.
   Planned backups count for the schedule, not for live coverage.                     */
export function buildDay(day, cfg) {
  day.assign = [];
  day.status = day.status || {};
  const on = id => day.status[id] === 'work' && !isFormer(cfg, id) && !!person(cfg, id);
  const core = phoneTeam(cfg).filter(on);
  const owners = byRole(cfg, ['owner']).filter(on);
  const pool = core.length >= 2 ? core : core.concat(owners);   // You only fill a short day
  if (!pool.length) return day;                                  // nobody working: red, on purpose
  const push = (personId, group, preset, backup) => day.assign.push(backup
    ? { id: newId(), personId, group, preset, backup: true }
    : { id: newId(), personId, group, preset });
  if (pool.length === 1) { cfg.cities.forEach(c => push(pool[0], c.id, 'mid')); return day; }

  const reps = activePeople(cfg).filter(p => p.role === 'rep');
  const owned = new Set(reps.flatMap(homeCities));
  const sides = reps.map(p => ({ owner: p.id, cities: homeCities(p).filter(cid => city(cfg, cid)) })).filter(s => s.cities.length);
  const loose = cfg.cities.map(c => c.id).filter(id => !owned.has(id));
  if (loose.length) sides.push({ owner: null, cities: loose });
  const used = new Set();
  sides.forEach(s => { s.who = s.owner && pool.includes(s.owner) ? s.owner : null; if (s.who) used.add(s.who); });
  sides.forEach(s => {
    if (s.who) return;
    s.who = fillOrder(cfg).find(id => pool.includes(id) && !used.has(id)) || null;
    if (s.who) used.add(s.who);
  });
  const filled = sides.filter(s => s.who);
  const extra = pool.filter(id => !used.has(id));
  const orphans = sides.filter(s => !s.who).flatMap(s => s.cities);   // more sides than people
  if (extra.length) {
    filled.forEach(s => s.cities.forEach(g => push(s.who, g, 'open')));
    extra.forEach(f => cfg.cities.forEach(c => push(f, c.id, 'close', true)));
  } else {
    filled.forEach((s, i) => { s.preset = i === 0 ? 'open' : 'close'; });
    filled.forEach(s => s.cities.forEach(g => push(s.who, g, s.preset)));
    filled.forEach(s => filled.filter(o => o !== s).forEach(o => o.cities.forEach(g => push(s.who, g, s.preset, true))));
    if (orphans.length && filled.length) {
      orphans.forEach(g => push(filled[0].who, g, filled[0].preset));
      filled.slice(1).forEach(s => orphans.forEach(g => push(s.who, g, s.preset, true)));
    }
  }
  return day;
}

/** Rewrite pre-split 2-group assignments (G1/G2) into per-city ones. Returns true if changed. */
export function migrateLegacyWeek(W) {
  if (!W) return false;
  let changed = false;
  DAYS.forEach(d => {
    const day = W[d]; if (!day || !Array.isArray(day.assign)) return;
    const out = [];
    day.assign.forEach(a => {
      if (LEGACY[a.group]) { changed = true; LEGACY[a.group].forEach(cid => out.push({ ...a, id: newId(), group: cid })); }
      else out.push(a);
    });
    day.assign = out;
  });
  return changed;
}
/** A current/future week saved under an older staffing model is rebuilt once (past weeks
 *  stay as history): former teammates go Off, plain "Working" resets to the default week,
 *  deliberate Off/PTO marks are kept. Returns true if it changed the week. */
export function upgradeTeam(W, weekIso, thisMondayIso, cfg) {
  if (!W || W._team === TEAM_VERSION) return false;
  if (weekIso < thisMondayIso) return false;
  DAYS.forEach(d => {
    const day = W[d]; if (!day) return;
    day.status = day.status || {};
    cfg.people.forEach(p => {
      const cur = day.status[p.id];
      if (p.former) day.status[p.id] = 'off';
      else if (cur === undefined || cur === 'work') day.status[p.id] = defaultStatus(cfg, d, p.id);
    });
    buildDay(day, cfg);
  });
  W._team = TEAM_VERSION;
  return true;
}
/** Someone left the team: in a current/future week, mark them Off and rebuild the days
 *  they were on. Returns true if it changed the week. */
export function dropFormers(W, weekIso, thisMondayIso, cfg) {
  if (!W || weekIso < thisMondayIso) return false;
  let changed = false;
  DAYS.forEach(d => {
    const day = W[d]; if (!day) return;
    day.status = day.status || {};
    const gone = cfg.people.filter(p => p.former && (day.status[p.id] === 'work' || (day.assign || []).some(a => a.personId === p.id)));
    if (!gone.length) return;
    gone.forEach(p => { day.status[p.id] = 'off'; });
    buildDay(day, cfg); changed = true;
  });
  return changed;
}
/** Today's plan: the saved day, or (week not saved yet) what the default week would build,
 *  in memory only, so the automation still works before a manager opens the week. */
export function dayOrDefault(W, dayKey, cfg) {
  return (W && W[dayKey]) || buildDay(blankDay(cfg, dayKey), cfg);
}
/** Fill in any missing day of a stored week. */
export function ensureWeek(W, cfg) {
  if (!W || !W.Mon) return blankWeek(cfg);
  DAYS.forEach(d => {
    if (!W[d]) W[d] = buildDay(blankDay(cfg, d), cfg);
    W[d].status = W[d].status || {};
    W[d].assign = Array.isArray(W[d].assign) ? W[d].assign : [];
  });
  return W;
}

/* ---------------------------- coverage checks --------------------------- */
const slotRange = i => [OPEN_MIN + i * SLOT, OPEN_MIN + (i + 1) * SLOT];
export function isActive(a, s, e, cfg) {
  const t = shiftTimes(a, cfg);
  if (t.start > s || t.end < e) return false;
  if (s < t.lunchEnd && e > t.lunchStart) return false;
  return true;
}
/** { cityId: [ [personIds on in slot 0], … ] } for the 8a–6p window in 30-minute slots */
export function computeCoverage(day, cfg) {
  const cov = {};
  cfg.cities.forEach(c => { cov[c.id] = []; });
  for (let i = 0; i < N_SLOTS; i++) {
    const [s, e] = slotRange(i);
    cfg.cities.forEach(c => {
      cov[c.id].push([...new Set(((day && day.assign) || []).filter(a => a.group === c.id && !isFormer(cfg, a.personId) && isActive(a, s, e, cfg)).map(a => a.personId))]);
    });
  }
  return cov;
}
export function windowsWhere(arr, pred) {
  const out = []; let run = null;
  for (let i = 0; i < arr.length; i++) {
    if (pred(arr[i].length)) { if (!run) run = [i, i]; else run[1] = i; }
    else if (run) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out.map(([a, b]) => `${fmtClock(OPEN_MIN + a * SLOT)}–${fmtClock(OPEN_MIN + (b + 1) * SLOT)}`);
}
export const dayPeople = (day, cfg) =>
  [...new Set(((day && day.assign) || []).map(a => a.personId).filter(id => !isFormer(cfg, id)))];
/** One person scheduled = a solo day: their uncovered minutes are expected, no alarms. */
export const isSoloDay = (day, cfg) => dayPeople(day, cfg).length === 1;

/** The on-call backup for a city's single-coverage stretches. */
export function backupName(day, cid, cfg) {
  const planned = ((day && day.assign) || []).find(a => a.group === cid && a.backup && !isFormer(cfg, a.personId) && person(cfg, a.personId));
  if (planned) return nameOf(cfg, planned.personId);
  const onIt = ((day && day.assign) || []).filter(a => a.group === cid).map(a => a.personId);
  const other = fillOrder(cfg).find(id => ((day && day.status) || {})[id] === 'work' && !onIt.includes(id));
  return other ? nameOf(cfg, other) : 'no backup available';
}

/** Rule checks for one day: [{ level: ok|warn|bad, text }] */
export function validateDay(day, cfg) {
  const out = [], add = (level, text) => out.push({ level, text });
  if (!day) return out;
  const cov = computeCoverage(day, cfg), solo = isSoloDay(day, cfg), st = day.status || {};
  cfg.cities.forEach(c => {
    const arr = cov[c.id];
    if (!day.assign.some(a => a.group === c.id && !isFormer(cfg, a.personId))) { add('bad', `${c.short}: nobody assigned.`); return; }
    if (solo) return;
    const zeros = windowsWhere(arr, n => n === 0), ones = windowsWhere(arr, n => n === 1);
    if (zeros.length) add('bad', `${c.short}: NO coverage at ${zeros.join(', ')}. Assign someone.`);
    else if (ones.length) add('warn', `${c.short}: one person at ${ones.join(', ')} (lunch/edges). On-call backup: ${backupName(day, c.id, cfg)}.`);
    else add('ok', `${c.short}: two-person coverage all day.`);
  });
  if (solo) {
    const who = nameOf(cfg, dayPeople(day, cfg)[0]);
    const c0 = cfg.cities.find(c => day.assign.some(a => a.group === c.id));
    const gaps = c0 ? windowsWhere(cov[c0.id], n => n === 0) : [];
    add('ok', `One-person day: ${who} covers every city.${gaps.length ? ` Expected gaps, no alarms: ${gaps.join(', ')}.` : ' Covered all day.'}`);
  }
  day.assign.forEach(a => {
    const p = person(cfg, a.personId), c = city(cfg, a.group);
    if (!p || !c || p.former) return;
    const t = shiftTimes(a, cfg);
    const work = (t.end - t.start) - (t.lunchEnd - t.lunchStart), cap = maxWorkMin(p);
    if (work > cap) add('bad', `${firstName(p)} (${c.short}) is scheduled ${(work / 60).toFixed(1)}h, over the ${cap / 60}-hour limit.`);
    if (takesLunch(p)) {
      const lunch = t.lunchEnd - t.lunchStart;
      if (lunch < 60) add('bad', `${firstName(p)}: lunch is only ${lunch}m. The 1-hour break is mandatory.`);
      else if (t.lunchStart <= t.start || t.lunchEnd >= t.end) add('warn', `${firstName(p)}: lunch should sit in the middle of the shift.`);
    }
    if ((st[a.personId] || 'off') !== 'work') add('warn', `${firstName(p)} is marked ${(st[a.personId] || 'off').toUpperCase()} but is on ${c.short}.`);
  });
  activePeople(cfg).filter(p => p.role === 'rep').forEach(p => {
    const foreign = [...new Set(day.assign.filter(a => a.personId === p.id && !a.backup && !homeCities(p).includes(a.group)).map(a => a.group))]
      .filter(g => { const o = ownerOfCity(cfg, g); return o && st[o.id] === 'work'; });
    if (foreign.length) {
      const owners = [...new Set(foreign.map(g => firstName(ownerOfCity(cfg, g))))];
      add('warn', `${firstName(p)} is primary on ${cityList(cfg, foreign)} while ${joinList(owners)} is working. That breaks number separation.`);
    }
  });
  activePeople(cfg).filter(p => p.role === 'rep' && st[p.id] !== 'work').forEach(rep => {
    const covered = [], bare = [], who = new Set();
    homeCities(rep).forEach(gid => {
      const onIt = day.assign.filter(a => a.group === gid && !a.backup && !isFormer(cfg, a.personId)).map(a => a.personId);
      if (onIt.length) { covered.push(gid); onIt.forEach(id => who.add(nameOf(cfg, id))); } else bare.push(gid);
    });
    const s = (st[rep.id] || 'off').toUpperCase();
    if (bare.length) add('warn', `${firstName(rep)} is ${s}: nobody is covering ${cityList(cfg, bare)}.`);
    if (covered.length) add('ok', `${firstName(rep)} ${s.toLowerCase()}: ${joinList([...who])} covering ${cityList(cfg, covered)}.`);
  });
  return out.sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.level] - { bad: 0, warn: 1, ok: 2 }[b.level]));
}
/** day-level summary for the week view: { cls: ok|warn|bad|solo, text } */
export function daySummary(day, cfg) {
  if (!day || !day.assign.some(a => !isFormer(cfg, a.personId))) return { cls: 'bad', text: 'Nobody on' };
  if (isSoloDay(day, cfg)) return { cls: 'solo', text: 'One person' };
  const cov = computeCoverage(day, cfg);
  let worst = 2;
  cfg.cities.forEach(c => cov[c.id].forEach(s => { if (s.length < worst) worst = s.length; }));
  return worst >= 2 ? { cls: 'ok', text: '2+ all day' } : worst === 1 ? { cls: 'warn', text: 'Covered' } : { cls: 'bad', text: 'Gap' };
}

/* =============================== live state ============================== */
export function plannedPrimaries(day, cid, cfg) {
  return [...new Set(((day && day.assign) || [])
    .filter(a => !a.backup && expandCity(a.group).includes(cid) && !isFormer(cfg, a.personId)).map(a => a.personId))];
}
export function plannedBackups(day, cid, cfg) {
  return [...new Set(((day && day.assign) || [])
    .filter(a => a.backup && expandCity(a.group).includes(cid) && !isFormer(cfg, a.personId)).map(a => a.personId))];
}
/** Who is on a city now: planned primaries + anyone covering it, and which of them are working. */
export function onCity(day, presence, cid, cfg) {
  const planned = plannedPrimaries(day, cid, cfg);
  const adhoc = activePeople(cfg).filter(p => parseCovering((presence[p.id] || {}).covering).includes(cid)).map(p => p.id);
  const assigned = [...new Set([...planned, ...adhoc])];
  return { assigned, working: assigned.filter(id => isWorking(stateOf(presence, id))) };
}
/** The cities a person is on right now (their plan + what they're covering). */
export function personCities(day, presence, pid, cfg) {
  return cfg.cities.map(c => c.id).filter(cid => onCity(day, presence, cid, cfg).assigned.includes(pid));
}
/** Return a copy of presence with covering writes applied. */
export function applyWrites(presence, writes) {
  const out = {};
  Object.keys(presence || {}).forEach(k => { out[k] = { ...presence[k] }; });
  (writes || []).forEach(w => { out[w.pid] = { ...(out[w.pid] || { state: 'out' }), covering: w.covering }; });
  return out;
}
/** A person just stopped working: who takes each of these now-uncovered cities?
 *  Each city's planned backup first, then coverOrder. Only people ALREADY working: the
 *  app never changes anyone's own status. */
export function handoffPlan(day, presence, leaverId, bare, cfg) {
  const byTarget = {}, uncovered = [];
  bare.forEach(cid => {
    const target = [...plannedBackups(day, cid, cfg), ...coverOrder(cfg)]
      .find(id => id !== leaverId && !isFormer(cfg, id) && isWorking(stateOf(presence, id)));
    if (target) (byTarget[target] = byTarget[target] || []).push(cid);
    else uncovered.push(cid);
  });
  return { moves: Object.keys(byTarget).map(pid => ({ pid, cities: byTarget[pid] })), uncovered };
}
/** A person just clocked in: the uncovered cities they are today's planned backup for. */
export function pickupPlan(day, presence, pid, cfg) {
  return cfg.cities.map(c => c.id).filter(cid =>
    plannedBackups(day, cid, cfg).includes(pid) && !plannedPrimaries(day, cid, cfg).includes(pid)
    && onCity(day, presence, cid, cfg).working.length === 0);
}
/** A person is back: whoever covers one of THEIR cities as a stand-in comes off it
 *  (never off their own home cities or their own planned primaries). */
export function reliefPlan(day, presence, returnerId, cfg) {
  const R = person(cfg, returnerId);
  if (!R || R.former) return [];
  const mine = new Set([...cfg.cities.map(c => c.id).filter(cid => plannedPrimaries(day, cid, cfg).includes(returnerId)), ...homeCities(R)]);
  const out = [];
  activePeople(cfg).forEach(C => {
    if (C.id === returnerId) return;
    const cov = parseCovering((presence[C.id] || {}).covering);
    const drop = cov.filter(x => mine.has(x) && !homeCities(C).includes(x) && !plannedPrimaries(day, x, cfg).includes(C.id));
    if (drop.length) out.push({ pid: C.id, drop, keep: cov.filter(x => !drop.includes(x)) });
  });
  return out;
}

/* ------------------------------- wording -------------------------------- */
export function joinList(items) {
  const a = (items || []).filter(Boolean);
  return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
}
export const cityList = (cfg, ids) => joinList(inCityOrder(cfg, ids).map(id => cityShort(cfg, id)));
export const salesLines = (cfg, ids) => inCityOrder(cfg, ids).flatMap(id => (city(cfg, id) || {}).salesLines || []);
/** "#1 Sales Dallas, #2 Dallas Sales & #3 Dallas Sales" (the city names if a city has no lines) */
export function lineList(cfg, ids) {
  return joinList(inCityOrder(cfg, ids).flatMap(id => {
    const ls = (city(cfg, id) || {}).salesLines || [];
    return ls.length ? ls.map(l => l.name) : [cityShort(cfg, id)];
  }));
}
export function fmtTime(min) {                 // 6:42 PM
  let h = Math.floor(min / 60) % 24; const m = ((min % 60) + 60) % 60, ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(m)} ${ap}`;
}
export function fmtClock(min) {                // 9a, 9:05a, 12:30p
  let h = Math.floor(min / 60) % 24; const m = ((min % 60) + 60) % 60, ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m ? `${h}:${pad2(m)}${ap}` : `${h}${ap}`;
}

/* ===================== one status change -> what to do ==================== */
/**
 * Decide what one presence change means. Pure. Returns
 *   { skip: reason }  or  { kind, msg (null = no text), writes: [{pid, covering, updated_by, cities, requireWorking?}] }
 * presence = live snapshot AFTER the change (freshPresence); rec/old = the row after/before;
 * mins = now (Central); startMs = today's Central midnight.
 * Changes the server made itself carry updated_by 'auto:…' and were announced already.
 */
export function planEvent({ cfg, day, presence, rec, old, mins, startMs }) {
  const pid = rec && rec.person_id;
  if (!pid || typeof rec.state === 'undefined') return { skip: 'no record' };
  if (isFormer(cfg, pid)) return { skip: 'former teammate' };
  if (String(rec.updated_by || '').startsWith('auto:')) return { skip: 'automatic change, already announced' };
  if (old && startMs && old.updated_at && Date.parse(old.updated_at) < startMs)
    old = { ...old, state: 'out', covering: null };              // yesterday's leftover = clocked out

  const name = nameOf(cfg, pid), P = person(cfg, pid);
  const oldCov = parseCovering(old && old.covering), newCov = parseCovering(rec.covering);
  const added = newCov.filter(c => !oldCov.includes(c)), lost = oldCov.filter(c => !newCov.includes(c));
  const working = isWorking(rec.state), wasWorking = !!old && isWorking(old.state);
  const sinceLast = (old && old.updated_at && rec.updated_at) ? Date.parse(rec.updated_at) - Date.parse(old.updated_at) : Infinity;
  const becameUnavailable = !working && (!old || wasWorking || old.state !== rec.state);
  // a write to 'working' is a clock-in if they weren't working, or a re-tap on a row untouched
  // for 20+ minutes (a covering change on someone already working is a covering event)
  const becameWorking = working && (!old || !wasWorking || (sinceLast > 20 * 60 * 1000 && !added.length && !lost.length));
  const gained = working && !becameWorking && added.length > 0;
  const dropped = working && !becameWorking && lost.length > 0;
  if (!becameUnavailable && !becameWorking && !gained && !dropped) return { skip: 'not a relevant transition' };

  // texting windows: clock-in & covering 6a–6:30p · clock-out 6a–midnight · break/away 8a–6p
  const isClockOut = becameUnavailable && rec.state === 'out';
  let lo = OPEN_MIN, hi = CLOSE_MIN;
  if (becameWorking || gained || dropped) { lo = 6 * 60; hi = 18 * 60 + 30; }
  else if (isClockOut) { lo = 6 * 60; hi = 24 * 60; }
  const textOK = mins >= lo && mins < hi;

  let own = inCityOrder(cfg, [...cfg.cities.map(c => c.id).filter(cid => plannedPrimaries(day, cid, cfg).includes(pid)), ...oldCov, ...newCov]);
  if (!own.length) own = homeCities(P).slice();
  const ownText = cityList(cfg, own);
  const writes = [];

  if (becameUnavailable) {
    if (!textOK) return { skip: 'outside hours' };
    const word = STATE_WORD[rec.state] || rec.state, just = STATE_JUST[rec.state] || rec.state;
    if (mins < OPEN_MIN || mins >= CLOSE_MIN)                     // only a clock-out gets here
      return { kind: 'clockout-offhours', writes, msg: `TCS: ${name} clocked out at ${fmtTime(mins)}${own.length ? ` (${ownText})` : ''}.` };
    if (isSoloDay(day, cfg))
      return { kind: 'solo', writes, msg: `TCS: ${name} is now ${word} (one-person day — ${own.length ? ownText : 'their cities'} wait until they're back).` };
    if (!own.length) return { kind: 'unavailable', writes, msg: `TCS: ${name} is now ${word}.` };
    const bare = own.filter(c => onCity(day, presence, c, cfg).working.length === 0);
    if (!bare.length) {
      const on = [...new Set(own.flatMap(c => onCity(day, presence, c, cfg).working))].map(id => nameOf(cfg, id));
      return { kind: 'unavailable', writes, msg: `TCS: ${name} is now ${word}. ${ownText} still covered${on.length ? ` (${joinList(on)})` : ''}.` };
    }
    if (cfg.settings.autoHandoff) {
      const plan = handoffPlan(day, presence, pid, bare, cfg);
      if (plan.moves.length) {
        const moved = plan.moves.flatMap(m => m.cities);
        const leftover = parseCovering(rec.covering).filter(c => !moved.includes(c));
        if (leftover.length !== parseCovering(rec.covering).length)   // they no longer stand in for what moved
          writes.push({ pid, cities: [], covering: coveringString(leftover), updated_by: 'auto:handoff' });
        plan.moves.forEach(m => writes.push({
          pid: m.pid, cities: m.cities, updated_by: 'auto:handoff', requireWorking: true,
          covering: coveringString([...parseCovering((presence[m.pid] || {}).covering), ...m.cities]),
        }));
        const parts = plan.moves.map(m => {
          const n = nameOf(cfg, m.pid);
          return `${n} now covers ${cityList(cfg, m.cities)}. ${n} can UNMUTE ${lineList(cfg, m.cities)} in OpenPhone.`;
        });
        if (plan.uncovered.length) parts.push(`⚠ NO ONE is free for ${cityList(cfg, plan.uncovered)} — call someone in.`);
        return { kind: 'handoff', writes, msg: `🔄 TCS: ${name} is now ${word} → ${parts.join(' ')}` };
      }
      return { kind: 'gap', writes, msg: `⚠ TCS COVERAGE GAP: ${cityList(cfg, bare)} — NO ONE covering (${name} just ${just}). → NO ONE is free right now — call someone in.` };
    }
    // automatic handoff off: name who's free; they tap "I'll cover it"
    const onGap = new Set(bare.flatMap(c => onCity(day, presence, c, cfg).assigned));
    const free = coverOrder(cfg).filter(id => id !== pid && isWorking(stateOf(presence, id)) && !onGap.has(id)).map(id => nameOf(cfg, id));
    const tail = free.length
      ? ` → ${free[0]} is free and should pick it up${free.length > 1 ? ` (also free: ${free.slice(1).join(', ')})` : ''}.`
      : ' → NO ONE is free right now — call someone in.';
    return { kind: 'gap', writes, msg: `⚠ TCS COVERAGE GAP: ${cityList(cfg, bare)} — NO ONE covering (${name} just ${just}).${tail}` };
  }

  if (becameWorking) {
    const relief = cfg.settings.autoRelieve ? reliefPlan(day, presence, pid, cfg) : [];
    relief.forEach(r => writes.push({ pid: r.pid, cities: r.drop, covering: coveringString(r.keep), updated_by: 'auto:relieve' }));
    const pickup = (cfg.settings.autoHandoff && mins >= 6 * 60 && mins < CLOSE_MIN && !isSoloDay(day, cfg))
      ? pickupPlan(day, applyWrites(presence, writes), pid, cfg) : [];
    if (pickup.length) writes.push({ pid, cities: pickup, covering: coveringString([...newCov, ...pickup]), updated_by: 'auto:pickup', requireWorking: true });
    if (old && !wasWorking && sinceLast < GRACE_MS && !writes.length) return { skip: 'quick undo (tapped back within seconds)' };
    if (!textOK) return writes.length ? { kind: 'silent', writes, msg: null } : { skip: 'outside hours' };
    let msg = newCov.length
      ? `📍 TCS: ${name} clocked in, covering ${cityList(cfg, newCov)} — ${name} can UNMUTE ${lineList(cfg, newCov)} in OpenPhone.`
      : `✅ TCS: ${name} clocked in / is back on${own.length ? ` (${ownText})` : ''}.`;
    if (pickup.length) {
      const waitFor = joinList([...new Set(pickup.flatMap(c => plannedPrimaries(day, c, cfg)))].map(id => nameOf(cfg, id)));
      msg += ` ${name} also covers ${cityList(cfg, pickup)}${waitFor ? ` until ${waitFor} is on` : ''} — ${name} can UNMUTE ${lineList(cfg, pickup)} in OpenPhone.`;
    }
    relief.forEach(r => {
      const n = nameOf(cfg, r.pid);
      msg += ` ${n} is off ${cityList(cfg, r.drop)} — ${n} is OK to MUTE ${lineList(cfg, r.drop)} in OpenPhone again.`;
    });
    return { kind: relief.length ? 'back-relieve' : pickup.length ? 'back-pickup' : 'working', writes, msg };
  }

  if (!textOK) return { skip: 'outside hours' };
  const parts = [];
  if (gained) parts.push(`📍 TCS: ${name} is now covering ${cityList(cfg, added)} — ${name} can UNMUTE ${lineList(cfg, added)} in OpenPhone to get their calls & texts.`);
  if (dropped) parts.push(`${gained ? '' : '✅ TCS: '}${name} is off ${cityList(cfg, lost)} — ${name} is OK to MUTE ${lineList(cfg, lost)} in OpenPhone again.`);
  return { kind: gained ? 'covering' : 'uncovering', writes, msg: parts.join(' ') };
}

/* ============================ calls & reporting =========================== */
const CALL_PENDING = new Set(['ringing', 'in-progress', 'queued', 'initiated']);
/** An incoming call nobody answered (still-ringing, AI-handled and forwarded calls don't count). */
export const isMissedCall = c => !!c && c.direction === 'incoming' && !CALL_PENDING.has(c.status)
  && !c.answeredAt && !c.aiHandled && !c.forwardedTo;
/** The city a sales line belongs to (null for any other line). */
export const cityOfLine = (cfg, lineId) =>
  (cfg.cities.find(c => (c.salesLines || []).some(l => l.id === lineId)) || {}).id || null;

/** Walk a day's status changes in time order. events: [{person_id, state, covering, min}].
 *  Everyone starts the day clocked out. at(min) -> presence map (call with rising minutes). */
export function replayer(events) {
  const evs = [...(events || [])].sort((a, b) => a.min - b.min);
  const pres = {}; let i = 0;
  return function at(min) {
    while (i < evs.length && evs[i].min <= min) { const e = evs[i++]; pres[e.person_id] = { state: e.state, covering: e.covering || null }; }
    return pres;
  };
}
/** Who was working on a city at a minute (fresh replay; for one-off lookups). */
export function whoWasOn({ cfg, day, events, cityId, min }) {
  return onCity(day, replayer(events)(min), cityId, cfg).working.map(id => nameOf(cfg, id));
}

/** Today's activity feed from presence_log rows ({person_id, state, covering, updated_by, at}). */
export function describeLog(cfg, rows, startMs) {
  const prev = {}, out = [];
  [...(rows || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).forEach(r => {
    const p = prev[r.person_id] || { state: 'out', covering: null };
    const min = minuteOf(r.at, startMs), n = nameOf(cfg, r.person_id);
    const auto = String(r.updated_by || '').startsWith('auto:');
    const was = parseCovering(p.covering), now = parseCovering(r.covering);
    const add = now.filter(c => !was.includes(c)), lost = was.filter(c => !now.includes(c));
    if (r.state !== p.state) {
      const verb = r.state === 'working' ? (p.state === 'break' || p.state === 'away' ? 'is back' : 'clocked in')
        : r.state === 'break' ? 'went on break' : r.state === 'away' ? 'stepped away' : 'clocked out';
      out.push({ min, pid: r.person_id, kind: r.state, auto, text: `${n} ${verb}` });
    }
    if (add.length) out.push({ min, pid: r.person_id, kind: 'cover', auto, text: `${n} now covers ${cityList(cfg, add)}` });
    if (lost.length && r.state !== 'out') out.push({ min, pid: r.person_id, kind: 'uncover', auto, text: `${n} is off ${cityList(cfg, lost)}` });
    prev[r.person_id] = { state: r.state, covering: r.covering };
  });
  return out;
}

/**
 * The end-of-day report. events: today's status changes [{person_id, state, covering, min}];
 * calls: today's incoming SALES calls [{city, min, missed}]. Returns { text, data }.
 */
export function buildReport({ cfg, dateLabel, day, events, calls, nowMin }) {
  const end = Math.max(OPEN_MIN, Math.min(nowMin, CLOSE_MIN));
  const solo = isSoloDay(day, cfg);
  const at = replayer(events);
  const per = {};
  cfg.cities.forEach(c => { per[c.id] = { covered: 0, total: 0, gaps: [], gapStart: null }; });
  const snaps = {};                                 // minute -> who's on each city (for missed calls)
  const callMins = new Set((calls || []).map(k => k.min));
  at(OPEN_MIN - 1);
  for (let m = OPEN_MIN; m < end; m++) {
    const pres = at(m);
    cfg.cities.forEach(c => {
      const x = per[c.id], w = onCity(day, pres, c.id, cfg).working;
      x.total++;
      if (w.length) { x.covered++; if (x.gapStart !== null) { x.gaps.push([x.gapStart, m]); x.gapStart = null; } }
      else if (x.gapStart === null) x.gapStart = m;
      if (callMins.has(m)) (snaps[m] = snaps[m] || {})[c.id] = w;
    });
  }
  cfg.cities.forEach(c => { const x = per[c.id]; if (x.gapStart !== null) x.gaps.push([x.gapStart, end]); });

  const inHours = k => k.min >= OPEN_MIN && k.min < CLOSE_MIN;
  const cityData = cfg.cities.map(c => {
    const x = per[c.id], cc = (calls || []).filter(k => k.city === c.id && inHours(k));
    const missed = cc.filter(k => k.missed).sort((a, b) => a.min - b.min)
      .map(k => ({ min: k.min, who: ((snaps[k.min] || {})[c.id] || []).map(id => nameOf(cfg, id)) }));
    return { id: c.id, name: c.short, pct: x.total ? Math.round(x.covered * 100 / x.total) : null,
      gaps: x.gaps.filter(([a, b]) => b - a >= 5), calls: cc.length, missed };
  });
  const after = (calls || []).filter(k => !inHours(k));
  const afterHours = { calls: after.length, missed: after.filter(k => k.missed).length };

  const breaks = [];                                // breaks & step-aways from the log
  const byPerson = {};
  [...(events || [])].sort((a, b) => a.min - b.min).forEach(e => { (byPerson[e.person_id] = byPerson[e.person_id] || []).push(e); });
  Object.keys(byPerson).forEach(pid => {
    let s = 'out', since = 0;
    byPerson[pid].forEach(e => {
      const wasOff = s === 'break' || s === 'away';
      if (wasOff && e.state !== s && e.min > since) breaks.push({ pid, kind: s, from: since, to: e.min });   // skip undone-at-once taps
      if ((e.state === 'break' || e.state === 'away') && e.state !== s) since = e.min;
      s = e.state;
    });
    if (s === 'break' || s === 'away') breaks.push({ pid, kind: s, from: since, to: null });
  });
  breaks.sort((a, b) => a.from - b.from);
  const last = replayer(events)(nowMin);
  const stillOn = activePeople(cfg).filter(p => isWorking((last[p.id] || {}).state)).map(p => p.id);
  const anyone = (events || []).some(e => isWorking(e.state));

  const lines = [`📊 TCS coverage · ${dateLabel}`];
  if (!anyone) lines.push('No one clocked in today.');
  if (solo && anyone) lines.push(`One-person day (${nameOf(cfg, dayPeople(day, cfg)[0])}): uncovered minutes were expected.`);
  cityData.forEach(cd => {
    let c = `${cd.calls} call${cd.calls === 1 ? '' : 's'}, ${cd.missed.length} missed`;
    if (cd.missed.length) c += ` (${cd.missed.slice(0, 3).map(k => `${fmtClock(k.min)} ${k.who.length ? joinList(k.who) + ' on' : 'no one on'}`).join('; ')}${cd.missed.length > 3 ? '; …' : ''})`;
    if (!anyone) { lines.push(`${cd.name}: ${c}`); return; }
    const bits = [`${cd.name}: ${cd.pct === null ? 'n/a' : cd.pct + '% covered'}`];
    if (cd.gaps.length) bits.push(`${solo ? 'expected gap' : 'gap'}${cd.gaps.length > 1 ? 's' : ''} ${cd.gaps.slice(0, 3).map(([a, b]) => `${fmtClock(a)}–${fmtClock(b)}`).join(', ')}${cd.gaps.length > 3 ? ` +${cd.gaps.length - 3} more` : ''}`);
    bits.push(c);
    lines.push(bits.join(' · '));
  });
  if (afterHours.calls) lines.push(`After hours: ${afterHours.calls} call${afterHours.calls === 1 ? '' : 's'}, ${afterHours.missed} missed`);
  if (breaks.length) lines.push('Breaks: ' + breaks.map(b => `${nameOf(cfg, b.pid)} ${fmtClock(b.from)}–${b.to === null ? 'now' : fmtClock(b.to) + ` (${b.to - b.from}m)`}`).join(', '));
  if (stillOn.length) lines.push('Still on: ' + joinList(stillOn.map(id => nameOf(cfg, id))));
  return { text: lines.join('\n'), data: { cities: cityData, breaks, stillOn, solo, afterHours } };
}
