/* =============================================================================
   TCS Office Coverage — the app (phone-first).
   Every rule (building a day, coverage checks, automatic handoff, the texts, the
   daily report) lives in core.js, the SAME file the server runs, so the screen and
   the texts always agree. This file is screens, live data and buttons.
   Tabs: Today · Week · Team · Reports (managers) — Today · My week (members).
   ============================================================================= */
import * as C from './core.js?v=21';

/* ------------------------------- helpers -------------------------------- */
const $ = s => document.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = true;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULLDAY = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const isoAdd = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const isoPretty = iso => { const [, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const fmtPhone = n => { const d = String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || ''); };
const tzDate = (ts, opts) => new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/Chicago', ...opts });
const isToday = ts => !!ts && Date.parse(ts) >= NOW.startMs;
const clockOf = ts => C.fmtClock(C.minuteOf(ts, NOW.startMs));
const hhmm = s => { const [a, b] = String(s || '18:05').split(':').map(Number); return a * 60 + (b || 0); };
function ago(ts) {
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
const ICONS = {
  today: '<path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/><circle cx="12" cy="12" r="3.6"/>',
  week: '<rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 2.8v3.4M16 2.8v3.4"/>',
  team: '<circle cx="9" cy="8.5" r="3.4"/><path d="M2.8 20c.8-3.5 3.3-5.4 6.2-5.4s5.4 1.9 6.2 5.4"/><circle cx="17.2" cy="9.4" r="2.5"/><path d="M16.6 14.7c2.4.3 4.1 2 4.7 5.3"/>',
  reports: '<path d="M4.5 20.5V11M10 20.5V4.5M15.5 20.5v-7M21 20.5v-11"/>',
};
const icon = k => { const s = h('span', { class: 'ic', 'aria-hidden': 'true' }); s.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`; return s; };

/* ------------------------------ backend / state ------------------------- */
const CONF = window.TCS_CONFIG || {};
const ONLINE = !!(CONF.SUPABASE_URL && CONF.SUPABASE_ANON_KEY && window.supabase);
const sb = ONLINE ? window.supabase.createClient(CONF.SUPABASE_URL, CONF.SUPABASE_ANON_KEY) : null;
const Q = new URLSearchParams(location.search);
// local preview only: ?at=11:00 pretends it's that time (the clock keeps running from there)
const AT = !ONLINE && /^\d{1,2}:\d{2}$/.test(Q.get('at') || '') ? Q.get('at').split(':').map(Number) : null;
const T0 = Date.now();
const nowMs = () => AT ? C.central().startMs + (AT[0] * 60 + AT[1]) * 60000 + (Date.now() - T0) : Date.now();

let CFG = C.normalizeConfig(null);
let ME = null;                 // { personId, role: manager|member, email, uid }
let NOW = C.central(new Date(nowMs()));
let RAW = {}, PRES = {};       // presence rows by person / the same with yesterday's leftovers as "out"
let TODAY = null;              // today's planned day
let CALLS = [], LOG = [], REPORTS = [], PROFILES = [], SYNC = null;
let VIEW = (location.hash || '').replace('#', '') || 'today';
let weekIso = NOW.mondayIso, selDay = NOW.dayKey, WEEK = null, weekSaved = true;
let RT = ONLINE ? 'connecting' : 'local';
let DRAFT = null;              // Team screen working copy

const isManager = () => !ME || ME.role === 'manager';
const isOwner = () => !ONLINE || !!(ME && ME.personId === 'owner');
const me = () => (ME && ME.personId ? C.person(CFG, ME.personId) : null);
const myStamp = () => 'user:' + (ME && ME.uid ? ME.uid : 'local');
const tick = () => { NOW = C.central(new Date(nowMs())); };
const refreshPres = () => { PRES = C.freshPresence(Object.values(RAW), NOW.startMs); };
const openNow = () => NOW.mins >= C.OPEN_MIN && NOW.mins < C.CLOSE_MIN;

/* ---------------------------------- data -------------------------------- */
async function loadConfig() {
  if (!ONLINE) { CFG = C.normalizeConfig(ls.get('tcs-config')); return; }
  const { data, error } = await sb.from('app_config').select('data').eq('id', 1).maybeSingle();
  if (!error && data) CFG = C.normalizeConfig(data.data);
}
async function fetchWeek(iso) {
  if (!ONLINE) { const W = ls.get('tcs-cov-' + iso); return { W, saved: !!W }; }
  const { data, error } = await sb.from('schedules').select('data').eq('week_start', iso).maybeSingle();
  return !error && data && data.data ? { W: data.data, saved: true } : { W: null, saved: false };
}
function prepWeek(W, iso) {
  let changed = !W || !W.Mon;
  W = C.ensureWeek(W, CFG);
  if (C.migrateLegacyWeek(W)) changed = true;
  if (C.upgradeTeam(W, iso, NOW.mondayIso, CFG)) changed = true;
  return { W, changed };
}
async function saveWeek(iso, W) {
  if (!ONLINE) { ls.set('tcs-cov-' + iso, W); return; }
  if (!isManager()) return;
  const { error } = await sb.from('schedules').upsert({ week_start: iso, data: W, updated_at: new Date().toISOString() });
  if (error) flash('Could not save the schedule: ' + error.message, true);
  else flash('Saved & shared with the team ✓');
}
let _saveT = null;
function persistWeek() { clearTimeout(_saveT); const iso = weekIso, W = WEEK; _saveT = setTimeout(() => saveWeek(iso, W), 500); if (iso === NOW.mondayIso) { TODAY = W[NOW.dayKey]; evaluateGaps(); } }
async function loadWeek() {
  const r = await fetchWeek(weekIso);
  const p = prepWeek(r.W, weekIso);
  WEEK = p.W; weekSaved = r.saved;
  if (isManager() && (p.changed || !r.saved)) { await saveWeek(weekIso, WEEK); weekSaved = true; }
}
async function loadToday() {
  const r = weekIso === NOW.mondayIso && WEEK && weekSaved ? { W: WEEK } : await fetchWeek(NOW.mondayIso);
  if (!r.W) { TODAY = null; return; }
  const W = JSON.parse(JSON.stringify(r.W));
  C.migrateLegacyWeek(W); C.upgradeTeam(W, NOW.mondayIso, NOW.mondayIso, CFG);
  TODAY = W[NOW.dayKey] || null;
}
async function loadPresence() {
  if (!ONLINE) RAW = ls.get('tcs-presence') || {};
  else {
    const { data, error } = await sb.from('presence').select('*');
    if (!error) { RAW = {}; (data || []).forEach(r => { RAW[r.person_id] = r; }); }
  }
  refreshPres();
}
async function loadCalls() {
  if (!ONLINE) { CALLS = []; return; }
  const [a, b] = await Promise.all([
    sb.from('sales_calls').select('id, city, minute, missed, answered, covering, status').eq('day', NOW.iso).order('minute'),
    sb.from('tick_state').select('*').eq('key', 'calls_sync').maybeSingle(),
  ]);
  if (!a.error) CALLS = a.data || [];
  if (!b.error) SYNC = b.data || null;
}
async function loadLog() {
  if (!isManager()) return;
  if (!ONLINE) { LOG = (ls.get('tcs-log') || []).filter(r => isToday(r.at)); return; }
  const { data, error } = await sb.from('presence_log').select('person_id, state, covering, updated_by, at')
    .gte('at', new Date(NOW.startMs).toISOString()).order('at').limit(3000);
  if (!error) LOG = data || [];
}
async function loadReports() {
  if (!ONLINE || !isManager()) return;
  const { data, error } = await sb.from('reports').select('*').order('day', { ascending: false }).limit(30);
  if (!error) REPORTS = data || [];
}
async function loadProfiles() {
  if (!ONLINE || !isOwner()) return;
  const { data, error } = await sb.from('profiles').select('id, person_id, email, role');
  if (!error) PROFILES = data || [];
}
async function loadAll() {
  tick();
  await loadWeek();
  await Promise.all([loadToday(), loadPresence(), loadCalls(), loadLog(), loadReports(), loadProfiles()]);
}

/* --------------------------------- writes -------------------------------- */
// The ONLY status writes are people's own button presses (or a manager pressing for
// them). Moving cities around after that is the server's job (core.planEvent).
async function setStatus(pid, state, covering) {
  if (!pid) return;
  const prevRaw = RAW[pid] ? { ...RAW[pid] } : null;
  const prev = PRES[pid] || { state: 'out', covering: null };      // yesterday's leftover covering is already dropped
  const cov = state === 'out' ? null : covering !== undefined ? covering : (prev.covering || null);
  RAW[pid] = { person_id: pid, state, covering: cov, updated_at: new Date(nowMs()).toISOString(), updated_by: myStamp() };
  refreshPres(); render();
  if (ONLINE) {
    const { error } = await sb.from('presence').upsert({ person_id: pid, state, covering: cov });
    if (error) {
      if (prevRaw) RAW[pid] = prevRaw; else delete RAW[pid];
      refreshPres(); render();
      flash('Could not save that status: ' + (error.message || 'unknown error'), true);
      return;
    }
  } else localAutomation(RAW[pid], prevRaw);
  evaluateGaps();
}
function addCovering(pid, cid) {
  const cur = C.parseCovering((PRES[pid] || {}).covering);
  if (!cur.includes(cid)) cur.push(cid);
  return setStatus(pid, 'working', C.coveringString(cur));
}
function dropCovering(pid, cid) {
  const pr = PRES[pid] || { state: 'out' };
  return setStatus(pid, pr.state || 'working', C.coveringString(C.parseCovering(pr.covering).filter(x => x !== cid)));
}

/* Local / preview mode has no server, so it runs the server's rules right here and
   shows the text that WOULD go to the office line. */
function localAutomation(rec, old) {
  const logRow = r => LOG.push({ person_id: r.person_id, state: r.state, covering: r.covering, updated_by: r.updated_by, at: r.updated_at });
  logRow(rec);
  const plan = C.planEvent({ cfg: CFG, day: TODAY, presence: PRES, rec, old, mins: NOW.mins, startMs: NOW.startMs });
  if (!plan.skip) {
    plan.writes.forEach(w => {
      if (w.requireWorking && !C.isWorking((PRES[w.pid] || {}).state)) return;
      const before = RAW[w.pid] ? { ...RAW[w.pid] } : null;
      RAW[w.pid] = { ...(RAW[w.pid] || { person_id: w.pid, state: 'out' }), covering: w.covering, updated_by: w.updated_by, updated_at: rec.updated_at };
      logRow(RAW[w.pid]);
      refreshPres();
      directed(w.pid, before, RAW[w.pid]);
    });
    if (plan.msg) toast([h('b', null, '📱 Text to the office line'), h('span', { class: 'sms' }, plan.msg)], { kind: 'info' });
  }
  ls.set('tcs-presence', RAW); ls.set('tcs-log', LOG);
  render();
}

/* --------------------------------- alerts -------------------------------- */
function beep() {
  try {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
    const ctx = new A(), o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.07;
    o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 320);
  } catch (e) { /* no audio */ }
}
function osNotify(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: 'tcs-' + Math.floor(performance.now()), requireInteraction: true }); } catch (e) { /* unsupported */ }
}
function toast(content, { kind = 'info', actions = [], sticky } = {}) {
  const box = h('div', { class: 'toast ' + kind, role: kind === 'urgent' ? 'alert' : 'status' }, h('div', null, content));
  if (actions.length) box.appendChild(h('div', { class: 'acts' }, actions.map(a => h('button', {
    class: 'btn small' + (a.primary ? ' primary' : ''), onclick: () => { if (a.fn) a.fn(); box.remove(); },
  }, a.label))));
  box.appendChild(h('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => box.remove() }, '×'));
  $('#toasts').prepend(box);
  [...document.querySelectorAll('#toasts .toast:not(.urgent)')].slice(3).forEach(t => t.remove());
  if (kind === 'urgent') beep();
  if (!(sticky ?? kind === 'urgent')) setTimeout(() => box.remove(), 10000);
  return box;
}
function flash(msg, isErr) {
  const n = $('#flash'); if (!n) return;
  n.textContent = msg; n.className = 'flash' + (isErr ? ' err' : ''); n.hidden = false;
  clearTimeout(flash._t); flash._t = setTimeout(() => { n.hidden = true; }, isErr ? 6500 : 2400);
}
/* My covering changed and I didn't do it (the server's automatic handoff, or a
   manager): say exactly which sales lines to unmute / mute. */
function directed(pid, before, after) {
  if (!ME || pid !== ME.personId || !after) return;
  const was = before ? C.parseCovering((C.freshPresence([before], NOW.startMs)[pid] || {}).covering) : [];
  const now = C.parseCovering(after.covering);
  const added = now.filter(c => !was.includes(c)), lost = was.filter(c => !now.includes(c));
  const name = C.nameOf(CFG, pid);
  if (added.length && C.isWorking(after.state)) {
    osNotify(`📍 ${name}: you're covering ${C.cityList(CFG, added)}`, `Unmute ${C.lineList(CFG, added)} in OpenPhone.`);
    toast(['📍 ', h('b', null, `${name}, you're now covering ${C.cityList(CFG, added)}.`), ' Unmute ', h('b', null, C.lineList(CFG, added)), ' in OpenPhone so you get their calls & texts.'],
      { kind: 'urgent', actions: [{ label: 'Done, unmuted', primary: true }] });
  }
  if (lost.length) {
    osNotify(`✅ ${name}: you're off ${C.cityList(CFG, lost)}`, `You can mute ${C.lineList(CFG, lost)} again.`);
    toast(['✅ ', h('b', null, `${name}, you're off ${C.cityList(CFG, lost)}.`), ' You can mute ', h('b', null, C.lineList(CFG, lost)), ' in OpenPhone again.'], { kind: 'good' });
  }
}
/* A city with nobody working during 8–6 (not a one-person day). With automatic handoff
   on, the server gets the first ~30 s to hand it to someone before anyone is alarmed. */
const GAPS = {};
function evaluateGaps() {
  if (!TODAY) return;
  const solo = C.isSoloDay(TODAY, CFG), delay = CFG.settings.autoHandoff ? 30000 : 5000;
  CFG.cities.forEach(c => {
    const g = GAPS[c.id] = GAPS[c.id] || {};
    const isGap = () => { const s = C.onCity(TODAY, PRES, c.id, CFG); return !solo && openNow() && s.assigned.length > 0 && s.working.length === 0; };
    if (isGap()) {
      if (!g.alerted && !g.timer) g.timer = setTimeout(() => { g.timer = null; if (isGap()) { g.alerted = true; g.box = gapAlert(c); } }, delay);
    } else {
      g.alerted = false;
      if (g.timer) { clearTimeout(g.timer); g.timer = null; }
      if (g.box) { g.box.remove(); g.box = null; }
    }
  });
}
function gapAlert(c) {
  const actions = [];
  const p = me();
  if (p && !p.former) actions.push({ label: "I'll cover it", primary: true, fn: () => addCovering(p.id, c.id) });
  const away = C.onCity(TODAY, PRES, c.id, CFG).assigned;
  if (isManager()) C.activePeople(CFG).filter(x => (!p || x.id !== p.id) && !away.includes(x.id))
    .sort((a, b) => Number(C.isWorking((PRES[b.id] || {}).state)) - Number(C.isWorking((PRES[a.id] || {}).state)))
    .slice(0, 3).forEach(x => actions.push({ label: `${C.firstName(x)} has it`, fn: () => addCovering(x.id, c.id) }));
  osNotify('⚠ Coverage needed', `${c.name} has no one on right now.`);
  return toast(['⚠ ', h('b', null, c.name), ' has ', h('b', null, 'no one covering'), ' right now. Anyone can jump in.',
    CFG.settings.autoHandoff ? h('span', { class: 'sms' }, 'Nobody was free to take it automatically.') : null], { kind: 'urgent', actions });
}

/* ----------------------------- live updates ------------------------------ */
let _ch = null, _wasUp = false;
function subscribe() {
  if (!ONLINE || _ch) return;
  let ch = sb.channel('tcs-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, onPresence)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'schedules' }, onSchedule)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_config' }, onConfig)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_calls' }, onCall);
  if (isManager()) ch = ch
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'presence_log' }, onLog)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, () => loadReports().then(() => soon('reports')));
  _ch = ch.subscribe(st => {
    const reconnected = st === 'SUBSCRIBED' && _wasUp && RT !== 'SUBSCRIBED';
    RT = st;
    if (st === 'SUBSCRIBED') _wasUp = true;
    if (reconnected) refreshLive();          // events missed while the socket was down are never replayed
    renderHeader();
  });
}
function onPresence(payload) {
  const row = payload && payload.new && payload.new.person_id ? payload.new : null;
  if (!row) return;
  const before = RAW[row.person_id] ? { ...RAW[row.person_id] } : null;
  RAW[row.person_id] = row; refreshPres();
  if (row.updated_by !== myStamp()) directed(row.person_id, before, row);
  soon('today', 'reports'); evaluateGaps();
}
async function onSchedule(payload) {
  const iso = ((payload && (payload.new || payload.old)) || {}).week_start;
  if (iso === weekIso) await loadWeek();
  if (iso === NOW.mondayIso) await loadToday();
  soon('today', 'week', 'reports'); evaluateGaps();
}
function onConfig(payload) {
  if (!payload || !payload.new) return;
  CFG = C.normalizeConfig(payload.new.data);
  refreshPres();
  if (VIEW === 'team' && draftDirty()) flash('The team setup was just changed on another device. Save or Discard to see it.');
  else { DRAFT = null; soon('today', 'week', 'team', 'reports'); }
}
function onCall(payload) {
  const r = payload && payload.new;
  if (!r || r.day !== NOW.iso) return;
  const i = CALLS.findIndex(x => x.id === r.id);
  if (i >= 0) CALLS[i] = r; else CALLS.push(r);
  soon('today', 'reports');
}
function onLog(payload) {
  const row = payload && payload.new;
  if (!row || !isToday(row.at)) return;
  const n = C.describeLog(CFG, LOG, NOW.startMs).length;
  LOG.push(row);
  if (row.updated_by !== myStamp()) C.describeLog(CFG, LOG, NOW.startMs).slice(n).forEach(e =>
    toast([e.text, e.auto ? h('span', { class: 'tag auto', style: 'margin-left:6px' }, '⚡ automatic') : null], { kind: 'info' }));
  soon('today', 'reports');
}
let _refreshing = false;
async function refreshLive() {
  if (!ONLINE || !ME || _refreshing) return;
  _refreshing = true;
  try { await Promise.all([loadToday(), loadPresence(), loadCalls(), loadLog()]); soon('today', 'reports'); evaluateGaps(); }
  catch (e) { /* the next event or tick heals it */ }
  finally { _refreshing = false; }
}
let _rq = null, _rv = new Set();
function soon(...views) {                  // re-render only if the visible tab cares
  renderHeader();
  if (!views.includes(VIEW) || (VIEW === 'team' && DRAFT)) return;
  views.forEach(v => _rv.add(v));
  if (_rq) return;
  _rq = requestAnimationFrame(() => { _rq = null; if (_rv.has(VIEW)) render(); _rv.clear(); });
}
setInterval(async () => {
  const day = NOW.iso; tick();
  if (NOW.iso !== day) { weekIso = NOW.mondayIso; selDay = NOW.dayKey; if (ME || !ONLINE) { await loadAll(); render(); } }
  soon('today', 'reports'); evaluateGaps();
}, 30000);
setInterval(() => refreshLive(), 180000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); refreshLive(); soon('today', 'reports'); } });

