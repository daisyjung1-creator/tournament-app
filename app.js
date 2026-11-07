import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Publishable (public) key — safe in the browser; data is protected by row-level security.
const SUPABASE_URL = 'https://eihgzlbuldejcmqcomub.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fu5Rn91Mc4dYdvHSgo-QqQ_m2VTTjhD';
const COACH_EMAIL = 'coach@teamhankook.app';
const POLL_MS = 4000;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tourney-auth' },
});

const app = document.getElementById('app');
let session = null;
let pollTimer = null;
let routeId = 0;
let ui = { filter: 'All', adminLogin: false };
let roster = null; // cached dojang roster
let cache = {};    // tournament data cache for the current tournament

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const shortName = (name) => {
  const p = String(name || '').trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || '');
};
const digits = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d; // North American number
  return d;
};
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
};
const parentLink = (token) => `${location.origin}${location.pathname}#/p/${token}`;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function must(promise) {
  const { data, error } = await promise;
  if (error) { toast(error.message); throw error; }
  return data;
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
// start polling only if the user is still on the page that asked for it
function startPoll(rid, fn, ms) {
  if (rid !== routeId) return;
  stopPoll();
  pollTimer = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
}

const ICON = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
};

// ---------- match status ----------
function statusOf(m, courts) {
  if (m.result) return { key: 'done', label: m.result === 'Done' ? 'DONE' : m.result.toUpperCase(), away: Infinity };
  const cur = courts[m.court];
  if (cur == null) return { key: 'wait', label: 'NOT STARTED', away: null };
  const away = m.match_no - cur;
  if (away < 0) return { key: 'past', label: 'CHECK RESULT', away };
  if (away === 0) return { key: 'now', label: 'ON THE MAT', away };
  if (away === 1) return { key: 'deck', label: 'ON DECK', away };
  return { key: away <= 3 ? 'soon1' : 'soon', label: `${away} AWAY`, away };
}

// ---------- rounds & corners ----------
const ROUNDS = ['Round of 64', 'Round of 32', 'Round of 16', 'Quarterfinal', 'Semifinal', 'Final'];
const nextRound = (r) => { const i = ROUNDS.indexOf(r); return i >= 0 && i < ROUNDS.length - 1 ? ROUNDS[i + 1] : ''; };
const evLabel = (m) => `${m.event}${m.round ? ' · ' + m.round : ''}`;
const cornerMsg = (c) => (c === 'Blue' ? '🟦 BLUE corner (Chung)' : c === 'Red' ? '🟥 RED corner (Hong)' : '');
const cornerChip = (c) => (c ? `<span class="corner ${c.toLowerCase()}">${c === 'Blue' ? 'Chung · Blue' : 'Hong · Red'}</span>` : '');

// ---------- messages ----------
const CHECKIN_AT = 3; // 2–3 matches away: check in at the ring; more than that: warm up
const GEAR = '✅ Protective gear on under the uniform\n✅ Mouthguard\n✅ Water bottle';

function groupMessage(m, a, t, s) {
  const who = shortName(a.name).toUpperCase();
  const where = `Court ${m.court}, Match #${m.match_no} (${evLabel(m)})${m.corner ? ' · ' + cornerMsg(m.corner) : ''}`;
  let line;
  if (s.away === 1) line = `🔴 ${who} is UP NEXT — ${where}. Please come to Court ${m.court} now and hand over to the coach.`;
  else if (s.away >= 2 && s.away <= CHECKIN_AT) line = `🟠 ${who} — ${s.away} matches away! ${where}. Please check in at Court ${m.court} and hand over to the coach.\n\n${GEAR}\n`;
  else if (s.away > CHECKIN_AT) line = `🟡 ${who} — coming up soon! ${where}, about ${s.away} matches away. Please start warming up.\n\n${GEAR}\n`;
  else line = `🟡 ${who} — ${where}. We'll post again as the court moves.\n\n${GEAR}\n`;
  return `${line}\nLive status: ${parentLink(a.token)}`;
}

function parentMessage(m, a, t, s) {
  const child = first(a.name);
  const hi = first(a.guardian_name) ? `Hi ${first(a.guardian_name)}!` : 'Hi!';
  let body;
  if (s.away === 1) body = `${child} is UP NEXT on Court ${m.court} (Match #${m.match_no}, ${evLabel(m)}). Please bring ${child} to Court ${m.court} right away and hand ${child} over to the coach.`;
  else if (s.away >= 2 && s.away <= CHECKIN_AT) body = `${child} is ${s.away} matches away on Court ${m.court} (Match #${m.match_no}, ${evLabel(m)}). Please bring ${child} to Court ${m.court} now to check in and hand ${child} over to the coach.`;
  else if (s.away > CHECKIN_AT) body = `${child}'s match is coming up soon: about ${s.away} matches away on Court ${m.court} (Match #${m.match_no}, ${evLabel(m)}). Please start warming up now.`;
  else body = `${child} is scheduled on Court ${m.court} (Match #${m.match_no}, ${evLabel(m)}). Please stay close to the waiting area.`;
  const corner = m.corner ? `\n${child} is in the ${cornerMsg(m.corner)}.` : '';
  const gear = `${corner}\n\nPlease make sure ${child} has:\n${GEAR}`;
  return `${hi} ${body}${gear}\n\nLive status: ${parentLink(a.token)}\n– ${t.signoff}`;
}

