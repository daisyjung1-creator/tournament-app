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
// one field can hold several numbers: "780-722-2161, 587-990-8926 (Dad)"
function parsePhones(str) {
  return String(str || '')
    .split(/[,;\/\n]|\s+(?:or|and|&)\s+/i)
    .map((part) => {
      let d = part.replace(/\D/g, '');
      if (d.length === 10) d = '1' + d;
      if (d.length !== 11) return null;
      const label = (part.match(/\(([^)]*[A-Za-z][^)]*)\)/) || part.match(/([A-Za-z][A-Za-z ]*[A-Za-z])/) || [])[1] || '';
      return { num: d, label: label.trim(), display: `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}` };
    })
    .filter(Boolean)
    .filter((p, i, all) => all.findIndex((q) => q.num === p.num) === i);
}

// bottom sheet to pick which parent number to use
function closeSheet() { document.getElementById('sheet')?.remove(); }
function pickNumber(a, title, onPick, opts = {}) {
  const nums = parsePhones(a.phone);
  if (!nums.length) return toast(`No phone number for ${first(a.name)} — add it in Setup`);
  if (nums.length === 1 && !opts.call) return onPick(nums[0]);
  closeSheet();
  const el = document.createElement('div');
  el.id = 'sheet';
  el.innerHTML = `
    <div class="sheet-bg" data-close></div>
    <div class="sheet" role="dialog" aria-label="${esc(title)}">
      <div class="sheet-title">${esc(title)}</div>
      ${nums.map((n, i) => opts.call
        ? `<a class="btn block ${i ? '' : 'dark'}" href="tel:+${n.num}">${UI.phone}${n.label ? esc(n.label) + ' · ' : ''}${n.display}</a>`
        : `<button class="btn block ${i ? '' : 'dark'}" data-i="${i}">${UI.chat}${n.label ? esc(n.label) + ' · ' : ''}${n.display}</button>`).join('')}
      <button class="btn ghost block" data-close>Cancel</button>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeSheet();
    const b = e.target.closest('[data-i]');
    if (b) { closeSheet(); onPick(nums[+b.dataset.i]); }
    if (e.target.closest('a[href^="tel:"]')) setTimeout(closeSheet, 300);
  });
  document.body.appendChild(el);
}

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

// ---------- connection status ----------
let lastOk = Date.now();
let offline = false;
const isNetErr = (err) => /fetch|network|load failed|timed? ?out|offline/i.test(String(err?.message || err));
function setNet(ok) {
  if (ok) { lastOk = Date.now(); if (!offline) return; offline = false; }
  else offline = true;
  renderNet();
}
function renderNet() {
  const el = document.getElementById('net');
  if (!el) return;
  const down = offline || !navigator.onLine;
  el.hidden = !down;
  if (down) el.textContent = `⚠ No connection — screen is not updating. Last update ${new Date(lastOk).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
window.addEventListener('offline', renderNet);
window.addEventListener('online', () => { renderNet(); });

async function must(promise) {
  let res;
  try { res = await promise; } catch (err) { setNet(false); throw err; }
  const { data, error } = res;
  if (error) {
    if (isNetErr(error)) setNet(false); else toast(error.message);
    throw error;
  }
  setNet(true);
  return data;
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
// start polling only if the user is still on the page that asked for it
function startPoll(rid, fn, ms) {
  if (rid !== routeId) return;
  stopPoll();
  pollTimer = setInterval(() => { if (!document.hidden) fn().catch((err) => { if (isNetErr(err)) setNet(false); }); }, ms);
}

const ICON = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
};

const UI = {
  order: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>',
  users: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  chat: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  login: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  useradd: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
  save: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  link: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  phone: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
  trophy: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  skip: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/></svg>',
  check: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  flag: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H5"/></svg>',
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

const fmtDate = (d) => {
  if (!d) return '';
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
};
const isBlackBelt = (a) => /^black belt/i.test(a?.belt || '');
const needsWeighIn = (a, matches) => isBlackBelt(a) && !a.weigh_in_at && matches.some((m) => m.athlete_id === a.id && m.event === 'Sparring');

// courts where one of our athletes is on the mat or on deck right now
function coachLoad(t, matches, courts) {
  const busy = [...new Set(matches.filter((m) => {
    if (m.result) return false;
    const s = statusOf(m, courts);
    return s.away === 0 || s.away === 1;
  }).map((m) => m.court))].sort((x, y) => x - y);
  return { busy, over: busy.length > t.coaches };
}
const coachBanner = (load, t) => (load.over
  ? `<div class="clash" role="alert" style="margin:12px 20px 0"><strong>⚠ Coaches needed on ${load.busy.length} courts at once</strong> (Courts ${load.busy.join(', ')}) — only ${t.coaches} coaches today. Plan who goes where.</div>`
  : '');

// ---------- rounds & corners ----------
const ROUNDS = ['Round of 64', 'Round of 32', 'Round of 16', 'Quarterfinal', 'Semifinal', 'Final'];
const nextRound = (r) => { const i = ROUNDS.indexOf(r); return i >= 0 && i < ROUNDS.length - 1 ? ROUNDS[i + 1] : ''; };
const evLabel = (m) => `${m.event}${m.round ? ' · ' + m.round : ''}`;
const cornerMsg = (c) => (c === 'Blue' ? '🟦 BLUE corner (Chung)' : c === 'Red' ? '🟥 RED corner (Hong)' : '');
const cornerChip = (c) => (c ? `<span class="corner ${c.toLowerCase()}">${c === 'Blue' ? 'Chung · Blue' : 'Hong · Red'}</span>` : '');

// ---------- messages ----------
const CHECKIN_AT = 3; // 2–3 matches away: check in at the ring; more than that: warm up
const GEAR = '✅ Protective gear on under the uniform\n✅ Mouthguard\n✅ Water bottle';

// which message stage a match is in
const stageOf = (s) => (s.away == null ? 'schedule' : s.away === 1 ? 'next' : s.away <= CHECKIN_AT ? 'checkin' : 'warmup');
const STAGE_LABEL = { schedule: 'schedule', warmup: 'warm-up', checkin: 'check-in', next: 'up next' };
const STAGE_ORDER = ['schedule', 'warmup', 'checkin', 'next'];
const logLine = (who, entries) => {
  const parts = STAGE_ORDER.filter((k) => entries?.[k]).map((k) => `${STAGE_LABEL[k]} ${ago(entries[k])}`);
  return parts.length ? `${who}: ${parts.join(' · ')}` : '';
};

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

const matchLine = (m) => `• ${evLabel(m)} — Court ${m.court}, Match #${m.match_no}${m.corner ? ` (${m.corner === 'Blue' ? '🟦 Blue/Chung' : '🟥 Red/Hong'})` : ''}`;

function dayBeforeMessage(t, a, ms) {
  const child = first(a.name);
  const hi = first(a.guardian_name) ? `Hi ${first(a.guardian_name)}!` : 'Hi!';
  const lines = [
    `${hi} Here are ${child}'s details for ${t.name}${t.event_date ? ` (${fmtDate(t.event_date)})` : ''}:`,
    '',
    t.venue ? `📍 ${t.venue}` : '',
    t.arrival ? `⏰ Please arrive by ${t.arrival}` : '',
    t.weighin_time && isBlackBelt(a) ? `⚖️ Black belt weigh-in at ${t.weighin_time} — please be on time` : '',
    '',
    ms.length ? `${child}'s matches:\n${ms.sort((x, y) => x.match_no - y.match_no).map(matchLine).join('\n')}` : `${child}'s match numbers will be shared as soon as we have them.`,
    '',
    `Please bring:\n${GEAR}`,
    '',
    `We'll message you as ${child}'s turn gets close. Live status: ${parentLink(a.token)}`,
    `– ${t.signoff}`,
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function groupScheduleMessage(t, athletes, matches) {
  const rows = athletes.map((a) => {
    const ms = matches.filter((m) => m.athlete_id === a.id).sort((x, y) => x.match_no - y.match_no);
    const parts = ms.map((m) => `${m.event}${m.round ? ' ' + m.round : ''}: Ct ${m.court} #${m.match_no}`);
    return `• ${shortName(a.name).toUpperCase()} — ${parts.join(' · ') || 'match # to come'}`;
  });
  return [
    `📣 ${t.name}${t.event_date ? ` — ${fmtDate(t.event_date)}` : ''}`,
    t.venue ? `📍 ${t.venue}` : '',
    t.arrival ? `⏰ Please arrive by ${t.arrival}` : '',
    t.weighin_time ? `⚖️ Black belt weigh-in at ${t.weighin_time}` : '',
    '',
    'Our athletes:',
    ...rows,
    '',
    `Please bring:\n${GEAR}`,
    '',
    `Each family will also get a personal live-status link. Good luck everyone! 🧡`,
    `– ${t.signoff}`,
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function openMessage(channel, phone, text) {
  const enc = encodeURIComponent(text);
  const d = phone ? (parsePhones(phone)[0]?.num || '') : '';
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
  closeSheet();
  delete app.dataset.shell; delete app.dataset.page;
  routeId++;
  const h = location.hash || '#/';
  const pm = h.match(/^#\/p\/([0-9a-f-]{36})$/i);
  if (pm) return parentPage(pm[1]);

  if (!session) return loginPage();
  const tm = h.match(/^#\/t\/([0-9a-f-]{36})\/(next|courts|setup|results|poomsae)$/i);
  if (tm) {
    const [, id, tab] = tm;
    if (tab === 'next') return nextPage(id);
    if (tab === 'courts') return courtsPage(id);
    if (tab === 'results') return resultsPage(id);
    if (tab === 'poomsae') return poomsaePage(id);
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
      <button class="btn dark block" type="submit">${UI.login}Sign in</button>
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
    if (!ok.data) { await sb.auth.signOut({ scope: 'local' }); return toast('This account has no tournament access'); }
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
      <button class="btn dark block" type="submit">${UI.flag}Create tournament</button>
    </form>
    <div id="adminbox"></div>`;
  // admin-only: change the shared coach password
  sb.rpc('t_am_admin').then(({ data }) => {
    const box = app.querySelector('#adminbox');
    if (!data || !box) return;
    box.innerHTML = `
      <details class="section">
        <summary>Coach password</summary>
        <form class="stack" id="cpw" style="padding-top:10px">
          <div class="field"><label for="cp1">New coach password</label><input id="cp1" type="text" autocomplete="off" minlength="8" required placeholder="At least 8 characters"></div>
          <div class="small muted">Coaches signed in with the old password will be signed out. Share the new one with them.</div>
          <button class="btn dark block" type="submit">${UI.save}Change coach password</button>
        </form>
      </details>`;
    box.querySelector('#cpw').onsubmit = async (e) => {
      e.preventDefault();
      const pw = box.querySelector('#cp1').value.trim();
      if (pw.length < 8) return toast('Use at least 8 characters');
      if (!confirm(`Change the coach password to "${pw}"?`)) return;
      await must(sb.rpc('t_set_coach_password', { p_password: pw }));
      box.querySelector('#cp1').value = '';
      toast('Coach password changed');
    };
  });
  app.querySelector('[data-act=logout]').onclick = () => sb.auth.signOut({ scope: 'local' });
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
  const [t, athletes, matches, courtRows, lineups, entries] = await Promise.all([
    must(sb.from('t_tournaments').select('*').eq('id', id).single()),
    must(sb.from('t_athletes').select('*').eq('tournament_id', id).order('name')),
    must(sb.from('t_matches').select('*').eq('tournament_id', id).order('match_no')),
    must(sb.from('t_courts').select('*').eq('tournament_id', id)),
    must(sb.from('t_lineups').select('*').eq('tournament_id', id).order('created_at')),
    must(sb.from('t_lineup_entries').select('*').eq('tournament_id', id).order('position')),
  ]);
  lineups.forEach((l) => { l.entries = entries.filter((e) => e.lineup_id === l.id).sort((x, y) => x.position - y.position); });
  const courts = {};
  courtRows.forEach((c) => { courts[c.court] = c.current_match; });
  const byId = Object.fromEntries(athletes.map((a) => [a.id, a]));
  cache = { id, t, athletes, matches, courts, byId, lineups };
  return cache;
}

function shell(t, tab, body) {
  const tabs = [['next', 'Up Next', ICON.list], ['courts', 'Courts', ICON.grid], ['poomsae', 'Brackets', UI.order], ['results', 'Results', UI.trophy], ['setup', 'Setup', ICON.edit]];
  return `
    <header class="top">
      <div class="row"><img class="logo" src="logo.png" alt="High Performance Hankook"><span class="eyebrow">${esc(t.event_date || '')}</span></div>
      <a class="back" href="#/">‹ All tournaments</a>
      <h1>${esc(t.name)}</h1>
    </header>
    <div id="view">${body}</div>
    <nav class="bottom"><div class="in">
      ${tabs.map(([k, label, icon]) => `<a href="#/t/${t.id}/${k}" class="${k === tab ? 'on' : ''}">${icon}${label}</a>`).join('')}
    </div></nav>`;
}

// Draw a tournament screen. On refreshes, only the part below the header changes,
// and nothing is touched if the content is identical — so the logo never flickers.
function paint(t, tab, body) {
  const key = `${t.id}|${tab}|${t.name}|${t.event_date || ''}`;
  const view = document.getElementById('view');
  if (app.dataset.shell === key && view) {
    if (view.dataset.html !== body) { view.innerHTML = body; view.dataset.html = body; }
    return;
  }
  app.innerHTML = shell(t, tab, body);
  app.dataset.shell = key;
  document.getElementById('view').dataset.html = body;
}
// same idea for full pages without the tournament header (parent page)
function paintPage(html) {
  if (app.dataset.page === html) return;
  app.innerHTML = html;
  app.dataset.page = html;
  delete app.dataset.shell;
}

// ---------- Up Next (waiting-area coach) ----------
async function nextPage(id) {
  app.onsubmit = null;
  const render = async (local) => {
    const { t, matches, courts, byId } = local && cache.id === id ? cache : await loadT(id);
    const rows = matches
      .filter((m) => ui.filter === 'All' || m.event === ui.filter)
      .map((m) => ({ m, a: byId[m.athlete_id], s: statusOf(m, courts) }))
      .filter((r) => r.a);
    const active = rows.filter((r) => r.s.key !== 'done');
    const rank = (r) => (r.s.away == null ? 1000 + r.m.match_no : r.s.away < 0 ? -1 : r.s.away);
    active.sort((x, y) => rank(x) - rank(y) || x.m.court - y.m.court);
    const onMat = active.filter((r) => r.s.key === 'now');
    const needResult = active.filter((r) => r.s.key === 'past');
    const soon = active.filter((r) => r.s.away != null && r.s.away >= 1 && r.s.away <= t.group_alert_at);
    const later = active.filter((r) => !onMat.includes(r) && !needResult.includes(r) && !soon.includes(r));
    const done = rows.filter((r) => r.s.key === 'done');
    ui.expanded = ui.expanded || new Set();

    // same athlete needed on another court soon (e.g. sparring and poomsae overlapping)
    const clashes = (m) => matches
      .filter((o) => o.athlete_id === m.athlete_id && o.id !== m.id && o.court !== m.court && !o.result)
      .map((o) => ({ o, s: statusOf(o, courts) }))
      .filter(({ s }) => s.away != null && s.away <= t.group_alert_at);

    const card = ({ m, a, s }) => {
      const clash = s.key === 'done' ? [] : clashes(m);
      const nl = m.notify_log || {};
      const stage = stageOf(s);
      const sentP = !!nl.parent?.[stage], sentG = !!nl.group?.[stage];
      const log = [
        m.checked_in_at ? `Checked in ${ago(m.checked_in_at)}` : '',
        logLine('Parent', nl.parent),
        logLine('Group', nl.group),
      ].filter(Boolean).join('<br>');
      const kind = s.key === 'now' ? 'live' : s.key === 'deck' ? 'deck' : s.key === 'past' ? 'needres' : s.key === 'soon1' ? 'hot' : '';
      return `
      <article class="card ${kind}">
        ${s.key === 'now' ? `<div class="live-tag"><span class="pulse" aria-hidden="true"></span>ON THE MAT · COURT ${m.court}</div>` : ''}
        ${s.key === 'deck' ? `<div class="deck-tag">NEXT UP · COURT ${m.court}</div>` : ''}
        ${s.key === 'past' ? `<div class="res-tag">Match passed — enter the result</div>` : ''}
        <div class="head">
          <div><div class="name">${esc(a.name)}</div><div class="meta">${esc(evLabel(m))}${m.division ? ' · ' + esc(m.division) : ''}</div></div>
          <div class="where">Court ${m.court} · #${m.match_no}<br><span class="status ${s.key}">${s.label}</span>
            ${s.key === 'done' ? cornerChip(m.corner) : `<br><button class="corner-btn ${m.corner ? m.corner.toLowerCase() : ''}" data-act="corner" data-m="${m.id}" aria-label="Corner: ${m.corner || 'not set'}. Tap to change">${m.corner ? (m.corner === 'Blue' ? 'Chung · Blue' : 'Hong · Red') : 'Set corner'}</button>`}</div>
        </div>
        ${(() => { if (s.key === 'done') return ''; const n = divisionNote(cache.lineups, matches, a.id, m.event); return n ? `<div class="order-note">${UI.order}<span>${n}</span></div>` : ''; })()}
        ${m.event === 'Sparring' && s.key !== 'done' && needsWeighIn(a, matches) ? `<button class="weigh need" data-act="weigh" data-a="${a.id}">⚖ Weigh-in not done — tap when passed</button>` : ''}
        ${clash.map(({ o, s: os }) => `<div class="clash" role="note"><strong>⚠ Also needed on Court ${o.court}</strong> — ${esc(evLabel(o))} #${o.match_no}, ${os.away <= 0 ? 'on the mat now' : os.away === 1 ? 'on deck' : os.away + ' away'}. Tell the court table if needed.</div>`).join('')}
        ${['done', 'now', 'past'].includes(s.key) ? '' : `
        <div class="tools">
          <button class="btn ${sentG ? 'ghost' : ''}" style="flex:1" data-act="group" data-m="${m.id}">${sentG ? UI.check + 'Group again' : UI.users + 'Post to group'}</button>
          <button class="btn ${sentP ? 'ghost' : 'dark'}" style="flex:1" data-act="parent" data-m="${m.id}">${sentP ? UI.check + 'Parent again' : UI.chat + 'Message parent'}</button>
        </div>`}
        <div class="tools">
          <button class="btn icon ${m.checked_in_at ? 'on' : 'ghost'}" aria-label="${m.checked_in_at ? 'Checked in for this match — tap to undo' : 'Mark checked in for this match'}" aria-pressed="${!!m.checked_in_at}" data-act="checkin" data-m="${m.id}">${ICON.check}</button>
          ${(() => { const ph = parsePhones(a.phone); return !ph.length ? '' : ph.length === 1
            ? `<a class="btn icon ghost" aria-label="Call ${esc(a.guardian_name || 'parent')}" href="tel:+${ph[0].num}">${ICON.phone}</a>`
            : `<button class="btn icon ghost" aria-label="Call parent (${ph.length} numbers)" data-act="call" data-a="${a.id}">${ICON.phone}<span class="badge-n">${ph.length}</span></button>`; })()}
          <select aria-label="Result for ${esc(a.name)} match ${m.match_no}" data-act="result" data-m="${m.id}">
            ${['', 'Win', 'Loss', 'Gold', 'Silver', 'Bronze', 'Done'].map((r) => `<option value="${r}" ${(m.result || '') === r ? 'selected' : ''}>${r || 'Result…'}</option>`).join('')}
          </select>
        </div>
        ${log ? `<div class="log">${log}</div>` : ''}
      </article>`;
    };

    // waiting: one compact line each; tap to open the full card
    const row = (r) => {
      const { m, a, s } = r;
      if (ui.expanded.has(m.id)) return `<div class="expanded">${card(r)}<button class="linkbtn" data-act="collapse" data-m="${m.id}">Collapse</button></div>`;
      const sent = Object.keys(m.notify_log?.parent || {}).length + Object.keys(m.notify_log?.group || {}).length;
      return `
      <button class="wrow" data-act="expand" data-m="${m.id}" aria-label="${esc(a.name)}, ${esc(evLabel(m))}, court ${m.court} match ${m.match_no}, ${s.label}. Tap for actions">
        <span class="wname">${esc(a.name)}<small>${esc(evLabel(m))}${m.corner ? ' · ' + (m.corner === 'Blue' ? 'Chung' : 'Hong') : ''}${sent ? ' · messaged' : ''}</small></span>
        <span class="wwhere">C${m.court} · #${m.match_no}<small>${s.away == null ? 'not started' : s.away + ' away'}</small></span>
      </button>`;
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
        <div class="tools"><button class="btn dark" style="flex:1" type="submit">${UI.trophy}Add next match</button>
          <button class="btn ghost" type="button" data-act="skipnext" data-m="${m.id}">${UI.skip}Skip</button></div>
      </form>`;
    };

    const filters = ['All', 'Sparring', 'Poomsae'];
    const body = `
      ${coachBanner(coachLoad(t, matches, courts), t)}
      <div class="chips">${filters.map((f) => `<button class="chip-btn ${ui.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}">${f}</button>`).join('')}</div>
      ${!matches.length ? `<div class="empty">No matches yet. Add athletes and match numbers in <a href="#/t/${id}/setup">Setup</a>.</div>` : ''}
      ${matches.length ? `
      <div class="counts" role="group" aria-label="Jump to section">
        <button class="cnt live" data-act="jump" data-to="sec-now" ${onMat.length ? '' : 'disabled'}><strong>${onMat.length}</strong>On mat</button>
        <button class="cnt next" data-act="jump" data-to="sec-next" ${soon.length ? '' : 'disabled'}><strong>${soon.length}</strong>Up next</button>
        <button class="cnt" data-act="jump" data-to="sec-wait" ${later.length ? '' : 'disabled'}><strong>${later.length}</strong>Waiting</button>
        <button class="cnt" data-act="jump" data-to="sec-done" ${done.length ? '' : 'disabled'}><strong>${done.length}</strong>Done</button>
      </div>` : ''}
      ${onMat.length ? `<h2 class="sec live" id="sec-now"><span class="pulse" aria-hidden="true"></span>On the mat now<span class="n">${onMat.length}</span></h2><div class="list">${onMat.map(card).join('')}</div>` : ''}
      ${needResult.length ? `<h2 class="sec warn">Needs a result<span class="n">${needResult.length}</span></h2><div class="list">${needResult.map(card).join('')}</div>` : ''}
      ${needNext.length ? `<h2 class="sec next">Next round needed<span class="n">${needNext.length}</span></h2><div class="list">${needNext.map(nextForm).join('')}</div>` : ''}
      ${soon.length ? `<h2 class="sec next" id="sec-next">Up next<span class="n">${soon.length}</span><small>within ${t.group_alert_at} matches</small></h2><div class="list">${soon.map(card).join('')}</div>` : ''}
      ${later.length ? `<h2 class="sec" id="sec-wait">Waiting<span class="n">${later.length}</span><small>tap a name for actions</small></h2><div class="list tight">${later.map(row).join('')}</div>` : ''}
      ${done.length ? `<details class="pad" id="sec-done"><summary>Finished (${done.length})</summary><div class="list" style="padding:8px 0">${done.map(card).join('')}</div></details>` : ''}`;
    // keep the "Finished" panel open across refreshes
    const wasOpen = app.querySelector('details')?.open;
    const y = window.scrollY;
    paint(t, 'next', body);
    if (wasOpen && app.querySelector('details')) app.querySelector('details').open = true;
    window.scrollTo(0, y);
  };

  app.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !cache.t) return;
    const act = el.dataset.act;
    if (act === 'filter') { ui.filter = el.dataset.f; return render(true); }
    if (act === 'expand') { ui.expanded.add(el.dataset.m); return render(true); }
    if (act === 'collapse') { ui.expanded.delete(el.dataset.m); return render(true); }
    if (act === 'jump') {
      const target = document.getElementById(el.dataset.to);
      if (target) { if (target.tagName === 'DETAILS') target.open = true; window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - document.querySelector('header.top').offsetHeight - 8, behavior: 'smooth' }); }
      return;
    }
    if (act === 'group' || act === 'parent') {
      const m = cache.matches.find((x) => x.id === el.dataset.m);
      const a = cache.byId[m.athlete_id];
      const s = statusOf(m, cache.courts);
      const text = act === 'group' ? groupMessage(m, a, cache.t, s) : parentMessage(m, a, cache.t, s);
      const col = act === 'group' ? 'group_notified_at' : 'parent_notified_at';
      const who = act === 'group' ? 'group' : 'parent';
      const send = (num) => {
        const now = new Date().toISOString();
        const nl = { ...(m.notify_log || {}) };
        nl[who] = { ...(nl[who] || {}), [stageOf(s)]: now };
        m.notify_log = nl;
        openMessage(act === 'group' ? 'group' : a.channel, num?.num, text);
        render(true);
        sb.from('t_matches').update({ [col]: now, notify_log: nl }).eq('id', m.id).then(() => render());
      };
      if (act === 'group') return send(null);
      return pickNumber(a, `Message ${first(a.name)}'s parent`, send);
    }
    if (act === 'call') {
      const a = cache.byId[el.dataset.a];
      return pickNumber(a, `Call ${first(a.name)}'s parent`, () => {}, { call: true });
    }
    if (act === 'corner') {
      const m = cache.matches.find((x) => x.id === el.dataset.m);
      const nextC = m.corner === 'Blue' ? 'Red' : m.corner === 'Red' ? null : 'Blue';
      m.corner = nextC;
      render(true);
      await must(sb.from('t_matches').update({ corner: nextC }).eq('id', m.id)).catch(() => render());
      return;
    }
    if (act === 'weigh') {
      const a = cache.byId[el.dataset.a];
      a.weigh_in_at = a.weigh_in_at ? null : new Date().toISOString();
      render(true);
      toast(a.weigh_in_at ? `${first(a.name)} passed weigh-in` : 'Weigh-in undone');
      await must(sb.from('t_athletes').update({ weigh_in_at: a.weigh_in_at }).eq('id', a.id)).catch(() => render());
      return;
    }
    if (act === 'skipnext') { ui.skipNext = [...(ui.skipNext || []), el.dataset.m]; return render(true); }
    if (act === 'checkin') {
      const m = cache.matches.find((x) => x.id === el.dataset.m);
      m.checked_in_at = m.checked_in_at ? null : new Date().toISOString();
      render(true);
      toast(m.checked_in_at ? `${first(cache.byId[m.athlete_id]?.name)} checked in for #${m.match_no}` : 'Check-in undone');
      await must(sb.from('t_matches').update({ checked_in_at: m.checked_in_at }).eq('id', m.id)).catch(() => render());
      return;
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
    // medals follow from the round: semifinal loss = bronze (both losers), final = gold / silver
    let result = el.value || null;
    if (m?.round === 'Semifinal' && result === 'Loss') result = 'Bronze';
    if (m?.round === 'Final' && result === 'Win') result = 'Gold';
    if (m?.round === 'Final' && result === 'Loss') result = 'Silver';
    // show it right away, save in the background
    if (m) m.result = result;
    if (dropLater.length) cache.matches = cache.matches.filter((o) => !dropLater.includes(o.id));
    document.activeElement?.blur();
    render(true);
    const medal = { Gold: ' 🥇', Silver: ' 🥈', Bronze: ' 🥉' }[result] || '';
    toast(result ? `Saved: ${result}${medal}` : 'Result cleared');
    try {
      await must(sb.from('t_matches').update({ result }).eq('id', el.dataset.m));
      if (dropLater.length) await must(sb.from('t_matches').delete().in('id', dropLater));
    } finally { render(); }
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
  const render = async (local) => {
    const { t, matches, courts, byId } = local && cache.id === id ? cache : await loadT(id);
    const cells = [];
    for (let c = 1; c <= t.courts; c++) {
      const cur = courts[c];
      const upcoming = matches
        .filter((m) => m.court === c && !m.result)
        .sort((x, y) => x.match_no - y.match_no);
      const nxt = upcoming[0];
      const near = nxt && cur != null && nxt.match_no - cur <= t.group_alert_at;
      const live = nxt && cur != null && nxt.match_no === cur;
      const nextTxt = nxt
        ? `${esc(shortName(byId[nxt.athlete_id]?.name))} at #${nxt.match_no}${cur != null ? ` (${nxt.match_no < cur ? 'add result' : nxt.match_no - cur === 0 ? 'on the mat' : nxt.match_no - cur === 1 ? 'on deck' : (nxt.match_no - cur) + ' away'})` : ''}`
        : 'No athletes queued';
      cells.push(`
        <section class="court ${live ? 'live' : near ? 'ours' : ''}">
          <div class="rowx" style="justify-content:space-between"><strong>Court ${c}</strong>${live ? '<span class="live-mini"><span class="pulse" aria-hidden="true"></span>LIVE</span>' : near ? '<span class="dot" role="img" aria-label="Our athlete is close"></span>' : ''}</div>
          ${live ? `<div class="live-name">${esc(shortName(byId[nxt.athlete_id]?.name))} on the mat</div>` : ''}
          <form data-court="${c}" style="display:flex;flex-direction:column;gap:4px">
            <label for="cn${c}" class="eyebrow" style="font-size:11px">Now on mat</label>
            <div class="rowx" style="gap:6px">
              <input id="cn${c}" class="numin" type="number" min="1" inputmode="numeric" value="${cur ?? ''}" placeholder="#">
              <button class="btn ghost" type="submit" style="height:44px;padding:0 10px;font-size:13px;flex:none">${UI.check}Set</button>
            </div>
          </form>
          <div class="next">${nextTxt}</div>
          <div class="rowx">
            <button class="btn ghost icon" type="button" data-act="dec" data-c="${c}" aria-label="Previous match on court ${c}" ${cur == null ? 'disabled' : ''}>${UI.minus}</button>
            <button class="btn dark" type="button" style="flex:1" data-act="inc" data-c="${c}" aria-label="Next match on court ${c}">${UI.plus}<span>Next</span></button>
          </div>
        </section>`);
    }
    const y = window.scrollY;
    paint(t, 'courts', `
      ${coachBanner(coachLoad(t, matches, courts), t)}
      <p class="pad small muted" style="margin:0;padding-bottom:0">Type the match number on the mat and tap <strong>Set</strong> once. After that, tap <strong>+</strong> each time a match finishes.</p>
      <div class="courts">${cells.join('')}</div>`);
    window.scrollTo(0, y);
  };

  const save = async (c, val) => {
    cache.courts[c] = val; // show the change right away
    render(true);
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
    // use what's on screen (refreshed every few seconds) so the tap responds instantly
    const cur = cache.courts[c] ?? null;
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

// ---------- Brackets (tree) and poomsae order ----------
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const WIN = ['Win', 'Gold'], LOSE = ['Loss', 'Silver', 'Bronze'];
const roundName = (r, rounds) => ({ 1: 'Final', 2: 'Semifinal', 3: 'Quarterfinal', 4: 'Round of 16', 5: 'Round of 32', 6: 'Round of 64' }[rounds - r] || `Round ${r + 1}`);
const shortRound = (n) => ({ Final: 'Final', Semifinal: 'Semi', Quarterfinal: 'QF', 'Round of 16': 'R16', 'Round of 32': 'R32', 'Round of 64': 'R64' }[n] || n);

// "1. Mia Lee (Hankook)" / "Mia Lee, Hankook" / "BYE" -> { name, club } or { bye: true }
function parseLines(text) {
  return String(text || '').split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    line = line.replace(/^\s*\d+\s*[.)\-:]?\s+/, '');
    if (/^(bye|-+|—)$/i.test(line)) return { bye: true };
    const m = line.match(/^(.*?)\s*\((.+)\)\s*$/) || line.match(/^(.*?)\s*(?:,|\s-\s|\t|\s\|\s)\s*(.+)$/);
    return m ? { name: m[1].trim(), club: m[2].trim() } : { name: line, club: '' };
  });
}

// Work out the whole tree: who is in each box, who won (stored taps + our athletes' results)
function buildBracket(l, matches) {
  const maxPos = Math.max(2, ...l.entries.map((e) => e.position));
  const size = 2 ** Math.ceil(Math.log2(maxPos));
  const rounds = Math.log2(size);
  const bySlot = Object.fromEntries(l.entries.map((e) => [e.position, e]));
  const BYE = { bye: true };
  // our athletes: how far their results say they got in this event
  const prog = {};
  l.entries.filter((e) => e.athlete_id).forEach((e) => {
    const ms = matches.filter((m) => m.athlete_id === e.athlete_id && m.event === l.event && m.result);
    prog[e.position] = { wins: ms.filter((m) => WIN.includes(m.result)).length, lost: ms.some((m) => LOSE.includes(m.result)) };
  });
  let occ = Array.from({ length: size }, (_, i) => bySlot[i + 1] || BYE);
  const out = [];
  let k = 0;
  for (let r = 0; r < rounds; r++) {
    const ms = [], next = [];
    for (let m = 0; m < occ.length / 2; m++) {
      const A = occ[2 * m], B = occ[2 * m + 1];
      const key = `${r}-${m}`;
      let w = null;
      const stored = l.winners?.[key];
      if (stored && (A?.position === stored || B?.position === stored)) w = A?.position === stored ? A : B;
      else if (A?.bye && B?.bye) w = BYE;
      else if (A && !A.bye && B?.bye) w = A;
      else if (B && !B.bye && A?.bye) w = B;
      else {
        for (const [me, op] of [[A, B], [B, A]]) {
          const p = me && !me.bye && prog[me.position];
          if (!p) continue;
          if (r < p.wins) w = me;
          else if (r === p.wins && p.lost && op && !op.bye) w = op;
        }
      }
      ms.push({ r, m, key, A, B, w, no: (l.match_nos || [])[k] || null, real: !(A?.bye || B?.bye) });
      next.push(w);
      k++;
    }
    out.push({ name: roundName(r, rounds), matches: ms });
    occ = next;
  }
  return { rounds: out, size, champion: occ[0] && !occ[0].bye ? occ[0] : null };
}

// where one of our athletes stands in a bracket
function ourStatus(br, e) {
  for (const rd of br.rounds) {
    for (const mt of rd.matches) {
      const isA = mt.A === e, isB = mt.B === e;
      if (!isA && !isB) continue;
      if (!mt.real && mt.w === e) continue; // bye
      const op = isA ? mt.B : mt.A;
      if (mt.w === e) continue;
      if (mt.w && mt.w !== e) return { out: true, round: rd.name };
      return { round: rd.name, op, no: mt.no, mt };
    }
  }
  return br.champion === e ? { champion: true } : null;
}
const opLabel = (op, br, mt) => {
  if (op && !op.bye) return `${esc(op.name)}${op.club ? ` <span class="muted">(${esc(op.club)})</span>` : ''}`;
  // opponent not decided yet: winner of the feeding match
  const prev = br.rounds[mt.r - 1]?.matches[(mt.m * 2) + (mt.A === op ? 0 : 1)];
  if (prev && prev.A && prev.B && !prev.A.bye && !prev.B.bye) return `winner of ${esc(shortName(prev.A.name))} / ${esc(shortName(prev.B.name))}`;
  return 'TBD';
};

// order-type division: "Mia: 4th of 7 · 2 ahead"
const orderText = (l, e) => {
  const now = l.now_position, ahead = now ? e.position - now : null;
  return `${ordinal(e.position)} of ${l.entries.length}${ahead == null ? '' : ahead > 0 ? ` · ${ahead} ahead` : ahead === 0 ? ' · performing now' : ' · done'}`;
};
// note shown on an athlete's Up Next card
function divisionNote(lineups, matches, athleteId, event) {
  for (const l of lineups || []) {
    if (l.event !== event) continue;
    const e = l.entries.find((x) => x.athlete_id === athleteId);
    if (!e) continue;
    if (l.format === 'order') return `${esc(l.name)}: performs ${orderText(l, e)}`;
    const br = buildBracket(l, matches); const st = ourStatus(br, e);
    if (!st || st.out || st.champion) return '';
    return `${esc(st.round)} vs ${opLabel(st.op, br, st.mt)}`;
  }
  return '';
}

async function poomsaePage(id) {
  app.onchange = null; app.oninput = null;
  const render = async (local) => {
    const { t, lineups, matches } = local && cache.id === id ? cache : await loadT(id);
    const card = (l) => {
      const expanded = ui.openLineup === l.id;
      const ours = l.entries.filter((e) => e.athlete_id);
      const head = `
        <div class="head">
          <div><div class="name">${esc(l.name)}</div>
            <div class="meta">${esc(l.event)}${l.court ? ' · Court ' + l.court : ''} · ${l.entries.length} athletes${ours.length ? ` · ${ours.length} ours` : ''}</div></div>
          ${l.format === 'order' ? `<div class="where">${l.now_position ? `Now: ${ordinal(l.now_position)}` : 'Not started'}</div>` : ''}
        </div>`;
      let summary = '', detail = '';
      if (l.format === 'order') {
        summary = ours.map((e) => `<div class="small"><strong style="color:var(--accent-ink)">${esc(e.name)}</strong> — ${orderText(l, e)}</div>`).join('') + `
        <div class="rowx">
          <button class="btn ghost icon" data-act="lprev" data-l="${l.id}" aria-label="Previous performer" ${l.now_position ? '' : 'disabled'}>${UI.minus}</button>
          <button class="btn dark" style="flex:1" data-act="lnext" data-l="${l.id}">${UI.plus}${l.now_position ? 'Next performer' : 'Start (1st up)'}</button>
        </div>`;
        detail = `<ol class="lineup-list">${l.entries.map((e) => `
          <li class="${e.athlete_id ? 'ours' : ''} ${l.now_position === e.position ? 'now' : ''} ${l.now_position && e.position < l.now_position ? 'past' : ''}">
            <button class="lrow" data-act="lset" data-l="${l.id}" data-p="${e.position}" aria-label="Set ${esc(e.name)} as performing now">
              <span class="pos">${e.position}</span><span class="who">${esc(e.name)}${e.club ? `<small>${esc(e.club)}</small>` : ''}</span>
              ${l.now_position === e.position ? '<span class="tag now">NOW</span>' : e.athlete_id ? '<span class="tag ours">OURS</span>' : ''}
            </button></li>`).join('')}</ol>`;
      } else {
        const br = buildBracket(l, matches);
        summary = ours.map((e) => {
          const st = ourStatus(br, e);
          const txt = !st ? '' : st.champion ? '🏆 Won the division' : st.out ? `finished in ${st.round}` : `${st.round} vs ${opLabel(st.op, br, st.mt)}${st.no ? ` · #${st.no}` : ''}`;
          return `<div class="small"><strong style="color:var(--accent-ink)">${esc(e.name)}</strong> — ${txt}</div>`;
        }).join('');
        const ourPath = new Set(ours);
        const box = (mt, x, isTop) => {
          if (!x) return `<div class="bslot tbd">—</div>`;
          if (x.bye) return `<div class="bslot bye">bye</div>`;
          const won = mt.w === x, lost = mt.w && mt.w !== x && !mt.w.bye;
          const canTap = mt.real && mt.A && mt.B && !mt.A.bye && !mt.B.bye;
          return `<button class="bslot ${ourPath.has(x) ? 'ours' : ''} ${won ? 'won' : ''} ${lost ? 'lost' : ''}" ${canTap ? `data-act="bwin" data-l="${l.id}" data-k="${mt.key}" data-p="${x.position}"` : 'disabled'} aria-label="${esc(x.name)}${won ? ', won' : ''}">
            <span class="bn">${esc(shortName(x.name))}</span>${x.club ? `<span class="bc">${esc(x.club)}</span>` : ''}</button>`;
        };
        detail = `
        <div class="small muted">Scroll sideways. Our results fill in automatically; tap a name to mark another winner.</div>
        <div class="tree-scroll"><div class="tree">
          ${br.rounds.map((rd, ri) => `
            <div class="round ${ri === 0 ? 'first' : ''} ${ri === br.rounds.length - 1 ? 'last' : ''}">
              <div class="rname">${esc(shortRound(rd.name))}</div>
              <div class="rmatches">
              ${rd.matches.map((mt) => `
                <div class="mwrap"><div class="mbox ${[mt.A, mt.B].some((x) => ourPath.has(x)) ? 'has-ours' : ''} ${!mt.real ? 'byematch' : ''}">
                  ${mt.no ? `<span class="mno">#${mt.no}</span>` : ''}
                  ${box(mt, mt.A, true)}${box(mt, mt.B, false)}
                </div></div>`).join('')}
              </div>
            </div>`).join('')}
          <div class="round champ"><div class="rname">🏆</div><div class="rmatches"><div class="mwrap"><div class="mbox">${br.champion ? `<div class="bslot won ${ourPath.has(br.champion) ? 'ours' : ''}"><span class="bn">${esc(shortName(br.champion.name))}</span></div>` : '<div class="bslot tbd">—</div>'}</div></div></div></div>
        </div></div>`;
      }
      return `
      <section class="card lineup">
        ${head}
        ${summary}
        <button class="btn ghost block" data-act="ltoggle" data-l="${l.id}" aria-expanded="${expanded}">${UI.order}${expanded ? (l.format === 'order' ? 'Hide full order' : 'Hide bracket') : (l.format === 'order' ? `Show full order (${l.entries.length})` : `Show bracket (${l.entries.length})`)}</button>
        ${expanded ? `${detail}
        <div class="rowx" style="flex-wrap:wrap">
          <button class="linkbtn" data-act="ledit" data-l="${l.id}">${ICON.edit}Edit</button>
          <button class="linkbtn red" data-act="ldel" data-l="${l.id}">${UI.trash}Delete</button>
        </div>
        ${ui.editLineup === l.id ? lineupForm(t, l) : ''}` : ''}
      </section>`;
    };
    const body = `
      <p class="pad small muted" style="margin:0;padding-bottom:0">Our athletes' place in each division. <strong>Show bracket</strong> opens the full tree with every athlete.</p>
      <div class="list">${lineups.length ? lineups.map(card).join('') : '<div class="empty">No brackets yet. Add one below, or send Claude a photo of the bracket.</div>'}</div>
      <div class="section">${ui.editLineup === 'new' ? lineupForm(t, null) : `<button class="btn block" data-act="lnew">${UI.plus}Add a division</button>`}</div>`;
    paint(t, 'poomsae', body);
  };
  const setNow = async (l, pos) => {
    l.now_position = pos; render(true);
    await must(sb.from('t_lineups').update({ now_position: pos }).eq('id', l.id)).catch(() => render());
  };
  app.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !cache.t) return;
    const act = el.dataset.act;
    const l = el.dataset.l && cache.lineups.find((x) => x.id === el.dataset.l);
    if (act === 'lnew') { ui.editLineup = 'new'; return render(true); }
    if (act === 'ledit') { ui.editLineup = l.id; return render(true); }
    if (act === 'lcancel') { ui.editLineup = null; return render(true); }
    if (act === 'ltoggle') { ui.openLineup = ui.openLineup === l.id ? null : l.id; return render(true); }
    if (act === 'lnext') return setNow(l, Math.min(l.entries.length, (l.now_position || 0) + 1));
    if (act === 'lprev') return setNow(l, l.now_position > 1 ? l.now_position - 1 : null);
    if (act === 'lset') return setNow(l, +el.dataset.p === l.now_position ? null : +el.dataset.p);
    if (act === 'bwin') {
      const w = { ...(l.winners || {}) }, p = +el.dataset.p;
      if (w[el.dataset.k] === p) delete w[el.dataset.k]; else w[el.dataset.k] = p;
      l.winners = w; render(true);
      await must(sb.from('t_lineups').update({ winners: w }).eq('id', l.id)).catch(() => render());
      return;
    }
    if (act === 'ldel') {
      if (!confirm(`Delete "${l.name}"?`)) return;
      await must(sb.from('t_lineups').delete().eq('id', l.id)); return render();
    }
  };
  app.onsubmit = async (e) => {
    const f = e.target.closest('form[data-lineup]');
    if (!f) return;
    e.preventDefault();
    const fd = new FormData(f);
    const lines = parseLines(fd.get('list'));
    if (!lines.some((x) => !x.bye)) return toast('Add at least one name');
    const format = fd.get('format');
    const rec = {
      name: String(fd.get('name')).trim() || 'Division',
      court: parseInt(fd.get('court'), 10) || null,
      format, event: fd.get('event'),
      match_nos: String(fd.get('match_nos') || '').split(/[\s,]+/).map((x) => parseInt(x, 10)).filter((x) => x > 0),
    };
    let lid = f.dataset.lineup;
    if (lid === 'new') {
      const row = await must(sb.from('t_lineups').insert({ tournament_id: id, ...rec }).select().single());
      lid = row.id;
    } else {
      await must(sb.from('t_lineups').update({ ...rec, winners: {} }).eq('id', lid));
      await must(sb.from('t_lineup_entries').delete().eq('lineup_id', lid));
    }
    const ours = Object.fromEntries(cache.athletes.map((a) => [normName(a.name), a]));
    const rows = [];
    let pos = 0;
    for (const x of lines) {
      pos++;
      if (x.bye) { if (format === 'order') pos--; continue; }
      const me = ours[normName(x.name)];
      rows.push({ tournament_id: id, lineup_id: lid, position: pos, name: me ? me.name : x.name, club: x.club || null, athlete_id: me ? me.id : null });
    }
    await must(sb.from('t_lineup_entries').insert(rows));
    const linked = rows.filter((r) => r.athlete_id).length;
    ui.editLineup = null;
    toast(`Saved ${rows.length} athletes${linked ? ` · ${linked} ours` : ''}`);
    render();
  };
  const rid = routeId;
  await render();
  startPoll(rid, () => (document.activeElement?.matches('input, textarea, select') ? Promise.resolve() : render()), POLL_MS);
}
function lineupForm(t, l) {
  let text = '';
  if (l) {
    const max = Math.max(0, ...l.entries.map((e) => e.position));
    const by = Object.fromEntries(l.entries.map((e) => [e.position, e]));
    text = Array.from({ length: max }, (_, i) => by[i + 1] ? (by[i + 1].club ? `${by[i + 1].name}, ${by[i + 1].club}` : by[i + 1].name) : 'BYE').join('\n');
  }
  const fmt = l?.format || 'bracket';
  return `
  <form class="editbox stack" data-lineup="${l ? l.id : 'new'}" style="margin-top:8px">
    <div class="field"><label for="ln">Division</label><input id="ln" name="name" value="${esc(l?.name || '')}" placeholder="e.g. Cadet F -47kg" required></div>
    <div class="grid2">
      <div class="field"><label for="le">Event</label><select id="le" name="event">${['Sparring', 'Poomsae'].map((e) => `<option ${(l?.event || 'Sparring') === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
      <div class="field"><label for="lc">Court</label><select id="lc" name="court"><option value="">—</option>${Array.from({ length: t.courts }, (_, i) => i + 1).map((c) => `<option ${l?.court === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="lf">Type</label><select id="lf" name="format">
      <option value="bracket" ${fmt === 'bracket' ? 'selected' : ''}>Bracket (tree)</option>
      <option value="order" ${fmt === 'order' ? 'selected' : ''}>Performing order (list)</option></select></div>
    <div class="field"><label for="ll">Athletes — one per line, top to bottom as on the sheet</label>
      <textarea id="ll" name="list" rows="9" placeholder="Jake Tran, Calgary TKD&#10;Mia Lee, Champion Hankook&#10;BYE&#10;Sara Ng, Golden Tiger">${esc(text)}</textarea>
      <span class="small muted">"Name, Club". Write BYE for an empty spot. Our athletes are matched by name.</span></div>
    <div class="field"><label for="lm">Match numbers (optional)</label><input id="lm" name="match_nos" value="${esc((l?.match_nos || []).join(', '))}" placeholder="101, 102, 103 … first round top to bottom, then next round">
    </div>
    <div class="rowx"><button class="btn dark" style="flex:1" type="submit">${UI.save}Save</button><button class="btn ghost" type="button" data-act="lcancel">Cancel</button></div>
  </form>`;
}

// ---------- Results ----------
const MEDAL = { Gold: '🥇', Silver: '🥈', Bronze: '🥉' };
function athleteResults(a, matches) {
  const out = [];
  for (const ev of ['Sparring', 'Poomsae']) {
    const ms = matches.filter((m) => m.athlete_id === a.id && m.event === ev).sort((x, y) => x.match_no - y.match_no);
    if (!ms.length) continue;
    const medal = ms.find((m) => MEDAL[m.result]);
    const last = [...ms].reverse().find((m) => m.result);
    let txt;
    if (medal) txt = `${MEDAL[medal.result]} ${medal.result}`;
    else if (last?.result === 'Loss') txt = last.round ? `reached ${last.round}` : 'competed';
    else if (last?.result === 'Win') txt = `won${last.round ? ' ' + last.round : ''}, still going`;
    else if (last) txt = last.result;
    else txt = 'not finished';
    const wins = ms.filter((m) => m.result === 'Win' || m.result === 'Gold').length;
    out.push({ ev, txt, medal: medal?.result, wins });
  }
  return out;
}
async function resultsPage(id) {
  app.onsubmit = null; app.onchange = null;
  const build = () => {
    const { t, athletes, matches } = cache;
    const per = athletes.map((a) => ({ a, r: athleteResults(a, matches) })).filter((x) => x.r.length);
    const tally = { Gold: 0, Silver: 0, Bronze: 0 };
    per.forEach(({ r }) => r.forEach((x) => { if (x.medal) tally[x.medal]++; }));
    const total = tally.Gold + tally.Silver + tally.Bronze;
    const order = (x) => Math.min(...x.r.map((y) => ({ Gold: 0, Silver: 1, Bronze: 2 }[y.medal] ?? 3)));
    per.sort((x, y) => order(x) - order(y) || x.a.name.localeCompare(y.a.name));
    const text = [
      `🏆 ${t.name} results — ${t.signoff}`,
      `🥇 ${tally.Gold}   🥈 ${tally.Silver}   🥉 ${tally.Bronze}${total ? `   (${total} medal${total > 1 ? 's' : ''})` : ''}`,
      '',
      ...per.map(({ a, r }) => `${shortName(a.name).toUpperCase()} — ${r.map((x) => `${x.ev} ${x.txt}`).join(' · ')}`),
      '',
      'So proud of every athlete today. Thank you, families! 🧡',
    ].join('\n');
    return { t, per, tally, text };
  };
  const render = async () => {
    await loadT(id);
    const { t, per, tally, text } = build();
    const body = `
      <div class="pad stack">
        <div class="tally">
          <div><span>🥇</span><strong>${tally.Gold}</strong><small>Gold</small></div>
          <div><span>🥈</span><strong>${tally.Silver}</strong><small>Silver</small></div>
          <div><span>🥉</span><strong>${tally.Bronze}</strong><small>Bronze</small></div>
        </div>
        ${per.length ? per.map(({ a, r }) => `
          <div class="trow"><div><div class="t">${esc(a.name)}</div>
            ${r.map((x) => `<div class="small ${x.medal ? '' : 'muted'}">${esc(x.ev)}: ${esc(x.txt)}</div>`).join('')}</div></div>`).join('')
        : '<div class="empty">Results show up here as coaches enter them on Up Next.</div>'}
        <div class="rowx">
          <button class="btn dark" style="flex:1" data-act="postres">${UI.users}Post to group</button>
          <button class="btn ghost" style="flex:1" data-act="copyres">${UI.link}Copy text</button>
        </div>
        <details><summary class="small">Preview message</summary><pre class="preview">${esc(text)}</pre></details>
      </div>`;
    paint(t, 'results', body);
  };
  app.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !cache.t) return;
    const { text } = build();
    if (el.dataset.act === 'postres') return openMessage('group', null, text);
    if (el.dataset.act === 'copyres') {
      try { await navigator.clipboard.writeText(text); toast('Results copied'); } catch { toast('Copy not allowed — use Post to group'); }
    }
  };
  const rid = routeId;
  await render();
  startPoll(rid, render, POLL_MS);
}

// ---------- Setup ----------
function athleteForm(a) {
  return `
  <form class="editbox stack" data-edit-a="${a.id}">
    <div class="field"><label for="ea-n${a.id}">Athlete name</label><input id="ea-n${a.id}" name="name" value="${esc(a.name)}" required></div>
    <div class="field"><label for="ea-g${a.id}">Parent name</label><input id="ea-g${a.id}" name="guardian_name" value="${esc(a.guardian_name || '')}"></div>
    <div class="field"><label for="ea-p${a.id}">Parent phone(s)</label><input id="ea-p${a.id}" name="phone" type="tel" value="${esc(a.phone || '')}" placeholder="780-555-0101 (Mom), 587-555-0102 (Dad)">
      <span class="small muted">More than one? Separate with a comma. Add (Mom)/(Dad) to label them.</span></div>
    <div class="field"><label for="ea-c${a.id}">Send messages by</label><select id="ea-c${a.id}" name="channel">
      <option value="whatsapp" ${a.channel !== 'sms' ? 'selected' : ''}>WhatsApp</option><option value="sms" ${a.channel === 'sms' ? 'selected' : ''}>Text (SMS)</option></select></div>
    <div class="rowx"><button class="btn dark" style="flex:1" type="submit">${UI.save}Save</button><button class="btn ghost" type="button" data-act="cancel">Cancel</button></div>
  </form>`;
}
function matchForm(m, t) {
  return `
  <form class="editbox stack" data-edit-m="${m.id}">
    <div class="grid2">
      <div class="field"><label for="em-e${m.id}">Event</label><select id="em-e${m.id}" name="event">${['Sparring', 'Poomsae'].map((e) => `<option ${m.event === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
      <div class="field"><label for="em-r${m.id}">Round</label><select id="em-r${m.id}" name="round"><option value="">—</option>${ROUNDS.map((r) => `<option ${m.round === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="field"><label for="em-c${m.id}">Court</label><select id="em-c${m.id}" name="court">${Array.from({ length: t.courts }, (_, i) => i + 1).map((c) => `<option ${m.court === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label for="em-n${m.id}">Match #</label><input id="em-n${m.id}" name="match_no" type="number" min="1" inputmode="numeric" value="${m.match_no}" required></div>
      <div class="field"><label for="em-k${m.id}">Corner</label><select id="em-k${m.id}" name="corner"><option value="">—</option><option value="Blue" ${m.corner === 'Blue' ? 'selected' : ''}>Chung · Blue</option><option value="Red" ${m.corner === 'Red' ? 'selected' : ''}>Hong · Red</option></select></div>
      <div class="field"><label for="em-x${m.id}">Result</label><select id="em-x${m.id}" name="result">${['', 'Win', 'Loss', 'Gold', 'Silver', 'Bronze', 'Done'].map((r) => `<option value="${r}" ${(m.result || '') === r ? 'selected' : ''}>${r || '—'}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="em-d${m.id}">Division</label><input id="em-d${m.id}" name="division" value="${esc(m.division || '')}"></div>
    <div class="rowx"><button class="btn dark" style="flex:1" type="submit">${UI.save}Save match</button><button class="btn ghost" type="button" data-act="cancel">Cancel</button></div>
  </form>`;
}
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
          <div class="grid2">
            <div class="field"><label for="sk">Coaches today</label><input id="sk" type="number" min="1" max="12" value="${t.coaches}" inputmode="numeric"></div>
            <div class="field"><label for="sa">Arrive by</label><input id="sa" value="${esc(t.arrival || '')}" placeholder="e.g. 8:00 AM"></div>
          </div>
          <div class="field"><label for="sw">Black belt weigh-in time</label><input id="sw" value="${esc(t.weighin_time || '')}" placeholder="e.g. 7:45 AM (leave empty if none)"></div>
          <div class="field"><label for="sv">Venue / address</label><input id="sv" value="${esc(t.venue || '')}" placeholder="e.g. Repsol Sport Centre, 2225 Macleod Trail SE"></div>
          <div class="field"><label for="so">Message sign-off</label><input id="so" value="${esc(t.signoff)}"></div>
          <div class="rowx"><button class="btn dark" style="flex:1" type="submit">${UI.save}Save settings</button>
          <button class="btn danger" type="button" data-act="deltour">${UI.trash}Delete</button></div>
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
          <div class="field"><label for="ap">Parent phone(s)</label><input id="ap" type="tel" inputmode="tel" placeholder="comma between numbers"></div>
        </div>
        <div class="field"><label for="ac">Send messages by</label>
          <select id="ac"><option value="whatsapp">WhatsApp</option><option value="sms">Text (SMS)</option></select></div>
        <button class="btn dark block" type="submit">${UI.useradd}Add athlete</button>
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
        <button class="btn dark block" type="submit">${UI.plus}Save &amp; add next</button>
      </form>` : ''}

      ${athletes.length ? `
      <div class="section stack">
        <h2>Day-before info</h2>
        <div class="small muted">Sends each family the venue, arrival time, their child's matches, gear list and live link.${!t.venue || !t.arrival ? ' <strong style="color:var(--red-ink)">Add venue and arrival time in Tournament settings first.</strong>' : ''}</div>
        <button class="btn ${t.group_schedule_sent_at ? 'ghost' : 'dark'} block" data-act="groupsched">${t.group_schedule_sent_at ? UI.check + 'Schedule posted ' + ago(t.group_schedule_sent_at) + ' · post again' : UI.users + 'Post full schedule to group'}</button>
        <div class="small muted">${athletes.filter((x) => x.dayinfo_sent_at).length} of ${athletes.length} families messaged individually (button on each athlete below).</div>
      </div>` : ''}

      <div class="section stack">
        <h2>Athletes &amp; matches</h2>
        ${athletes.length ? athletes.map((a) => {
          const ms = matches.filter((m) => m.athlete_id === a.id);
          return `
          <div class="ath">
            <div class="rowx" style="justify-content:space-between;align-items:flex-start">
              <div><div class="t" style="font-weight:700">${esc(a.name)}${a.belt ? ` <span class="small muted" style="font-weight:400">· ${esc(a.belt)}</span>` : ''}</div>
                <div class="small muted">${esc(a.guardian_name || 'No parent name')} · ${a.channel === 'sms' ? 'Text' : 'WhatsApp'}</div>
                <div class="phones">${(() => { const ph = parsePhones(a.phone); return ph.length ? ph.map((p) => `<span class="phone-chip">${p.label ? esc(p.label) + ' · ' : ''}${p.display}</span>`).join('') : `<span class="small" style="color:var(--red-ink)">${a.phone ? 'Phone not recognised: ' + esc(a.phone) : 'No phone'}</span>`; })()}</div></div>
              <button class="linkbtn" data-act="edita" data-a="${a.id}">${ICON.edit}Edit</button>
            </div>
            ${ui.editAth === a.id ? athleteForm(a) : ''}
            ${ms.sort((x, y) => x.match_no - y.match_no).map((m) => ui.editMatch === m.id ? matchForm(m, t) : `<div class="mrow"><span>${esc(evLabel(m))}${m.division ? ' · ' + esc(m.division) : ''} ${cornerChip(m.corner)}${m.result ? ' · <strong>' + esc(m.result) + '</strong>' : ''}</span>
              <span class="rowx"><strong>C${m.court} · #${m.match_no}</strong><button class="linkbtn" data-act="editm" data-m="${m.id}" aria-label="Edit match ${m.match_no}">${ICON.edit}</button><button class="linkbtn red" data-act="delm" data-m="${m.id}" aria-label="Delete match ${m.match_no}">${UI.trash}</button></span></div>`).join('') || '<div class="small muted">No matches yet</div>'}
            ${isBlackBelt(a) ? `<button class="weigh ${a.weigh_in_at ? 'ok' : 'need'}" data-act="weigh" data-a="${a.id}">${a.weigh_in_at ? '⚖ Weigh-in passed ✓ (tap to undo)' : '⚖ Weigh-in not done — tap when passed'}</button>` : ''}
            <button class="btn ${a.dayinfo_sent_at ? 'ghost' : ''} block" style="height:40px" data-act="dayinfo" data-a="${a.id}">${a.dayinfo_sent_at ? UI.check + 'Day-before info sent ' + ago(a.dayinfo_sent_at) : UI.chat + 'Send day-before info to parent'}</button>
            <div class="rowx" style="flex-wrap:wrap">
              <button class="linkbtn" data-act="copylink" data-a="${a.id}">${UI.link}Copy parent link</button>
              <button class="linkbtn red" data-act="dela" data-a="${a.id}">${UI.trash}Remove athlete</button>
            </div>
          </div>`;
        }).join('') : '<div class="small muted">No athletes yet.</div>'}
      </div>`;
    paint(t, 'setup', body);

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
        coaches: Math.min(12, Math.max(1, parseInt(app.querySelector('#sk').value, 10) || 3)),
        arrival: app.querySelector('#sa').value.trim() || null,
        venue: app.querySelector('#sv').value.trim() || null,
        weighin_time: app.querySelector('#sw').value.trim() || null,
      }).eq('id', id));
      toast('Settings saved'); render();
    };
    app.querySelector('#addath').onsubmit = async (e) => {
      e.preventDefault();
      const name = an.value.trim();
      const s = roster.find((r) => r.name.toLowerCase() === name.toLowerCase());
      await must(sb.from('t_athletes').insert({
        tournament_id: id, student_id: s?.id || null, name: s?.name || name, belt: s?.belt || null,
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
  app.onsubmit = async (e) => {
    const fa = e.target.closest('form[data-edit-a]');
    const fm = e.target.closest('form[data-edit-m]');
    if (!fa && !fm) return;
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fa) {
      const phone = String(fd.get('phone') || '').trim();
      if (phone && !parsePhones(phone).length) return toast('Phone number not recognised — use 10 digits, e.g. 780-555-0101');
      await must(sb.from('t_athletes').update({
        name: String(fd.get('name')).trim(),
        guardian_name: String(fd.get('guardian_name') || '').trim() || null,
        phone: phone || null,
        channel: fd.get('channel'),
      }).eq('id', fa.dataset.editA));
      ui.editAth = null; toast('Athlete saved');
    } else {
      const rec = {
        event: fd.get('event'), round: fd.get('round') || null, corner: fd.get('corner') || null,
        court: parseInt(fd.get('court'), 10), match_no: parseInt(fd.get('match_no'), 10),
        result: fd.get('result') || null, division: String(fd.get('division') || '').trim() || null,
      };
      const clash = cache.matches.find((m) => m.id !== fm.dataset.editM && m.court === rec.court && m.match_no === rec.match_no);
      if (clash && !confirm(`Court ${rec.court} #${rec.match_no} is already used by ${cache.byId[clash.athlete_id]?.name}. Save anyway?`)) return;
      await must(sb.from('t_matches').update(rec).eq('id', fm.dataset.editM));
      ui.editMatch = null; toast(`Saved C${rec.court} · #${rec.match_no}`);
    }
    render();
  };
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
    if (act === 'weigh') {
      a.weigh_in_at = a.weigh_in_at ? null : new Date().toISOString();
      await must(sb.from('t_athletes').update({ weigh_in_at: a.weigh_in_at }).eq('id', a.id));
      toast(a.weigh_in_at ? `${first(a.name)} passed weigh-in` : 'Weigh-in undone');
      return render();
    }
    if (act === 'dayinfo') {
      const ms = cache.matches.filter((m) => m.athlete_id === a.id);
      return pickNumber(a, `Send day-before info to ${first(a.name)}'s parent`, (num) => {
        openMessage(a.channel, num.num, dayBeforeMessage(cache.t, a, ms));
        sb.from('t_athletes').update({ dayinfo_sent_at: new Date().toISOString() }).eq('id', a.id).then(() => render());
      });
    }
    if (act === 'groupsched') {
      openMessage('group', null, groupScheduleMessage(cache.t, cache.athletes, cache.matches));
      sb.from('t_tournaments').update({ group_schedule_sent_at: new Date().toISOString() }).eq('id', id).then(() => render());
      return;
    }
    if (act === 'channel') { await must(sb.from('t_athletes').update({ channel: a.channel === 'sms' ? 'whatsapp' : 'sms' }).eq('id', a.id)); return render(); }
    if (act === 'edita') { ui.editAth = ui.editAth === a.id ? null : a.id; ui.editMatch = null; return render(); }
    if (act === 'editm') { ui.editMatch = el.dataset.m; ui.editAth = null; return render(); }
    if (act === 'cancel') { ui.editAth = null; ui.editMatch = null; return render(); }
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
    let res;
    try { res = await sb.rpc('t_parent_view', { p_token: token }); } catch (err) { setNet(false); return; }
    const { data, error } = res;
    if (error && isNetErr(error)) { setNet(false); return; }
    setNet(true);
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
    paintPage(`
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
      <p class="small muted" style="text-align:center;padding:0 20px 24px">Updated by your coaches · refreshes automatically<br>– ${esc(data.signoff)}</p>`);
  };
  const rid = routeId;
  await render();
  startPoll(rid, render, 10000);
}

// ---------- tap feedback ----------
// iOS Safari only shows :active styles when a touchstart listener exists
document.addEventListener('touchstart', () => {}, { passive: true });
app.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.btn, .chip-btn, .corner-btn, .linkbtn, .weigh, nav.bottom a');
  if (!b) return;
  b.classList.remove('tap'); void b.offsetWidth; b.classList.add('tap');
  b.addEventListener('animationend', () => b.classList.remove('tap'), { once: true });
}, { passive: true });
// if a button is still waiting on the server after a moment, show a small spinner on it
app.addEventListener('click', (e) => {
  const b = e.target.closest('button.btn, button.weigh');
  if (!b || b.type === 'submit') return;
  setTimeout(() => { if (b.isConnected) { b.classList.add('busy'); setTimeout(() => b.classList.remove('busy'), 4000); } }, 350);
});
app.addEventListener('submit', (e) => {
  const b = e.target.querySelector('[type=submit]');
  if (b) setTimeout(() => { if (b.isConnected && b.disabled) b.classList.add('busy'); }, 350);
});

// ---------- block double taps on any form button ----------
app.addEventListener('submit', (e) => {
  const b = e.target.querySelector('[type=submit]');
  if (!b) return;
  if (b.dataset.busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  b.dataset.busy = '1';
  b.disabled = true;
  setTimeout(() => { b.disabled = false; delete b.dataset.busy; b.classList.remove('busy'); }, 2500);
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