/* -------------------------------- shell --------------------------------- */
function tabsFor() {
  return isManager()
    ? [['today', 'Today'], ['week', 'Week'], ['team', 'Team'], ['reports', 'Reports']]
    : [['today', 'Today'], ['week', 'My week']];
}
function go(view) {
  if (VIEW === 'team' && view !== 'team' && DRAFT && JSON.stringify(C.normalizeConfig(DRAFT)) !== JSON.stringify(CFG)
    && !confirm('You have unsaved Team changes. Leave without saving?')) return;
  if (view !== 'team') DRAFT = null;
  VIEW = view;
  try { history.replaceState(null, '', view === 'today' ? location.pathname + location.search : '#' + view); } catch (e) { /* file:// */ }
  window.scrollTo(0, 0);
  render();
}
function renderHeader() {
  $('#topDate').textContent = tzDate(nowMs(), { weekday: 'long', month: 'short', day: 'numeric' }) + (AT ? ` · ${C.fmtTime(NOW.mins)} (preview)` : '');
  const live = $('#live');
  live.className = 'live ' + (!ONLINE ? 'local' : RT === 'SUBSCRIBED' ? 'on' : 'off');
  live.textContent = !ONLINE ? 'Local' : RT === 'SUBSCRIBED' ? 'Live' : 'Connecting';
  const p = me();
  $('#whoName').textContent = ME ? (p ? C.firstName(p) : ME.email) + (isManager() ? ' · Manager' : '') : 'Local manager';
  $('#signOut').hidden = !ONLINE;
  const bare = TODAY && openNow() && !C.isSoloDay(TODAY, CFG)
    ? CFG.cities.filter(c => { const s = C.onCity(TODAY, PRES, c.id, CFG); return s.assigned.length && !s.working.length; }).length : 0;
  $('#tabs').replaceChildren(...tabsFor().map(([id, label]) => h('button', {
    class: 'tab' + (VIEW === id ? ' on' : ''), type: 'button', onclick: () => go(id), 'aria-current': VIEW === id ? 'page' : null, 'aria-label': label,
  }, icon(id), h('span', null, label), id === 'today' && bare ? h('span', { class: 'badge' }, bare) : null)));
}
function render() {
  if (!tabsFor().some(([id]) => id === VIEW)) VIEW = 'today';
  renderHeader();
  const y = window.scrollY;
  const views = { today: viewToday, week: isManager() ? viewWeek : viewMyWeek, team: viewTeam, reports: viewReports };
  $('#view').replaceChildren(views[VIEW]());
  window.scrollTo(0, y);
  const strip = document.querySelector('.days'), sel = strip && strip.querySelector('.daypill.sel');
  if (sel) strip.scrollLeft = sel.offsetLeft - strip.offsetLeft - (strip.clientWidth - sel.offsetWidth) / 2;   // keep the chosen day in view (sideways only)
}
const section = (title, sub, ...body) => h('section', { class: 'sec' },
  h('div', { class: 'sec-head' }, h('h2', null, title), sub ? (typeof sub === 'string' ? h('p', null, sub) : sub) : null), ...body);