function openMessage(channel, phone, text) {
  const enc = encodeURIComponent(text);
  const d = digits(phone);
  let url;
  // wa.me opens the WhatsApp app when it's installed, and a WhatsApp web page (not an error) when it isn't
  if (channel === 'group') url = `https://wa.me/?text=${enc}`;
  else if (channel === 'sms') url = `sms:${d ? '+' + d : ''}?&body=${enc}`;
  else url = `https://wa.me/${d}?text=${enc}`;
  if (typeof window.__onOpenMessage === 'function') return window.__onOpenMessage(url); // test hook
  if (url.startsWith('https:')) {
    // open in a new tab so the coach app stays open behind it
    const w = window.open(url, '_blank');
    if (w) w.opener = null;
    else window.location.href = url;
    return;
  }
  window.location.href = url;
}

// ---------- routing ----------
async function route() {
  stopPoll();
  routeId++;
  const h = location.hash || '#/';
  const pm = h.match(/^#\/p\/([0-9a-f-]{36})$/i);
  if (pm) return parentPage(pm[1]);

  if (!session) return loginPage();
  const tm = h.match(/^#\/t\/([0-9a-f-]{36})\/(next|courts|setup)$/i);
  if (tm) {
    const [, id, tab] = tm;
    if (tab === 'next') return nextPage(id);
    if (tab === 'courts') return courtsPage(id);
    return setupPage(id);
  }
  return homePage();
}

// ---------- login ----------
function loginPage() {
  app.onclick = null; app.onchange = null; app.onsubmit = null;
  app.innerHTML = `
    <header class="top" style="padding-top:calc(28px + env(safe-area-inset-top));padding-bottom:24px;gap:14px"><img class="logo big" src="logo.png" alt="High Performance Hankook"><div><span class="eyebrow">Tournament Day</span><h1>Coach sign in</h1></div></header>
    <form class="pad stack" id="login">
      ${ui.adminLogin ? `
      <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required></div>` : ''}
      <div class="field"><label for="pw">${ui.adminLogin ? 'Password' : 'Coach password'}</label>
        <input id="pw" type="password" autocomplete="current-password" required></div>
      <button class="btn dark block" type="submit">Sign in</button>
      <button class="linkbtn" type="button" data-act="toggle-admin">${ui.adminLogin ? 'Use coach password' : 'Sign in with admin email'}</button>
    </form>`;
  app.querySelector('[data-act=toggle-admin]').onclick = () => { ui.adminLogin = !ui.adminLogin; loginPage(); };
  app.querySelector('#login').onsubmit = async (e) => {
    e.preventDefault();
    const email = ui.adminLogin ? app.querySelector('#em').value.trim() : COACH_EMAIL;
    const password = app.querySelector('#pw').value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return toast('Wrong password');
    const ok = await sb.rpc('is_tourney_staff');
    if (!ok.data) { await sb.auth.signOut(); return toast('This account has no tournament access'); }
  };
}

// ---------- home ----------
async function homePage() {
  app.innerHTML = `<header class="top"><img class="logo" src="logo.png" alt="High Performance Hankook"><h1>Tournaments</h1></header><p class="pad muted">Loading…</p>`;
  const list = await must(sb.from('t_tournaments').select('*').eq('archived', false).order('event_date', { ascending: false, nullsFirst: true }));
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <header class="top">
      <div class="row"><img class="logo" src="logo.png" alt="High Performance Hankook"><button class="linkbtn" data-act="logout">Sign out</button></div>
      <h1>Tournaments</h1>
    </header>
    <div class="list">
      ${list.length ? list.map((t) => `
        <div class="card" style="gap:4px">
          <a style="text-decoration:none;color:inherit" href="#/t/${t.id}/next">
            <div class="head"><div><div class="name">${esc(t.name)}</div>
            <div class="meta">${esc(t.event_date || 'No date')} · ${t.courts} courts</div></div>
            <span class="where">Open ›</span></div>
          </a>
          <div><button class="linkbtn red" data-act="delt" data-t="${t.id}" data-name="${esc(t.name)}">Delete</button></div>
        </div>`).join('') : '<div class="empty">No tournaments yet. Create one below.</div>'}
    </div>
    <form class="section stack" id="newt" style="border-top:1px solid var(--line)">
      <h2>New tournament</h2>
      <div class="field"><label for="tn">Name</label><input id="tn" required placeholder="e.g. Alberta Open"></div>
      <div class="grid2">
        <div class="field"><label for="td">Date</label><input id="td" type="date" value="${today}"></div>
        <div class="field"><label for="tc">Courts</label><input id="tc" type="number" min="1" max="12" value="4" inputmode="numeric"></div>
      </div>
      <button class="btn dark block" type="submit">Create</button>
    </form>`;
  app.querySelector('[data-act=logout]').onclick = () => sb.auth.signOut();
  app.onchange = null; app.onsubmit = null;
  app.onclick = async (e) => {
    const el = e.target.closest('[data-act=delt]');
    if (!el) return;
    if (!confirm(`Delete "${el.dataset.name}" and all its athletes and matches? This can't be undone.`)) return;
    await must(sb.from('t_tournaments').delete().eq('id', el.dataset.t));
    toast('Tournament deleted');
    homePage();
  };
  app.querySelector('#newt').onsubmit = async (e) => {
    e.preventDefault();
    const row = await must(sb.from('t_tournaments').insert({
      name: app.querySelector('#tn').value.trim(),
      event_date: app.querySelector('#td').value || null,
      courts: Math.min(12, Math.max(1, parseInt(app.querySelector('#tc').value, 10) || 4)),
    }).select().single());
    location.hash = `#/t/${row.id}/setup`;
  };
}

// ---------- tournament data ----------
async function loadT(id) {
  const [t, athletes, matches, courtRows] = await Promise.all([
    must(sb.from('t_tournaments').select('*').eq('id', id).single()),
    must(sb.from('t_athletes').select('*').eq('tournament_id', id).order('name')),
    must(sb.from('t_matches').select('*').eq('tournament_id', id).order('match_no')),
    must(sb.from('t_courts').select('*').eq('tournament_id', id)),
  ]);
  const courts = {};
  courtRows.forEach((c) => { courts[c.court] = c.current_match; });
  const byId = Object.fromEntries(athletes.map((a) => [a.id, a]));
  cache = { id, t, athletes, matches, courts, byId };
  return cache;
}

function shell(t, tab, body) {
  const tabs = [['next', 'Up Next', ICON.list], ['courts', 'Courts', ICON.grid], ['setup', 'Setup', ICON.edit]];
  return `
    <header class="top">
      <div class="row"><img class="logo" src="logo.png" alt="High Performance Hankook"><span class="eyebrow">${esc(t.event_date || '')}</span></div>
      <a class="back" href="#/">‹ All tournaments</a>
      <h1>${esc(t.name)}</h1>
    </header>
    ${body}
    <nav class="bottom"><div class="in">
      ${tabs.map(([k, label, icon]) => `<a href="#/t/${t.id}/${k}" class="${k === tab ? 'on' : ''}">${icon}${label}</a>`).join('')}
    </div></nav>`;
}

// ---------- Up Next (waiting-area coach) ----------
async function nextPage(id) {
  app.onsubmit = null;
  const render = async () => {
    const { t, matches, courts, byId } = await loadT(id);
    const rows = matches
      .filter((m) => ui.filter === 'All' || m.event === ui.filter)
      .map((m) => ({ m, a: byId[m.athlete_id], s: statusOf(m, courts) }))
      .filter((r) => r.a);
    const active = rows.filter((r) => r.s.key !== 'done');
    const rank = (r) => (r.s.away == null ? 1000 + r.m.match_no : r.s.away < 0 ? -1 : r.s.away);
    active.sort((x, y) => rank(x) - rank(y) || x.m.court - y.m.court);
    const soon = active.filter((r) => r.s.away != null && r.s.away <= t.group_alert_at);
    const later = active.filter((r) => !soon.includes(r));
    const done = rows.filter((r) => r.s.key === 'done');

    // same athlete needed on another court soon (e.g. sparring and poomsae overlapping)
    const clashes = (m) => matches
      .filter((o) => o.athlete_id === m.athlete_id && o.id !== m.id && o.court !== m.court && !o.result)
      .map((o) => ({ o, s: statusOf(o, courts) }))
      .filter(({ s }) => s.away != null && s.away <= t.group_alert_at);

    const card = ({ m, a, s }) => {
      const clash = s.key === 'done' ? [] : clashes(m);
      const log = [
        a.checked_in_at ? `Checked in ${ago(a.checked_in_at)}` : '',
        m.group_notified_at ? `Group posted ${ago(m.group_notified_at)}` : '',
        m.parent_notified_at ? `Parent messaged ${ago(m.parent_notified_at)}` : '',
      ].filter(Boolean).join(' · ');
      return `
      <article class="card ${s.key === 'now' || s.key === 'deck' ? 'hot' : ''}">
        <div class="head">
          <div><div class="name">${esc(a.name)}</div><div class="meta">${esc(evLabel(m))}${m.division ? ' · ' + esc(m.division) : ''}</div></div>
          <div class="where">Court ${m.court} · #${m.match_no}<br><span class="status ${s.key}">${s.label}</span>
            ${s.key === 'done' ? cornerChip(m.corner) : `<br><button class="corner-btn ${m.corner ? m.corner.toLowerCase() : ''}" data-act="corner" data-m="${m.id}" aria-label="Corner: ${m.corner || 'not set'}. Tap to change">${m.corner ? (m.corner === 'Blue' ? 'Chung · Blue' : 'Hong · Red') : 'Set corner'}</button>`}</div>
        </div>
        ${clash.map(({ o, s: os }) => `<div class="clash" role="note"><strong>⚠ Also needed on Court ${o.court}</strong> — ${esc(evLabel(o))} #${o.match_no}, ${os.away <= 0 ? 'on the mat now' : os.away === 1 ? 'on deck' : os.away + ' away'}. Tell the court table if needed.</div>`).join('')}
        ${['done', 'now', 'past'].includes(s.key) ? '' : `
        <div class="tools">
          <button class="btn" style="flex:1" data-act="group" data-m="${m.id}">Post to group</button>
          <button class="btn dark" style="flex:1" data-act="parent" data-m="${m.id}">Message parent</button>
        </div>`}
        <div class="tools">
          <button class="btn icon ${a.checked_in_at ? 'on' : 'ghost'}" aria-label="${a.checked_in_at ? 'Checked in — tap to undo' : 'Mark checked in'}" aria-pressed="${!!a.checked_in_at}" data-act="checkin" data-a="${a.id}">${ICON.check}</button>
          ${a.phone ? `<a class="btn icon ghost" aria-label="Call ${esc(a.guardian_name || 'parent')}" href="tel:+${digits(a.phone)}">${ICON.phone}</a>` : ''}
          <select aria-label="Result for ${esc(a.name)} match ${m.match_no}" data-act="result" data-m="${m.id}">
            ${['', 'Win', 'Loss', 'Gold', 'Silver', 'Bronze', 'Done'].map((r) => `<option value="${r}" ${(m.result || '') === r ? 'selected' : ''}>${r || 'Result…'}</option>`).join('')}
          </select>
        </div>
        ${log ? `<div class="log">${esc(log)}</div>` : ''}
      </article>`;
    };

    const needNext = matches.filter((m) => m.result === 'Win' && m.round !== 'Final' && !(ui.skipNext || []).includes(m.id)
      && !matches.some((o) => o.athlete_id === m.athlete_id && o.event === m.event && o.match_no > m.match_no && o.id !== m.id));
    const nextForm = (m) => {
      const a = byId[m.athlete_id]; if (!a) return '';
      const nr = nextRound(m.round);
      return `
      <form class="card hot" data-next="${m.id}">
        <div><div class="name">🏆 ${esc(a.name)} won${m.round ? ' the ' + esc(m.round) : ''} (#${m.match_no})</div>
          <div class="meta">Add ${first(a.name)}'s next ${esc(m.event.toLowerCase())} match from the bracket</div></div>
        <div class="grid2">
          <div class="field"><label for="nr${m.id}">Round</label><select id="nr${m.id}" name="round">
            <option value="">—</option>${ROUNDS.map((r) => `<option ${r === nr ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
          <div class="field"><label for="nc${m.id}">Corner</label><select id="nc${m.id}" name="corner">
            <option value="">—</option><option value="Blue">Chung · Blue</option><option value="Red">Hong · Red</option></select></div>
          <div class="field"><label for="nk${m.id}">Court</label><select id="nk${m.id}" name="court">
            ${Array.from({ length: t.courts }, (_, i) => i + 1).map((c) => `<option ${c === m.court ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="nn${m.id}">Match #</label><input id="nn${m.id}" name="match_no" type="number" min="1" inputmode="numeric" required></div>
        </div>
        <div class="tools"><button class="btn dark" style="flex:1" type="submit">Add next match</button>
          <button class="btn ghost" type="button" data-act="skipnext" data-m="${m.id}">Skip</button></div>
      </form>`;
    };

    const filters = ['All', 'Sparring', 'Poomsae'];
    const body = `
      ${needNext.length ? `<div class="sub-h">Next round needed</div><div class="list">${needNext.map(nextForm).join('')}</div>` : ''}
      <div class="chips">${filters.map((f) => `<button class="chip-btn ${ui.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}">${f}</button>`).join('')}</div>
      ${!matches.length ? `<div class="empty">No matches yet. Add athletes and match numbers in <a href="#/t/${id}/setup">Setup</a>.</div>` : ''}
      ${soon.length ? `<div class="sub-h">Up next (within ${t.group_alert_at})</div><div class="list">${soon.map(card).join('')}</div>` : ''}
      ${later.length ? `<div class="sub-h">Later</div><div class="list">${later.map(card).join('')}</div>` : ''}
      ${done.length ? `<details class="pad"><summary>Finished (${done.length})</summary><div class="list" style="padding:8px 0">${done.map(card).join('')}</div></details>` : ''}`;
    // keep the "Finished" panel open across refreshes
    const wasOpen = app.querySelector('details')?.open;
    const y = window.scrollY;
    app.innerHTML = shell(t, 'next', body);
    if (wasOpen && app.querySelector('details')) app.querySelector('details').open = true;
    window.scrollTo(0, y);
  };

  app.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !cache.t) return;
    const act = el.dataset.act;
    if (act === 'filter') { ui.filter = el.dataset.f; return render(); }
    if (act === 'group' || act === 'parent') {
      const m = cache.matches.find((x) => x.id === el.dataset.m);
      const a = cache.byId[m.athlete_id];
      const s = statusOf(m, cache.courts);
      if (act === 'parent' && !a.phone) return toast(`No phone number for ${first(a.name)} — add it in Setup`);
      const text = act === 'group' ? groupMessage(m, a, cache.t, s) : parentMessage(m, a, cache.t, s);
      const col = act === 'group' ? 'group_notified_at' : 'parent_notified_at';
      sb.from('t_matches').update({ [col]: new Date().toISOString() }).eq('id', m.id).then(() => render());
      openMessage(act === 'group' ? 'group' : a.channel, a.phone, text);
      return;
    }
    if (act === 'corner') {
      const m = cache.matches.find((x) => x.id === el.dataset.m);
      const nextC = m.corner === 'Blue' ? 'Red' : m.corner === 'Red' ? null : 'Blue';
      m.corner = nextC;
      await must(sb.from('t_matches').update({ corner: nextC }).eq('id', m.id));
      return render();
    }
    if (act === 'skipnext') { ui.skipNext = [...(ui.skipNext || []), el.dataset.m]; return render(); }
    if (act === 'checkin') {
      const a = cache.byId[el.dataset.a];
      await must(sb.from('t_athletes').update({ checked_in_at: a.checked_in_at ? null : new Date().toISOString() }).eq('id', a.id));
      return render();
    }
  };
  app.onchange = async (e) => {
    const el = e.target.closest('[data-act=result]');
    if (!el) return;
    const m = cache.matches.find((x) => x.id === el.dataset.m);
    let dropLater = [];
    if (el.value === 'Loss' && m) {
      const later = cache.matches.filter((o) => o.athlete_id === m.athlete_id && o.event === m.event && o.match_no > m.match_no && !o.result);
      if (later.length && confirm(`${first(cache.byId[m.athlete_id]?.name)} is out of ${m.event}. Remove the ${later.length} later ${m.event.toLowerCase()} match${later.length > 1 ? 'es' : ''} (${later.map((o) => '#' + o.match_no).join(', ')})?`)) dropLater = later.map((o) => o.id);
    }
    await must(sb.from('t_matches').update({ result: el.value || null }).eq('id', el.dataset.m));
    if (dropLater.length) await must(sb.from('t_matches').delete().in('id', dropLater));
    toast(el.value ? `Saved: ${el.value}` : 'Result cleared');
    render();
  };
  app.onsubmit = async (e) => {
    const f = e.target.closest('form[data-next]');
    if (!f) return;
    e.preventDefault();
    const prev = cache.matches.find((x) => x.id === f.dataset.next);
    const fd = new FormData(f);
    await must(sb.from('t_matches').insert({
      tournament_id: id, athlete_id: prev.athlete_id, event: prev.event, division: prev.division,
      round: fd.get('round') || null, corner: fd.get('corner') || null,
      court: parseInt(fd.get('court'), 10), match_no: parseInt(fd.get('match_no'), 10),
    }));
    toast(`Added ${fd.get('round') || 'next match'} · #${fd.get('match_no')}`);
    render();
  };

  const rid = routeId;
  await render();
  startPoll(rid, () => (document.activeElement?.matches('select, input') ? Promise.resolve() : render()), POLL_MS);
}

// ---------- Courts (floor coaches) ----------
async function courtsPage(id) {
  const render = async () => {
    const { t, matches, courts, byId } = await loadT(id);
    const cells = [];
    for (let c = 1; c <= t.courts; c++) {
      const cur = courts[c];
      const upcoming = matches
        .filter((m) => m.court === c && !m.result)
        .sort((x, y) => x.match_no - y.match_no);
      const nxt = upcoming[0];
      const near = nxt && cur != null && nxt.match_no - cur <= t.group_alert_at;
      const nextTxt = nxt
        ? `${esc(shortName(byId[nxt.athlete_id]?.name))} at #${nxt.match_no}${cur != null ? ` (${nxt.match_no < cur ? 'add result' : nxt.match_no - cur === 0 ? 'on the mat' : nxt.match_no - cur === 1 ? 'on deck' : (nxt.match_no - cur) + ' away'})` : ''}`
        : 'No athletes queued';
      cells.push(`
        <section class="court ${near ? 'ours' : ''}">
          <div class="rowx" style="justify-content:space-between"><strong>Court ${c}</strong>${near ? '<span class="dot" role="img" aria-label="Our athlete is close"></span>' : ''}</div>
          <form data-court="${c}" style="display:flex;flex-direction:column;gap:4px">
            <label for="cn${c}" class="eyebrow" style="font-size:11px">Now on mat</label>
            <div class="rowx" style="gap:6px">
              <input id="cn${c}" class="numin" type="number" min="1" inputmode="numeric" value="${cur ?? ''}" placeholder="#">
              <button class="btn ghost" type="submit" style="height:44px;padding:0 10px;font-size:13px;flex:none">Set</button>
            </div>
          </form>
          <div class="next">${nextTxt}</div>
          <div class="rowx">
            <button class="btn ghost icon" type="button" data-act="dec" data-c="${c}" aria-label="Previous match on court ${c}" ${cur == null ? 'disabled' : ''}>−</button>
            <button class="btn dark" type="button" style="flex:1" data-act="inc" data-c="${c}" aria-label="Next match on court ${c}">+</button>
          </div>
        </section>`);
    }
    const y = window.scrollY;
    app.innerHTML = shell(t, 'courts', `
      <p class="pad small muted" style="margin:0;padding-bottom:0">Type the match number on the mat and tap <strong>Set</strong> once. After that, tap <strong>+</strong> each time a match finishes.</p>
      <div class="courts">${cells.join('')}</div>`);
    window.scrollTo(0, y);
  };

  const save = async (c, val) => {
    cache.courts[c] = val; // show the change right away
    await must(sb.from('t_courts').upsert({ tournament_id: id, court: c, current_match: val, updated_at: new Date().toISOString() }, { onConflict: 'tournament_id,court' }));
    await render();
  };
  app.onchange = null;
  app.onsubmit = async (e) => {
    const f = e.target.closest('form[data-court]');
    if (!f) return;
    e.preventDefault();
    const c = parseInt(f.dataset.court, 10);
    const v = f.querySelector('input').value.trim();
    document.activeElement?.blur();
    if (v === '') return save(c, null);
    if (+v > 0) { await save(c, parseInt(v, 10)); toast(`Court ${c} set to #${parseInt(v, 10)}`); }
  };
  app.onclick = async (e) => {
    const el = e.target.closest('[data-act=inc],[data-act=dec]');
    if (!el || !cache.t) return;
    const c = parseInt(el.dataset.c, 10);
    // read the latest value so two coaches tapping the same court don't overwrite each other
    const { data } = await sb.from('t_courts').select('current_match').eq('tournament_id', id).eq('court', c).maybeSingle();
    const cur = data?.current_match ?? null;
    if (cur == null) {
      toast(`Type the match number on Court ${c} first, then tap Set`);
      app.querySelector(`#cn${c}`)?.focus();
      return;
    }
    if (el.dataset.act === 'inc') return save(c, cur + 1);
    return save(c, Math.max(1, cur - 1));
  };
  const rid = routeId;
  await render();
  // don't redraw while a coach is typing a number
  startPoll(rid, () => (document.activeElement?.matches('input') ? Promise.resolve() : render()), POLL_MS);
}

// ---------- Setup ----------
async function setupPage(id) {
  app.onsubmit = null;
  if (!roster) roster = await must(sb.rpc('t_roster'));
  const render = async () => {
    const { t, athletes, matches } = await loadT(id);
    const used = new Set(athletes.map((a) => a.student_id).filter(Boolean));
    const keep = ui.matchForm || {};
    const body = `
      <details class="section" ${athletes.length ? '' : 'open'}>
        <summary>Tournament settings</summary>
        <form class="stack" id="tset" style="padding-top:10px">
          <div class="field"><label for="sn">Name</label><input id="sn" value="${esc(t.name)}" required></div>
          <div class="field"><label for="sd">Date</label><input id="sd" type="date" value="${esc(t.event_date || '')}"></div>
          <div class="grid2">
            <div class="field"><label for="sc">Courts</label><input id="sc" type="number" min="1" max="12" value="${t.courts}" inputmode="numeric"></div>
            <div class="field"><label for="sg">Alert at</label><input id="sg" type="number" min="1" max="20" value="${t.group_alert_at}" inputmode="numeric" aria-describedby="sgh"></div>
          </div>
          <span id="sgh" class="small muted">"Alert at" = how many matches away an athlete moves into the Up Next section (7 = warm-up time).</span>
          <div class="field"><label for="so">Message sign-off</label><input id="so" value="${esc(t.signoff)}"></div>
          <div class="rowx"><button class="btn dark" style="flex:1" type="submit">Save settings</button>
          <button class="btn danger" type="button" data-act="deltour">Delete tournament</button></div>
        </form>
      </details>

      <form class="section stack" id="addath">
        <h2>Add athlete (${athletes.length})</h2>
        <div class="field"><label for="an">Student</label>
          <input id="an" list="roster" autocomplete="off" placeholder="Start typing a name" required>
          <datalist id="roster">${roster.filter((s) => !used.has(s.id)).map((s) => `<option value="${esc(s.name)}"></option>`).join('')}</datalist>
        </div>
        <div class="grid2">
          <div class="field"><label for="ag">Parent name</label><input id="ag"></div>
          <div class="field"><label for="ap">Parent phone</label><input id="ap" type="tel" inputmode="tel"></div>
        </div>
        <div class="field"><label for="ac">Send messages by</label>
          <select id="ac"><option value="whatsapp">WhatsApp</option><option value="sms">Text (SMS)</option></select></div>
        <button class="btn dark block" type="submit">Add athlete</button>
      </form>

      ${athletes.length ? `
      <form class="section stack" id="addm">
        <h2>Add a match</h2>
        <div class="field"><label for="ma">Athlete</label>
          <select id="ma" required>${athletes.map((a) => `<option value="${a.id}" ${keep.athlete === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="grid3">
          <div class="field"><label for="me">Event</label><select id="me">
            ${['Sparring', 'Poomsae'].map((ev) => `<option ${keep.event === ev ? 'selected' : ''}>${ev}</option>`).join('')}</select></div>
          <div class="field"><label for="mc">Court</label><select id="mc">
            ${Array.from({ length: t.courts }, (_, i) => i + 1).map((c) => `<option ${+keep.court === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="mn">Match #</label><input id="mn" type="number" min="1" inputmode="numeric" required></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="mr">Round (sparring)</label><select id="mr">
            <option value="">—</option>${ROUNDS.map((r) => `<option ${keep.round === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
          <div class="field"><label for="mk">Corner</label><select id="mk">
            <option value="">—</option><option value="Blue">Chung · Blue</option><option value="Red">Hong · Red</option></select></div>
        </div>
        <div class="field"><label for="md">Division (optional)</label><input id="md" placeholder="e.g. Cadet F -47kg" value="${esc(keep.division || '')}"></div>
        <button class="btn dark block" type="submit">Save &amp; add next</button>
      </form>` : ''}

      <div class="section stack">
        <h2>Athletes &amp; matches</h2>
        ${athletes.length ? athletes.map((a) => {
          const ms = matches.filter((m) => m.athlete_id === a.id);
          return `
          <div class="ath">
            <div class="rowx" style="justify-content:space-between;align-items:flex-start">
              <div><div class="t" style="font-weight:700">${esc(a.name)}</div>
                <div class="small muted">${esc(a.guardian_name || 'No parent name')} · ${a.phone ? esc(a.phone) : '<span style="color:var(--red-ink)">No phone</span>'} · ${a.channel === 'sms' ? 'Text' : 'WhatsApp'}</div></div>
              <button class="linkbtn" data-act="channel" data-a="${a.id}">Use ${a.channel === 'sms' ? 'WhatsApp' : 'Text'}</button>
            </div>
            ${ms.map((m) => `<div class="mrow"><span>${esc(evLabel(m))}${m.division ? ' · ' + esc(m.division) : ''} ${cornerChip(m.corner)}${m.result ? ' · <strong>' + esc(m.result) + '</strong>' : ''}</span>
              <span class="rowx"><strong>C${m.court} · #${m.match_no}</strong><button class="linkbtn red" data-act="delm" data-m="${m.id}" aria-label="Delete match ${m.match_no}">Delete</button></span></div>`).join('') || '<div class="small muted">No matches yet</div>'}
            <div class="rowx" style="flex-wrap:wrap">
              <button class="linkbtn" data-act="copylink" data-a="${a.id}">Copy parent link</button>
              <button class="linkbtn" data-act="editphone" data-a="${a.id}">Edit phone</button>
              <button class="linkbtn red" data-act="dela" data-a="${a.id}">Remove athlete</button>
            </div>
          </div>`;
        }).join('') : '<div class="small muted">No athletes yet.</div>'}
      </div>`;
    app.innerHTML = shell(t, 'setup', body);

    // autofill parent details from the dojang roster
    const an = app.querySelector('#an');
    an.oninput = () => {
      const s = roster.find((r) => r.name.toLowerCase() === an.value.trim().toLowerCase());
      if (s) { app.querySelector('#ag').value = s.guardian_name || ''; app.querySelector('#ap').value = s.guardian_phone || ''; }
    };
    app.querySelector('#tset').onsubmit = async (e) => {
      e.preventDefault();
      await must(sb.from('t_tournaments').update({
        name: app.querySelector('#sn').value.trim(),
        event_date: app.querySelector('#sd').value || null,
        courts: Math.min(12, Math.max(1, parseInt(app.querySelector('#sc').value, 10) || t.courts)),
        group_alert_at: Math.min(20, Math.max(1, parseInt(app.querySelector('#sg').value, 10) || 3)),
        signoff: app.querySelector('#so').value.trim() || 'Team Hankook',
      }).eq('id', id));
      toast('Settings saved'); render();
    };
    app.querySelector('#addath').onsubmit = async (e) => {
      e.preventDefault();
      const name = an.value.trim();
      const s = roster.find((r) => r.name.toLowerCase() === name.toLowerCase());
      await must(sb.from('t_athletes').insert({
        tournament_id: id, student_id: s?.id || null, name: s?.name || name,
        guardian_name: app.querySelector('#ag').value.trim() || null,
        phone: app.querySelector('#ap').value.trim() || null,
        channel: app.querySelector('#ac').value,
      }));
      toast(`Added ${first(name)}`); await render(); app.querySelector('#an')?.focus();
    };
    const addm = app.querySelector('#addm');
    if (addm) addm.onsubmit = async (e) => {
      e.preventDefault();
      const rec = {
        tournament_id: id,
        athlete_id: app.querySelector('#ma').value,
        event: app.querySelector('#me').value,
        court: parseInt(app.querySelector('#mc').value, 10),
        match_no: parseInt(app.querySelector('#mn').value, 10),
        division: app.querySelector('#md').value.trim() || null,
        round: app.querySelector('#mr').value || null,
        corner: app.querySelector('#mk').value || null,
      };
      const clash = cache.matches.find((m) => m.court === rec.court && m.match_no === rec.match_no);
      if (clash && !confirm(`Court ${rec.court} #${rec.match_no} is already used by ${cache.byId[clash.athlete_id]?.name}. Add anyway?`)) return;
      await must(sb.from('t_matches').insert(rec));
      ui.matchForm = { athlete: rec.athlete_id, event: rec.event, court: rec.court, division: rec.division, round: rec.round };
      toast(`Saved C${rec.court} · #${rec.match_no}`); await render(); app.querySelector('#mn')?.focus();
    };
  };

  app.onchange = null;
  app.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !cache.t) return;
    const act = el.dataset.act;
    const a = el.dataset.a && cache.byId[el.dataset.a];
    if (act === 'deltour') {
      if (!confirm(`Delete "${cache.t.name}" and all its athletes and matches? This can't be undone.`)) return;
      await must(sb.from('t_tournaments').delete().eq('id', id));
      toast('Tournament deleted');
      location.hash = '#/'; return;
    }
    if (act === 'channel') { await must(sb.from('t_athletes').update({ channel: a.channel === 'sms' ? 'whatsapp' : 'sms' }).eq('id', a.id)); return render(); }
    if (act === 'editphone') {
      const v = prompt(`Parent phone for ${a.name}`, a.phone || '');
      if (v === null) return;
      await must(sb.from('t_athletes').update({ phone: v.trim() || null }).eq('id', a.id)); return render();
    }
    if (act === 'copylink') {
      const link = parentLink(a.token);
      try { await navigator.clipboard.writeText(link); toast('Parent link copied'); } catch { prompt('Copy this link', link); }
      return;
    }
    if (act === 'delm') { if (!confirm('Delete this match?')) return; await must(sb.from('t_matches').delete().eq('id', el.dataset.m)); return render(); }
    if (act === 'dela') { if (!confirm(`Remove ${a.name} and their matches?`)) return; await must(sb.from('t_athletes').delete().eq('id', a.id)); return render(); }
  };
  await render();
}

// ---------- Parent view (public, by secret link) ----------
async function parentPage(token) {
  app.onclick = null; app.onchange = null; app.onsubmit = null;
  const render = async () => {
    const { data, error } = await sb.rpc('t_parent_view', { p_token: token });
    if (error || !data) {
      app.innerHTML = `<div class="empty">This link isn't active. Please check with your coach.</div>`;
      stopPoll(); return;
    }
    const ms = data.matches.map((m) => {
      const s = statusOf(m, { [m.court]: m.current });
      if (s.key === 'past') s.label = 'FINISHING';
      return { ...m, s };
    });
    const nxt = ms.filter((m) => m.s.key !== 'done').sort((x, y) => (x.s.away ?? 999) - (y.s.away ?? 999) || x.match_no - y.match_no)[0];
    const childFirst = first(data.athlete);
    let msg = '';
    if (nxt) {
      const s = nxt.s;
      if (s.key === 'now') msg = `${childFirst} is on the mat now.`;
      else if (s.key === 'deck') msg = `${childFirst} is next. Please bring ${childFirst} to Court ${nxt.court} right away and hand over to the coach.`;
      else if (s.away != null && s.away >= 2 && s.away <= CHECKIN_AT) msg = `${s.away} matches to go. Please check in at Court ${nxt.court} and hand ${childFirst} over to the coach.`;
      else if (s.key === 'past') msg = `This match should be finishing. Your coaches will update the result shortly.`;
      else if (s.away != null) msg = `About ${s.away} matches to go. Please start warming up.`;
      else msg = `Court ${nxt.court} hasn't started yet. This page updates automatically.`;
    }
    app.innerHTML = `
      <header class="parent-top">
        <img class="logo" src="logo.png" alt="High Performance Hankook">
        <div><span class="eyebrow">${esc(data.tournament)} · Live</span>
        <h1 style="color:#fff">${esc(data.athlete)}</h1></div>
      </header>
      ${nxt ? `
      <section class="hero" aria-live="polite">
        <div class="rowx" style="justify-content:space-between">
          <span class="eyebrow accent" style="color:var(--accent)">Next match</span>
          <span class="badge">${nxt.s.label}</span>
        </div>
        <div style="font-size:15px;font-weight:600">${esc(evLabel(nxt))}${nxt.corner ? ' ' + cornerChip(nxt.corner) : ''}</div>
        <div class="big">
          <div><span class="l">Court</span><span class="v">${nxt.court}</span></div>
          <div><span class="l">Match</span><span class="v">#${nxt.match_no}</span></div>
          <div><span class="l">Now on court</span><span class="v">${nxt.current != null ? '#' + nxt.current : '—'}</span></div>
        </div>
        <span style="font-size:14px;line-height:1.4">${esc(msg)}</span>
      </section>
      <section class="pad" style="padding-bottom:0">
        <div class="gear"><strong>Gear check</strong>
          <ul><li>Protective gear on under the uniform</li><li>Mouthguard</li><li>Water bottle</li></ul></div>
      </section>` : `<div class="hero"><span style="font-size:16px;font-weight:700">All done for today. Great job, ${esc(childFirst)}!</span></div>`}
      <div class="pad">
        <h2>Today</h2>
        ${ms.map((m) => `
          <div class="trow"><div><div class="t">${esc(evLabel(m))}</div>
            <div class="small muted">Court ${m.court} · Match #${m.match_no}${m.division ? ' · ' + esc(m.division) : ''}</div>${m.corner ? `<div style="margin-top:4px">${cornerChip(m.corner)}</div>` : ''}</div>
            <strong class="small">${m.result ? esc(m.result) : esc(m.s.label.charAt(0) + m.s.label.slice(1).toLowerCase())}</strong></div>`).join('') || '<div class="small muted">No matches posted yet.</div>'}
      </div>
      <p class="small muted" style="text-align:center;padding:0 20px 24px">Updated by your coaches · refreshes automatically<br>– ${esc(data.signoff)}</p>`;
  };
  const rid = routeId;
  await render();
  startPoll(rid, render, 10000);
}

// ---------- block double taps on any form button ----------
app.addEventListener('submit', (e) => {
  const b = e.target.querySelector('[type=submit]');
  if (!b) return;
  if (b.dataset.busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  b.dataset.busy = '1';
  b.disabled = true;
  setTimeout(() => { b.disabled = false; delete b.dataset.busy; }, 2500);
}, true);

// ---------- boot ----------
sb.auth.onAuthStateChange((_event, s) => {
  const had = !!session;
  session = s;
  if (had !== !!s) route();
});
const { data } = await sb.auth.getSession();
session = data.session;
window.addEventListener('hashchange', route);
route();