/* =============================== TODAY =================================== */
function shiftFor(day, pid, cid) {
  const a = ((day && day.assign) || []).find(x => x.personId === pid && (!cid || x.group === cid) && !x.backup)
    || ((day && day.assign) || []).find(x => x.personId === pid && (!cid || x.group === cid));
  return a ? C.shiftTimes(a, CFG) : null;
}
const shiftText = t => (t ? `${C.fmtClock(t.start)}–${C.fmtClock(t.end)}` : '');

function viewToday() {
  const wrap = h('div', { class: 'sec', style: 'gap:18px' });
  const p = me();
  if (p && !p.former) wrap.append(statusCard(p));
  const np = notifPrompt(); if (np) wrap.append(np);
  if (!TODAY) wrap.append(h('div', { class: 'notice' }, "This week's schedule isn't posted yet: cities show only who is covering by hand."));
  else if (C.isSoloDay(TODAY, CFG)) wrap.append(h('div', { class: 'notice ok' }, `One-person day: ${C.nameOf(CFG, C.dayPeople(TODAY, CFG)[0])} covers every city. Uncovered minutes are expected, so there are no alarms.`));
  const sub = openNow() ? 'Live from everyone’s status buttons.' : `Office hours are 8 AM – 6 PM.`;
  wrap.append(section('Cities right now', sub, h('div', { class: 'grid-cities' }, CFG.cities.map(cityCard))));
  if (isManager()) {
    wrap.append(section('Team', 'Tap a status to change it for someone.', h('div', { class: 'card people' }, C.activePeople(CFG).map(p => personRow(p)))));
    wrap.append(section("Today's activity", callsNote(), h('div', { class: 'card feed' }, feedItems())));
    wrap.append(autoLine());
  } else {
    wrap.append(section('Team now', null, h('div', { class: 'card people' },
      C.activePeople(CFG).filter(x => x.role !== 'owner' || C.isWorking((PRES[x.id] || {}).state)).map(x => personRow(x, true)))));
  }
  return wrap;
}

function statusCard(p) {
  const pr = PRES[p.id] || { state: 'out' }, st = pr.state || 'out';
  const cov = C.parseCovering(pr.covering);
  const ids = CFG.cities.map(c => c.id);
  const planned = TODAY ? ids.filter(cid => C.plannedPrimaries(TODAY, cid, CFG).includes(p.id)) : [];
  const backups = TODAY ? ids.filter(cid => C.plannedBackups(TODAY, cid, CFG).includes(p.id) && !planned.includes(cid)) : [];
  const adhoc = cov.filter(c => !planned.includes(c));
  const t = shiftFor(TODAY, p.id);
  const head = { working: "You're working", break: "You're on break", away: 'You stepped away', out: "You're clocked out" }[st] || st;
  const since = pr.stale ? "Didn't clock out last time" : pr.updated_at && isToday(pr.updated_at) ? 'since ' + clockOf(pr.updated_at) : '';
  const info = [];
  if (planned.length) info.push(h('div', null, 'Your cities today: ', h('b', null, C.cityList(CFG, planned))));
  if (backups.length) info.push(h('div', null, 'Backup for ', h('b', null, C.cityList(CFG, backups)), h('span', { class: 'muted' }, CFG.settings.autoHandoff ? ': you get them automatically when they have no one.' : '.')));
  if (t) info.push(h('div', { class: 'muted' }, `Shift ${shiftText(t)}${C.hasLunch(t) ? ` · lunch ${C.fmtClock(t.lunchStart)}–${C.fmtClock(t.lunchEnd)}` : ' · no break'}`));
  if (!planned.length && !backups.length) info.push(h('div', { class: 'muted' }, TODAY ? "You're not on today's schedule." : "This week's schedule isn't posted yet."));
  const remind = C.isWorking(st) && adhoc.length
    ? h('div', { class: 'unmute' }, h('b', null, `🔔 You're covering ${C.cityList(CFG, adhoc)}.`), ' Keep these unmuted in OpenPhone:',
      h('ul', null, C.salesLines(CFG, adhoc).map(l => h('li', null, h('b', null, l.name), h('span', { class: 'muted' }, ' · ' + fmtPhone(l.number))))))
    : null;
  const btn = (state, label, small, cls) => h('button', { class: `sbtn ${cls}${st === state ? ' on' : ''}`, type: 'button', onclick: () => setStatus(p.id, state) },
    label, small ? h('small', null, small) : null);
  return h('section', { class: `card status st-${st}` },
    h('div', { class: 'status-now' }, h('h2', null, head), h('span', { class: 'muted small' }, since)),
    h('div', { class: 'status-lines' }, info), remind,
    h('div', { class: 'status-btns' },
      btn('working', 'Clock in', 'or I’m back', 'go'), btn('break', 'Break', 'lunch', 'amber'),
      btn('away', 'Step away', 'a few min', 'amber'), btn('out', 'Clock out', 'done for today', 'out')));
}

function cityCard(c) {
  const s = C.onCity(TODAY, PRES, c.id, CFG);
  const solo = TODAY && C.isSoloDay(TODAY, CFG);
  const cls = s.working.length ? 'ok' : !openNow() ? 'closed' : solo ? 'solo' : 'bad';
  const label = { ok: 'Covered', closed: 'Closed', solo: 'Expected gap', bad: 'No one on' }[cls];
  const planned = TODAY ? C.plannedPrimaries(TODAY, c.id, CFG) : [];
  const backups = TODAY ? C.plannedBackups(TODAY, c.id, CFG).filter(id => !planned.includes(id)) : [];
  const onNow = s.working.map(id => {
    const adhoc = !planned.includes(id);
    return h('span', null, C.nameOf(CFG, id), adhoc ? h('span', { class: 'muted' }, ' (covering)') : null,
      adhoc && isManager() ? h('button', { class: 'link-btn small', title: 'Take off this city', onclick: () => dropCovering(id, c.id) }, '×') : null);
  });
  const calls = CALLS.filter(k => k.city === c.id && k.minute >= C.OPEN_MIN && k.minute < C.CLOSE_MIN);
  const missed = calls.filter(k => k.missed);
  return h('article', { class: `card city${cls === 'bad' ? ' bad' : ''}`, style: `--cc:${c.color}` },
    h('div', { class: 'spread' }, h('h3', null, c.name), h('span', { class: 'chip ' + cls }, label)),
    h('dl', { class: 'kv' },
      h('dt', null, 'On now'), h('dd', null, onNow.length ? onNow.map((n, i) => [i ? ', ' : '', n]) : '—'),
      h('dt', null, 'Planned'), h('dd', null, planned.length ? planned.map(id => `${C.nameOf(CFG, id)} ${shiftText(shiftFor(TODAY, id, c.id))}`).join(', ') : 'nobody',
        backups.length ? h('span', { class: 'muted' }, ` · backup ${C.joinList(backups.map(id => C.nameOf(CFG, id)))}`) : null),
      h('dt', null, 'Calls'), h('dd', null, `${calls.length} today`,
        missed.length ? h('b', { style: 'color:var(--bad)' }, ` · ${missed.length} missed`) : calls.length ? h('span', { class: 'muted' }, ' · none missed') : null)),
    missed.length ? h('div', { class: 'missed' }, missed.slice(-4).map(k => h('div', null,
      `Missed ${C.fmtClock(k.minute)} · ${k.covering && k.covering.length ? C.joinList(k.covering) + ' was on' : 'no one was on'}`))) : null,
    h('div', { class: 'lines' }, (c.salesLines || []).length
      ? c.salesLines.map(l => h('div', null, `${l.name} · ${fmtPhone(l.number)}`)) : 'No sales lines set (Team tab).'),
    isManager() ? coverPicker(c) : null);
}
function coverPicker(c) {
  const opts = C.activePeople(CFG).filter(p => !C.parseCovering((PRES[p.id] || {}).covering).includes(c.id));
  const sel = h('select', { class: 'cover-pick', 'aria-label': `Add someone to cover ${c.name}` },
    h('option', { value: '' }, `＋ Add someone to cover ${c.short}…`),
    opts.map(p => h('option', { value: p.id }, `${C.firstName(p)}${C.isWorking((PRES[p.id] || {}).state) ? '' : ' (will be clocked in)'}`)));
  sel.addEventListener('change', () => { const pid = sel.value; if (pid) addCovering(pid, c.id); });
  return sel;
}
function personRow(p, readonly) {
  const pr = PRES[p.id] || { state: 'out' }, st = pr.state || 'out';
  const cities = C.personCities(TODAY, PRES, p.id, CFG);
  const sub = [(C.STATES[st] || st) + (pr.updated_at && !pr.stale && isToday(pr.updated_at) ? ' since ' + clockOf(pr.updated_at) : '')];
  if (pr.stale) sub.push(`didn't clock out ${tzDate(pr.updated_at, { month: 'short', day: 'numeric' })}`);
  if (cities.length) sub.push((C.isWorking(st) ? 'on ' : 'today: ') + C.cityList(CFG, cities));
  const mk = (state, label) => h('button', { class: st === state ? 'on' : '', type: 'button', onclick: () => setStatus(p.id, state) }, label);
  return h('div', { class: 'person' },
    h('span', { class: 'dot', style: `background:${p.color}` }),
    h('div', { class: 'who-col' }, h('b', null, C.firstName(p)), h('div', { class: 'sub' }, sub.join(' · '))),
    readonly ? h('span', { class: 'chip ' + (st === 'working' ? 'ok' : st === 'out' ? 'closed' : 'warn') }, C.STATES[st] || st)
      : h('div', { class: 'mini' }, mk('working', 'In'), mk('break', 'Break'), mk('away', 'Away'), mk('out', 'Out')));
}
function feedItems() {
  const items = C.describeLog(CFG, LOG, NOW.startMs).reverse();
  if (!items.length) return h('div', { class: 'empty' }, ONLINE ? 'Nothing yet today.' : 'Tap statuses above to see the automation work.');
  return items.slice(0, 80).map(it => h('div', { class: 'feed-item' }, h('time', null, C.fmtClock(it.min)),
    h('div', null, it.text, it.auto ? h('span', { class: 'tag auto', style: 'margin-left:6px' }, '⚡ automatic') : null)));
}
function callsNote() {
  if (!ONLINE) return 'Calls show here once the app is online.';
  const wrap = h('p', null, SYNC ? `Sales-line calls update every 5 minutes (last ${ago(SYNC.at)}). ` : 'Sales-line calls update every 5 minutes. ');
  if (isManager()) wrap.append(h('button', { class: 'link-btn', onclick: syncNow }, 'Refresh now'));
  return wrap;
}
function autoLine() {
  const s = CFG.settings;
  return h('div', { class: 'auto-line' }, '⚡',
    h('span', null, s.autoHandoff ? 'Automatic handoff is on' : 'Automatic handoff is off'), '·',
    h('span', null, s.autoRelieve ? 'stand-ins come off automatically' : 'stand-ins stay until removed'), '·',
    h('span', null, s.reportEnabled ? `report texts at ${C.fmtTime(hhmm(s.reportAt))}` : 'daily report off'),
    h('button', { class: 'link-btn', onclick: () => go('team') }, 'Change'));
}
function notifPrompt() {
  if (!(me() || isManager()) || !('Notification' in window) || Notification.permission === 'granted') return null;
  if (Notification.permission === 'denied') return h('div', { class: 'notice bad' }, '🔕 Pop-up alerts are blocked for this page. Turn them on in your browser’s site settings, then reload.');
  return h('div', { class: 'notice spread' }, h('span', null, '🔔 Turn on pop-up alerts so you hear when a city needs you.'),
    h('button', { class: 'btn small brand', onclick: () => { try { Notification.requestPermission().then(() => render()); } catch (e) { /* old browser */ } } }, 'Turn on'));
}
async function syncNow() {
  if (!ONLINE) return;
  flash('Checking the sales lines…');
  const { data, error } = await sb.functions.invoke('coverage-tick', { body: { action: 'sync' } });
  if (error || !data || !data.ok) { flash('Could not refresh calls: ' + ((error && error.message) || (data && data.error) || 'unknown'), true); return; }
  await loadCalls(); render(); flash(`Calls updated ✓ (${data.sync.calls} today, ${data.sync.missed} missed)`);
}

/* ================================ WEEK ===================================== */
async function goWeek(n) {
  weekIso = n === 0 ? NOW.mondayIso : isoAdd(weekIso, n);
  if (weekIso === NOW.mondayIso) selDay = NOW.dayKey; else if (!C.DAYS.includes(selDay)) selDay = 'Mon';
  WEEK = null; render();
  await loadWeek(); render();
}
function weekNav() {
  return h('div', { class: 'weeknav' },
    h('button', { class: 'btn small', 'aria-label': 'Previous week', onclick: () => goWeek(-7) }, '‹'),
    h('span', { class: 'label' }, `${isoPretty(weekIso)} – ${isoPretty(isoAdd(weekIso, 6))}`),
    h('button', { class: 'btn small', 'aria-label': 'Next week', onclick: () => goWeek(7) }, '›'),
    weekIso !== NOW.mondayIso ? h('button', { class: 'btn small ghost', onclick: () => goWeek(0) }, 'This week') : null);
}
function viewWeek() {
  if (!WEEK) return h('div', { class: 'empty' }, 'Loading the week…');
  const sums = C.DAYS.map(d => C.daySummary(WEEK[d], CFG));
  const bad = C.DAYS.filter((d, i) => sums[i].cls === 'bad'), solo = C.DAYS.filter((d, i) => sums[i].cls === 'solo');
  return h('div', { class: 'sec', style: 'gap:18px' },
    h('div', { class: 'spread', style: 'flex-wrap:wrap' }, weekNav(),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { if (confirm('Rebuild the whole week from who is marked Working? This replaces every assignment this week.')) { C.DAYS.forEach(d => C.buildDay(WEEK[d], CFG)); persistWeek(); render(); } } }, '⚡ Rebuild week'),
        h('button', { class: 'btn small', onclick: printWeek }, 'Print'))),
    h('div', { class: 'notice ' + (bad.length ? 'bad' : 'ok') }, bad.length
      ? `⚠ ${C.joinList(bad.map(d => FULLDAY[d]))} ${bad.length > 1 ? 'have' : 'has'} a city nobody covers. Open the day below and add someone.`
      : `✓ Every city is covered all week.${solo.length ? ` ${C.joinList(solo.map(d => FULLDAY[d]))} ${solo.length > 1 ? 'are one-person days' : 'is a one-person day'}: the grey gaps there are expected.` : ''}`),
    section("Who's working", 'Tap to switch Work / Off / PTO. That day rebuilds itself.', h('div', { class: 'card avail-wrap' }, availGrid())),
    h('div', { class: 'days', role: 'tablist' }, C.DAYS.map((d, i) => h('button', {
      class: `daypill${d === selDay ? ' sel' : ''}${weekIso === NOW.mondayIso && d === NOW.dayKey ? ' today' : ''}`, role: 'tab', onclick: () => { selDay = d; render(); },
    }, h('b', null, d), h('span', null, isoPretty(isoAdd(weekIso, i))), h('i', { class: sums[i].cls }, sums[i].text)))),
    dayDetail(selDay));
}
function availGrid() {
  const head = h('tr', null, h('th', { class: 'name' }, ''), C.DAYS.map((d, i) => h('th', null, d, h('small', null, isoPretty(isoAdd(weekIso, i))))));
  const rows = C.activePeople(CFG).map(p => h('tr', null, h('td', { class: 'name' }, h('span', { class: 'dot', style: `background:${p.color};margin-right:6px` }), C.firstName(p)),
    C.DAYS.map(d => {
      const v = WEEK[d].status[p.id] || 'off';
      return h('td', null, h('button', { class: 'cyc ' + v, type: 'button', 'aria-label': `${C.firstName(p)} ${d}: ${v}`, onclick: () => {
        WEEK[d].status[p.id] = { work: 'off', off: 'pto', pto: 'work' }[v];
        C.buildDay(WEEK[d], CFG); persistWeek(); render();
      } }, { work: 'Work', off: 'Off', pto: 'PTO' }[v]));
    })));
  return h('table', { class: 'avail' }, h('thead', null, head), h('tbody', null, rows));
}
function timeline(arr, solo) {
  const labels = ['8a', '10a', '12p', '2p', '4p', '6p'];
  return [h('div', { class: 'tl', title: 'Green = 2+ people · amber = one · red = nobody · grey = expected (one-person day)' },
    arr.map(s => h('div', { class: s.length >= 2 ? 'c2' : s.length === 1 ? 'c1' : solo ? 'cx' : 'c0' }))),
  h('div', { class: 'tl-hours' }, labels.map(l => h('span', null, l)))];
}
function dayDetail(d) {
  const day = WEEK[d], cov = C.computeCoverage(day, CFG), solo = C.isSoloDay(day, CFG);
  const cards = CFG.cities.map(c => {
    const list = day.assign.filter(a => a.group === c.id);
    const owner = C.ownerOfCity(CFG, c.id);
    const firstPrimary = list.find(a => !a.backup);
    return h('article', { class: 'card city', style: `--cc:${c.color}` },
      h('div', { class: 'spread' }, h('h3', null, c.name), h('span', { class: 'muted small' }, owner ? 'Owner: ' + C.firstName(owner) : 'No fixed owner')),
      timeline(cov[c.id], solo),
      list.length ? list.map(a => assignRow(day, a, a === firstPrimary)) : h('div', { class: 'empty' }, 'Nobody assigned.'),
      h('button', { class: 'btn small ghost', onclick: () => addAssign(day, c.id) }, '+ Add person'));
  });
  return h('div', { class: 'sec', style: 'gap:12px' },
    h('div', { class: 'sec-head' }, h('h2', null, `${FULLDAY[d]}, ${isoPretty(isoAdd(weekIso, C.DAYS.indexOf(d)))}`),
      h('button', { class: 'btn small', onclick: () => { C.buildDay(day, CFG); persistWeek(); render(); } }, 'Rebuild this day')),
    h('div', { class: 'grid-cities wide' }, cards),
    section('Coverage rules', null, h('div', { class: 'card rules' }, C.validateDay(day, CFG).map(r => h('div', { class: 'rule ' + r.level }, r.text)))));
}
function assignRow(day, a, isFirstPrimary) {
  const people = CFG.people.filter(p => !p.former || p.id === a.personId);
  const ppl = h('select', { class: 'inp', 'aria-label': 'Person' }, people.map(p => h('option', { value: p.id, selected: p.id === a.personId },
    `${C.firstName(p)}${(day.status[p.id] || 'off') !== 'work' ? ' (' + (day.status[p.id] || 'off').toUpperCase() + ')' : ''}`)));
  ppl.addEventListener('change', () => { a.personId = ppl.value; persistWeek(); render(); });
  const sh = h('select', { class: 'inp', 'aria-label': 'Shift' }, Object.keys(C.SHIFTS).map(k => {
    const t = C.shiftTimes({ personId: a.personId, preset: k }, CFG);
    return h('option', { value: k, selected: (a.preset || 'open') === k }, `${C.SHIFTS[k].label} ${shiftText(t)}${C.hasLunch(t) ? '' : ' (no break)'}`);
  }));
  sh.addEventListener('change', () => { a.preset = sh.value; persistWeek(); render(); });
  return h('div', { class: 'arow' + (a.backup ? ' bk' : '') },
    h('span', { class: 'role' }, a.backup ? 'Backup' : isFirstPrimary ? 'Primary' : '2nd'), ppl, sh,
    h('button', { class: 'xbtn', 'aria-label': 'Remove', onclick: () => { day.assign = day.assign.filter(z => z.id !== a.id); persistWeek(); render(); } }, '×'));
}
function addAssign(day, cid) {
  const taken = day.assign.filter(a => a.group === cid).map(a => a.personId);
  const cand = C.activePeople(CFG).find(p => !taken.includes(p.id) && (C.isFlexible(p) || C.ownsCity(p, cid)) && day.status[p.id] === 'work')
    || C.activePeople(CFG).find(p => !taken.includes(p.id));
  day.assign.push({ id: C.newId(), personId: cand ? cand.id : 'owner', group: cid, preset: taken.length ? 'close' : 'open' });
  persistWeek(); render();
}
function printWeek() {
  const sheet = $('#printSheet');
  sheet.replaceChildren(h('h1', null, `TCS office coverage · ${isoPretty(weekIso)} – ${isoPretty(isoAdd(weekIso, 6))}`),
    h('table', null, h('thead', null, h('tr', null, h('th', null, 'City'), C.DAYS.map((d, i) => h('th', null, `${d} ${isoPretty(isoAdd(weekIso, i))}`)))),
      h('tbody', null, CFG.cities.map(c => h('tr', null, h('th', null, c.name), C.DAYS.map(d => h('td', null,
        WEEK[d].assign.filter(a => a.group === c.id && !C.isFormer(CFG, a.personId)).map(a => h('div', null,
          `${C.nameOf(CFG, a.personId)} ${shiftText(C.shiftTimes(a, CFG))}${a.backup ? ' (backup)' : ''}`)))))))));
  window.print();
}

/* -------------------------------- MY WEEK ---------------------------------- */
function viewMyWeek() {
  const p = me();
  const wrap = h('div', { class: 'sec', style: 'gap:16px' }, weekNav());
  if (!WEEK) { wrap.append(h('div', { class: 'empty' }, 'Loading…')); return wrap; }
  if (ONLINE && !weekSaved) { wrap.append(h('div', { class: 'notice' }, "This week's schedule isn't posted yet. Check back soon.")); return wrap; }
  if (!p) { wrap.append(h('div', { class: 'notice' }, 'Your login isn’t linked to a team member yet. Ask your manager.')); return wrap; }
  wrap.append(h('p', { class: 'muted small' }, C.takesLunch(p) ? 'Each shift includes a 1-hour lunch in the middle. Your cities are covered while you’re out.' : `You work a ${C.maxWorkMin(p) / 60}-hour day with no scheduled break.`));
  C.DAYS.forEach((d, i) => {
    const day = WEEK[d], mine = day.assign.filter(a => a.personId === p.id && C.city(CFG, a.group));
    const card = h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h3', null, `${FULLDAY[d]} `, h('span', { class: 'muted small' }, isoPretty(isoAdd(weekIso, i)))),
      !mine.length ? h('span', { class: 'chip ' + ((day.status[p.id] || 'off') === 'pto' ? 'warn' : 'closed') }, (day.status[p.id] || 'off') === 'pto' ? 'PTO' : (day.status[p.id] || 'off') === 'work' ? 'Not scheduled' : 'Off') : null));
    const groups = {};
    mine.forEach(a => {
      const t = C.shiftTimes(a, CFG), k = `${t.start}-${t.end}-${t.lunchStart}`;
      (groups[k] = groups[k] || { t, main: [], bk: [] })[a.backup ? 'bk' : 'main'].push(a.group);
    });
    Object.values(groups).forEach(g => {
      const c0 = C.city(CFG, g.main[0] || g.bk[0]);
      card.append(h('div', { class: 'myday', style: `--cc:${c0 ? c0.color : 'var(--brand)'}` },
        g.main.length ? h('div', null, h('b', null, C.cityList(CFG, g.main))) : null,
        g.bk.length ? h('div', null, 'Backup for ', h('b', null, C.cityList(CFG, g.bk))) : null,
        h('div', { class: 'muted' }, `${shiftText(g.t)}${C.hasLunch(g.t) ? ` · lunch ${C.fmtClock(g.t.lunchStart)}–${C.fmtClock(g.t.lunchEnd)}` : ' · no break'}`)));
    });
    wrap.append(card);
  });
  return wrap;
}

/* ================================ TEAM ===================================== */
const draftDirty = () => !!DRAFT && JSON.stringify(C.normalizeConfig(DRAFT)) !== JSON.stringify(CFG);
function touch() {                       // a text field changed: show/hide the save bar, no re-render
  const has = $('.savebar');
  if (draftDirty() && !has) $('#view').append(saveBar());
  if (!draftDirty() && has) has.remove();
}
const field = (label, input) => h('label', { class: 'field' }, label, input);
function textInput(value, onval, attrs = {}) {
  const i = h('input', { class: 'inp', value: value == null ? '' : value, ...attrs });
  i.addEventListener('input', () => { onval(i.value); touch(); });
  return i;
}
function toggleRow(title, desc, checked, onval) {
  const box = h('input', { type: 'checkbox', checked });
  box.addEventListener('change', () => { onval(box.checked); render(); });
  return h('label', { class: 'switch' }, box, h('div', null, h('b', null, title), h('span', null, desc)));
}
function pickList(options, chosen, onval) {
  return h('div', { class: 'pick' }, options.map(([id, label]) => h('button', {
    class: chosen.includes(id) ? 'on' : '', type: 'button',
    onclick: () => { onval(chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]); render(); },
  }, label)));
}
function saveBar() {
  return h('div', { class: 'savebar' }, h('span', null, 'Unsaved changes'),
    h('button', { class: 'btn small', onclick: () => { DRAFT = null; render(); } }, 'Discard'),
    h('button', { class: 'btn small primary', onclick: saveDraft }, 'Save'));
}
function viewTeam() {
  if (!isManager()) return h('div', { class: 'empty' }, 'Managers only.');
  if (!DRAFT) DRAFT = JSON.parse(JSON.stringify(CFG));
  const s = DRAFT.settings;
  const wrap = h('div', { class: 'sec', style: 'gap:20px' },
    section('Automation', 'What the app does by itself. People always press their own status buttons; it never clocks anyone in or out.', h('div', { class: 'card' },
      toggleRow('Automatic break handoff', 'When someone goes on break, steps away or clocks out, their cities go to whoever is working (their backup first). That person gets a pop-up, and the office line gets a text naming the sales lines to unmute. A clock-in also picks up the cities that person is today’s backup for.', s.autoHandoff, v => { s.autoHandoff = v; }),
      toggleRow('Take stand-ins off automatically', 'When the person is back, whoever covered for them comes off those cities and is told they can mute them again.', s.autoRelieve, v => { s.autoRelieve = v; }),
      toggleRow('End-of-day report', 'A text to the office line every evening: coverage per city, gaps, breaks, and missed sales calls with who was covering.', s.reportEnabled, v => { s.reportEnabled = v; }),
      h('div', { class: 'fields', style: 'margin-top:8px' },
        field('Report time (Central)', textInput(s.reportAt, v => { s.reportAt = v; }, { type: 'time' })),
        field('Texts go to', textInput(s.alertTo, v => { s.alertTo = v.trim(); }, { placeholder: 'Office line (+1 254-318-4440)', inputmode: 'tel' }))))),
    section('People', 'Renaming is safe. Mark someone “Left the team” instead of deleting them, so past weeks keep their name.', h('div', { class: 'card' }, peopleEditor(),
      h('button', { class: 'btn small', style: 'margin-top:12px', onclick: () => { DRAFT.people.push({ id: 'new' + Date.now().toString(36), _new: true, name: '', role: 'backup', home: [], color: '#64748b' }); render(); } }, '+ Add person'))),
    section('Cities & sales lines', 'Only SALES lines. These are the lines named in unmute / mute texts and counted for missed calls. The line ID (PN…) is on each line’s settings in OpenPhone.', h('div', { class: 'sec', style: 'gap:12px' }, DRAFT.cities.map(cityEditor))),
    section('Default week', 'Who is marked Working when a new week is created. Existing weeks don’t change.', h('div', { class: 'card' }, C.DAYS.map(d => h('div', { class: 'dw' }, h('b', null, d),
      pickList(DRAFT.people.filter(p => !p.former).map(p => [p.id, C.firstName(p) || 'New person']), DRAFT.defaultWeek[d] || [], ids => { DRAFT.defaultWeek[d] = ids; }))))),
    ONLINE && isOwner() ? section('Logins & access', 'Link each login to a person. Managers can edit everything; members see their own week. Create new logins in Supabase → Authentication, then link them here.', h('div', { class: 'card' }, accessList())) : null,
    section('Check this device', null, h('div', { class: 'card row' },
      h('button', { class: 'btn', onclick: selfTest }, 'Run alert self-test'),
      ONLINE ? h('button', { class: 'btn', onclick: testText }, 'Send a test text') : null,
      ONLINE ? h('button', { class: 'btn', onclick: () => go('reports') }, 'Preview today’s report') : null)));
  if (draftDirty()) wrap.append(saveBar());
  return wrap;
}
function peopleEditor() {
  const rows = [...DRAFT.people].sort((a, b) => Number(!!a.former) - Number(!!b.former));
  return rows.map(p => {
    const isOwnerRow = p.id === 'owner';
    const role = h('select', { class: 'inp', disabled: isOwnerRow }, [['rep', 'City owner'], ['backup', 'Any city'], ['owner', 'Last resort']]
      .map(([v, l]) => h('option', { value: v, selected: (p.role === 'floater' ? 'backup' : p.role) === v }, l)));
    role.addEventListener('change', () => { p.role = role.value; if (p.role !== 'rep') p.home = []; render(); });
    const color = h('input', { type: 'color', class: 'inp', value: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#64748b' });
    color.addEventListener('input', () => { p.color = color.value; touch(); });
    const noBreak = p.lunch === false;
    return h('div', { class: 'pedit' + (p.former ? ' former' : '') },
      h('div', { class: 'fields' },
        field('Name', textInput(p.name, v => { p.name = v; }, { placeholder: 'First name' })),
        field('Role', role), field('Color', color)),
      p.role === 'rep' ? field('Owns these cities', pickList(DRAFT.cities.map(c => [c.id, c.short]), p.home || [], ids => { p.home = ids; })) : null,
      h('div', { class: 'row' },
        h('label', { class: 'row small', style: 'font-weight:600' }, (() => { const b = h('input', { type: 'checkbox', checked: noBreak }); b.addEventListener('change', () => { if (b.checked) { p.lunch = false; p.workMin = p.workMin || 570; } else { delete p.lunch; delete p.workMin; } render(); }); return b; })(), 'Straight day, no lunch break'),
        noBreak ? field('Hours', textInput(String((p.workMin || 570) / 60), v => { const n = parseFloat(v); if (n > 0 && n <= 10) p.workMin = Math.round(n * 60); }, { inputmode: 'decimal', style: 'width:80px' })) : null,
        !isOwnerRow ? h('label', { class: 'row small', style: 'font-weight:600;margin-left:auto' }, (() => { const b = h('input', { type: 'checkbox', checked: !!p.former }); b.addEventListener('change', () => { if (b.checked) p.former = true; else delete p.former; render(); }); return b; })(), 'Left the team') : null,
        p._new ? h('button', { class: 'btn small danger', onclick: () => { DRAFT.people = DRAFT.people.filter(x => x !== p); render(); } }, 'Remove') : null));
  });
}
function cityEditor(c) {
  const color = h('input', { type: 'color', class: 'inp', value: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#64748b' });
  color.addEventListener('input', () => { c.color = color.value; touch(); });
  return h('div', { class: 'card city', style: `--cc:${c.color}` },
    h('div', { class: 'fields' }, field('City', textInput(c.name, v => { c.name = v; c.short = v; })), field('Color', color)),
    h('div', { class: 'field' }, 'Sales lines',
      (c.salesLines || []).map((l, i) => h('div', { class: 'lrow' },
        textInput(l.name, v => { l.name = v; }, { placeholder: 'Line name', 'aria-label': 'Line name' }),
        textInput(l.number, v => { l.number = v.trim(); }, { placeholder: '+1…', inputmode: 'tel', 'aria-label': 'Number' }),
        textInput(l.id, v => { l.id = v.trim(); }, { placeholder: 'PN…', 'aria-label': 'OpenPhone line ID' }),
        h('button', { class: 'xbtn', 'aria-label': 'Remove line', onclick: () => { c.salesLines.splice(i, 1); render(); } }, '×'))),
      h('button', { class: 'btn small ghost', style: 'margin-top:6px;align-self:flex-start', onclick: () => { (c.salesLines = c.salesLines || []).push({ id: '', number: '', name: '' }); render(); } }, '+ Add sales line')));
}
function slug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'person'; }
async function saveDraft() {
  const d = DRAFT;
  const bad = d.people.find(p => !String(p.name || '').trim()) ? 'Every person needs a name.'
    : (d.people.find(p => p.role === 'rep' && !p.former && !(p.home || []).length) ? `${d.people.find(p => p.role === 'rep' && !p.former && !(p.home || []).length).name} owns no cities: pick at least one, or make them “Any city”.`
      : d.cities.find(c => !String(c.name || '').trim()) ? 'Every city needs a name.'
        : d.cities.some(c => (c.salesLines || []).some(l => !String(l.name || '').trim())) ? 'Every sales line needs a name.' : null);
  if (bad) { flash(bad, true); return; }
  d.people.forEach(p => {
    if (!p._new) return;
    const base = slug(p.name); let id = base, n = 2;
    while (d.people.some(x => x !== p && x.id === id)) id = base + n++;
    Object.keys(d.defaultWeek).forEach(k => { d.defaultWeek[k] = d.defaultWeek[k].map(x => (x === p.id ? id : x)); });
    p.id = id; delete p._new;
  });
  d.cities.forEach(c => { c.salesLines = (c.salesLines || []).filter(l => l.name || l.number || l.id); });
  const next = C.normalizeConfig(d);
  const leaving = next.people.filter(p => p.former && !C.isFormer(CFG, p.id));
  if (ONLINE) {
    const { error } = await sb.from('app_config').upsert({ id: 1, data: next, updated_at: new Date().toISOString(), updated_by: (ME && (ME.personId || ME.email)) || 'app' });
    if (error) { flash('Could not save: ' + error.message, true); return; }
  } else ls.set('tcs-config', next);
  CFG = next; DRAFT = null;
  if (leaving.length) await rebuildWithout(leaving);
  refreshPres(); await loadToday(); render(); evaluateGaps();
  flash('Team setup saved ✓' + (leaving.length ? ` ${C.joinList(leaving.map(p => C.firstName(p)))} taken off this and future weeks.` : ''));
}
async function rebuildWithout() {                      // someone left: rebuild current + future weeks
  const weeks = [];
  if (ONLINE) {
    const { data } = await sb.from('schedules').select('week_start, data').gte('week_start', NOW.mondayIso);
    (data || []).forEach(r => weeks.push([r.week_start, r.data]));
  } else {
    try { Object.keys(localStorage).filter(k => k.startsWith('tcs-cov-') && k.slice(8) >= NOW.mondayIso).forEach(k => weeks.push([k.slice(8), ls.get(k)])); } catch (e) { /* no storage */ }
  }
  for (const [iso, W] of weeks) if (C.dropFormers(W, iso, NOW.mondayIso, CFG)) await saveWeek(iso, W);
  if (weekIso >= NOW.mondayIso) await loadWeek();
}
function accessList() {
  if (!PROFILES.length) return h('div', { class: 'empty' }, 'No logins found.');
  return [...PROFILES].sort((a, b) => (a.person_id === 'owner' ? -1 : b.person_id === 'owner' ? 1 : String(a.email).localeCompare(String(b.email)))).map(pr => {
    const locked = pr.person_id === 'owner';
    const who = h('select', { class: 'inp', disabled: locked, 'aria-label': 'Person' },
      h('option', { value: '' }, 'Not linked'),
      CFG.people.map(p => h('option', { value: p.id, selected: p.id === pr.person_id }, C.firstName(p) + (p.former ? ' (left, blocked)' : ''))));
    who.addEventListener('change', () => updateProfile(pr.id, { person_id: who.value || null }));
    return h('div', { class: 'access' },
      h('div', null, h('b', null, pr.person_id ? C.nameOf(CFG, pr.person_id) : 'Unlinked login'), h('div', { class: 'email' }, pr.email || '')),
      who,
      h('div', { class: 'seg' }, [['member', 'Member'], ['manager', 'Manager']].map(([r, l]) => h('button', {
        class: pr.role === r ? 'on' : '', disabled: locked, type: 'button', onclick: () => updateProfile(pr.id, { role: r }),
      }, l))));
  });
}
async function updateProfile(id, patch) {
  const { error } = await sb.from('profiles').update(patch).eq('id', id);
  if (error) { flash('Could not change that login: ' + error.message, true); return; }
  await loadProfiles(); render(); flash('Login updated ✓');
}
async function testText() {
  flash('Sending a test text to the office line…');
  const { data, error } = await sb.functions.invoke('coverage-sms', { body: { test: true } });
  if (error || !data || !data.ok) flash('Test text failed: ' + ((error && error.message) || (data && data.error) || 'unknown'), true);
  else flash('Test text sent ✓ Check the office line.');
}
async function selfTest() {
  const out = h('span', { class: 'sms' }, 'Running…');
  toast([h('b', null, '🧪 Alert self-test'), out], { kind: 'info', sticky: true });
  const lines = [], add = s => { lines.push(s); out.textContent = lines.join('\n'); };
  if ('Notification' in window) {
    if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* old browser */ } }
    add('Pop-up notifications: ' + (Notification.permission === 'granted' ? 'on ✓' : Notification.permission === 'denied' ? 'blocked ✗ (browser site settings)' : 'not turned on'));
  } else add('Pop-up notifications: not supported on this browser');
  osNotify('🧪 Test notification', 'If you see this, system pop-ups work.'); beep(); add('Sound: played a beep');
  if (!ONLINE) { add('Local mode: there is no live connection to test.'); return; }
  add('Live connection: ' + (RT === 'SUBSCRIBED' ? 'connected ✓' : RT + ' ✗'));
  const ok = await new Promise(res => {
    let done = false;
    const ch = sb.channel('selftest-' + Math.random().toString(36).slice(2), { config: { broadcast: { self: true } } });
    const end = v => { if (done) return; done = true; try { sb.removeChannel(ch); } catch (e) { /* closed */ } res(v); };
    ch.on('broadcast', { event: 'ping' }, () => end(true))
      .subscribe(st => { if (st === 'SUBSCRIBED') ch.send({ type: 'broadcast', event: 'ping', payload: {} }); });
    setTimeout(() => end(false), 7000);
  });
  add('Live round trip: ' + (ok ? 'received ✓' : 'nothing in 7 seconds ✗'));
  add(ok ? '✅ This device gets live alerts.' : '❌ Live alerts are not reaching this device. Refresh; if it keeps failing, tell your manager.');
}

/* =============================== REPORTS =================================== */
function liveReport() {
  const events = LOG.map(r => ({ person_id: r.person_id, state: r.state, covering: r.covering, min: C.minuteOf(r.at, NOW.startMs) }));
  const logged = new Set(events.map(e => e.person_id));
  Object.values(RAW).forEach(r => {
    if (!logged.has(r.person_id) && isToday(r.updated_at)) events.push({ person_id: r.person_id, state: r.state, covering: r.covering, min: C.minuteOf(r.updated_at, NOW.startMs) });
  });
  return C.buildReport({ cfg: CFG, dateLabel: tzDate(nowMs(), { weekday: 'short', month: 'short', day: 'numeric' }), day: TODAY, events,
    calls: CALLS.map(k => ({ city: k.city, min: k.minute, missed: k.missed })), nowMin: NOW.mins });
}
function reportTable(data) {
  return h('table', { class: 'rtable' },
    h('thead', null, h('tr', null, h('th', null, 'City'), h('th', { class: 'num' }, 'Covered'), h('th', null, 'Gaps'), h('th', { class: 'num' }, 'Calls'), h('th', null, 'Missed (who was on)'))),
    h('tbody', null, data.cities.map(cd => h('tr', null,
      h('td', null, h('b', null, cd.name)),
      h('td', { class: 'num' }, cd.pct === null ? '—' : cd.pct + '%'),
      h('td', null, cd.gaps.length ? cd.gaps.map(([a, b]) => `${C.fmtClock(a)}–${C.fmtClock(b)}`).join(', ') : '—'),
      h('td', { class: 'num' }, cd.calls),
      h('td', null, cd.missed.length ? cd.missed.map(k => `${C.fmtClock(k.min)} ${k.who.length ? C.joinList(k.who) : 'no one'}`).join(' · ') : '—')))));
}
function viewReports() {
  if (!isManager()) return h('div', { class: 'empty' }, 'Managers only.');
  const rep = liveReport();
  const s = CFG.settings;
  const wrap = h('div', { class: 'sec', style: 'gap:20px' },
    section('Today so far', ONLINE ? `Coverage from everyone’s status buttons, calls from the sales lines${SYNC ? ` (updated ${ago(SYNC.at)})` : ''}.` : 'Local mode: coverage only.',
      h('div', { class: 'card' }, reportTable(rep.data),
        rep.data.breaks.length ? h('p', { class: 'small', style: 'margin-top:10px' }, h('b', null, 'Breaks: '), rep.data.breaks.map(b => `${C.nameOf(CFG, b.pid)} ${C.fmtClock(b.from)}–${b.to === null ? 'now' : C.fmtClock(b.to)}`).join(', ')) : null,
        rep.data.afterHours.calls ? h('p', { class: 'small muted', style: 'margin-top:6px' }, `After hours: ${rep.data.afterHours.calls} calls, ${rep.data.afterHours.missed} missed.`) : null,
        h('details', { style: 'margin-top:10px' }, h('summary', { class: 'small', style: 'cursor:pointer;font-weight:700' }, 'The text it will send'), h('pre', { class: 'pre' }, rep.text)),
        ONLINE ? h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn small', onclick: syncNow }, 'Refresh calls'),
          h('button', { class: 'btn small', onclick: sendReportNow }, 'Send today’s report now')) : null),
      h('p', { class: 'small muted' }, s.reportEnabled ? `Sent automatically at ${C.fmtTime(hhmm(s.reportAt))} to the office line.` : 'The automatic evening report is off (Team tab).')),
    section('Past reports', null, h('div', { class: 'card' }, REPORTS.length ? REPORTS.map(r => h('details', { class: 'rep' },
      h('summary', null, `${tzDate(r.day + 'T18:00:00Z', { weekday: 'short', month: 'short', day: 'numeric' })}`, h('span', { class: 'muted small' }, r.sent_at ? ` · texted ${new Date(r.sent_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}` : ' · not sent')),
      r.data && r.data.cities ? reportTable(r.data) : null, h('pre', { class: 'pre' }, r.text || '(empty)')))
      : h('div', { class: 'empty' }, ONLINE ? 'The first report arrives this evening.' : 'Reports are saved once the app is online.'))));
  return wrap;
}
async function sendReportNow() {
  if (!confirm('Text today’s report to the office line now?')) return;
  flash('Sending the report…');
  const { data, error } = await sb.functions.invoke('coverage-tick', { body: { action: 'report', send: true } });
  if (error || !data || !data.ok || !data.sent) flash('Report not sent: ' + ((error && error.message) || (data && (data.error || data.skip)) || 'unknown'), true);
  else { flash('Report sent ✓'); await loadReports(); render(); }
}

/* ============================== SIGN-IN / BOOT ============================= */
function showLogin(msg) {
  $('#app').hidden = true; $('#login').hidden = false;
  const err = $('#loginErr'); err.hidden = !msg; err.textContent = msg || '';
}
function showApp() { $('#login').hidden = true; $('#app').hidden = false; }
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!sb) return;
  const btn = $('#loginBtn'), err = $('#loginErr');
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPass').value });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { err.hidden = false; err.textContent = error.message; }
});
$('#signOut').addEventListener('click', async () => { if (sb) await sb.auth.signOut(); ME = null; showLogin(); });

async function resolveProfile(user) {
  const { data } = await sb.from('profiles').select('person_id, role').eq('id', user.id).maybeSingle();
  return { personId: data ? data.person_id : null, role: (data && data.role) || 'member', email: user.email, uid: user.id };
}
let _entering = false;
async function enter(session) {
  if (_entering) return; _entering = true;
  try {
    try { sb.realtime.setAuth(session.access_token); } catch (e) { /* older client */ }  // BEFORE subscribing, or live events are filtered to nothing
    ME = await resolveProfile(session.user);
    await loadConfig();
    if (ME.personId && C.isFormer(CFG, ME.personId)) { try { await sb.auth.signOut(); } catch (e) { /* already out */ } ME = null; showLogin('This login is no longer active. Ask your manager if this is a mistake.'); return; }
    showApp(); renderHeader();
    $('#view').replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    subscribe();
    await loadAll();
    render(); evaluateGaps();
  } finally { _entering = false; }
}
async function boot() {
  if (!ONLINE) {
    const pv = Q.get('preview');
    if (pv === 'member') ME = { personId: Q.get('as') || 'barbara', role: 'member', email: 'preview', uid: 'local' };
    else if (pv === 'manager' || pv === 'owner') ME = { personId: Q.get('as') || 'owner', role: 'manager', email: 'preview', uid: 'local' };
    showApp();
    await loadConfig(); await loadAll(); render(); evaluateGaps();
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(session); else showLogin();
  sb.auth.onAuthStateChange((_e, sess) => {
    if (sess) { try { sb.realtime.setAuth(sess.access_token); } catch (e) { /* older client */ } if (!ME) enter(sess); }
    else { ME = null; showLogin(); }
  });
}
boot();
