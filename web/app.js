import { Orb } from './orb.js';

const TZ = 'Europe/Ljubljana';
const VAULT = 'lan_brain';
const $ = (id) => document.getElementById(id);

const THEMES = {
  blue: { bg: '#030615', a: '#2a56ff', b: '#3fc4ff', c: '#c08cff' },
  ember: { bg: '#000000', a: '#ff6418', b: '#ffa040', c: '#ffd9a8' },
};

const orb = new Orb($('orb-canvas'), $('orb-anchor'));

// ---------- theme ----------
function setTheme(name) {
  if (!THEMES[name]) name = 'ember';
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('brain.theme', name); } catch (e) {}
  orb.setTheme(THEMES[name]);
}
setTheme(document.documentElement.dataset.theme);
document.querySelectorAll('[data-set-theme]').forEach((b) =>
  b.addEventListener('click', () => setTheme(b.dataset.setTheme)));

// ---------- clock + greeting ----------
function nowParts() {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [h, m] = f.format(new Date()).split(':').map(Number);
  return { h, m, mins: h * 60 + m };
}
function tickClock() {
  const { h } = nowParts();
  $('clock').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date());
  $('date-line').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  $('greeting').textContent =
    h < 5 ? 'Still up, Lan' : h < 12 ? 'Good morning, Lan' : h < 18 ? 'Good afternoon, Lan' : 'Good evening, Lan';
}
tickClock();
setInterval(tickClock, 10_000);

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const obsidianUrl = (file) => `obsidian://open?vault=${encodeURIComponent(VAULT)}&file=${encodeURIComponent(file)}`;

// Inline Markdown -> HTML for the bits of vault text we show.
function inline(md) {
  let s = esc(md);
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, f, t) => `<a href="${obsidianUrl(f)}">${t}</a>`);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, f) => `<a href="${obsidianUrl(f)}">${f.split('/').pop()}</a>`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}
// Strip Markdown to plain text (task lines).
function plain(md) {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_, f) => f.split('/').pop())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|\s)\*([^*]+)\*/g, '$1$2');
}
// Block Markdown: paragraphs and bullet lists.
function blocks(md) {
  const out = []; let list = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const li = line.match(/^[-*] (.*)/);
    if (li) { (list ||= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// ---------- tasks ----------
const PER_GROUP = 5;
async function loadTasks() {
  try {
    const { groups, total, today } = await getJSON('/api/tasks');
    $('task-meta').textContent = total ? `${total} open` : '';
    if (!groups.length) { $('tasks').innerHTML = '<p class="empty">Nothing open. Nice.</p>'; return; }
    $('tasks').innerHTML = groups.map((g) => {
      const rows = g.tasks.map((t, i) => {
        const date = t.date ? `<span class="date ${t.date === today ? 'today' : ''}">${t.date === today ? 'today' : fmtDate(t.date)}</span>` : '';
        return `<div class="task ${t.indent ? 'sub' : ''}" ${i >= PER_GROUP ? 'hidden' : ''}
            data-file="${esc(g.file)}" data-line="${t.line}" data-text="${esc(t.text)}">
          <button class="box" aria-label="Tick off"></button>
          <a class="txt" href="${obsidianUrl(g.file)}" title="${esc(plain(t.text))}">${esc(plain(t.text))}</a>${date}</div>`;
      }).join('');
      const more = g.tasks.length > PER_GROUP ? `<div class="more" data-more>+ ${g.tasks.length - PER_GROUP} more</div>` : '';
      return `<div class="task-group"><a class="group-head" href="${obsidianUrl(g.file)}">${esc(g.title)}<span>${g.tasks.length}</span></a>${rows}${more}</div>`;
    }).join('');
  } catch (e) {
    $('tasks').innerHTML = `<p class="error">Couldn't read the vault: ${esc(e.message)}</p>`;
  }
}
// Tick a task off: writes [x] into the note. It fades out after a moment;
// clicking again before then reopens it.
async function setDone(row, done) {
  const { file, line, text } = row.dataset;
  const r = await fetch('/api/task', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, line: +line, text, done }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
}
$('tasks').addEventListener('click', async (e) => {
  const box = e.target.closest('.task .box');
  if (box) {
    const row = box.parentElement;
    const done = !row.classList.contains('done');
    row.classList.toggle('done', done);
    clearTimeout(row._fade);
    try {
      await setDone(row, done);
    } catch (err) {
      row.classList.toggle('done', !done);
      row.title = err.message;
      return;
    }
    if (done) row._fade = setTimeout(() => {
      row.classList.add('gone');
      setTimeout(() => {
        const group = row.parentElement;
        row.remove();
        const left = group.querySelectorAll('.task').length;
        if (!left) group.remove(); else group.querySelector('.group-head span').textContent = left;
        const total = $('tasks').querySelectorAll('.task').length;
        $('task-meta').textContent = total ? `${total} open` : '';
      }, 400);
    }, 2200);
    return;
  }
  const m = e.target.closest('[data-more]');
  if (!m) return;
  m.parentElement.querySelectorAll('.task[hidden]').forEach((t) => (t.hidden = false));
  m.remove();
});
function fmtDate(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------- digest ----------
async function loadDigest() {
  try {
    const d = await getJSON('/api/digest');
    if (!d.found) { $('digest').innerHTML = '<p class="empty">No digest yet.</p>'; $('digest-meta').textContent = ''; return; }
    $('digest-meta').innerHTML = d.is_today ? 'today' : `from <a href="${obsidianUrl(d.file)}">${fmtDate(d.date)}</a>`;
    let html = '';
    if (d.pick) {
      const p = d.pick;
      const thumb = p.video_id ? `<div class="thumb"><img src="https://i.ytimg.com/vi/${esc(p.video_id)}/hqdefault.jpg" alt="" loading="lazy"></div>` : '';
      html += `<div class="pick">
        <a href="${esc(p.url)}" target="_blank" rel="noopener">${thumb}
          <div class="label">${esc(p.label || "Today's pick")}</div>
          <div class="ptitle">${esc(p.title)}</div></a>
        ${p.meta ? `<div class="pmeta">${esc(p.meta)}</div>` : ''}
        <div class="ptext">${inline(p.text)}</div></div>`;
    }
    if (d.rest) html += `<div class="digest-rest">${blocks(d.rest)}</div>`;
    $('digest').innerHTML = html || `<div class="digest-rest">${blocks(d.raw)}</div>`;
  } catch (e) {
    $('digest').innerHTML = `<p class="error">Couldn't read the digest: ${esc(e.message)}</p>`;
  }
}

// ---------- brief: calendar + inbox ----------
let briefTimer = null;
async function loadBrief() {
  let b;
  try { b = await getJSON('/api/brief'); } catch (e) {
    $('calendar').innerHTML = $('inbox').innerHTML = `<p class="error">${esc(e.message)}</p>`; return;
  }
  const busy = b.refreshing;
  $('refresh').classList.toggle('busy', busy);
  $('refresh-label').textContent = busy ? 'Refreshing…' : b.updated_at ? `Updated ${b.updated_at.slice(11, 16)}` : 'Refresh';
  clearTimeout(briefTimer);
  briefTimer = setTimeout(loadBrief, busy ? 4000 : 60_000);

  const stale = b.date && b.date !== b.today;
  renderCalendar(b, stale);
  renderInbox(b);
  if (b.error) {
    const note = `<p class="error">Last refresh failed: ${esc(b.error)}</p>`;
    $('calendar').insertAdjacentHTML('beforeend', note);
  }
}
function renderCalendar(b, stale) {
  const events = b.calendar?.events;
  if (!events || stale) {
    $('cal-meta').textContent = '';
    $('calendar').innerHTML = `<p class="empty">${b.refreshing ? 'Fetching today’s calendar…' : 'Press refresh to fetch today’s calendar.'}</p>`;
    return;
  }
  $('cal-meta').textContent = events.length ? `${events.length} event${events.length > 1 ? 's' : ''}` : '';
  if (!events.length) { $('calendar').innerHTML = '<p class="empty">Nothing scheduled. Open day.</p>'; return; }
  const now = nowParts().mins;
  const toMin = (t) => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null);
  $('calendar').innerHTML = `<ul class="events">${events.map((e) => {
    const s = toMin(e.start), en = toMin(e.end);
    const cls = e.all_day ? '' : en !== null && en <= now ? 'past' : s !== null && s <= now && (en === null || now < en) ? 'now' : '';
    const title = e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title);
    const loc = e.location && !/^https?:/.test(e.location) ? e.location : null;
    const sub = [e.all_day ? null : e.end ? `until ${e.end}` : null, loc].filter(Boolean).join(' · ');
    return `<li class="${cls}"><span class="t">${e.all_day ? 'all day' : esc(e.start)}</span>
      <div><div class="title">${title}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></li>`;
  }).join('')}</ul>`;
}
function renderInbox(b) {
  const inbox = b.inbox;
  if (!inbox) {
    $('inbox-meta').textContent = '';
    $('inbox').innerHTML = `<p class="empty">${b.refreshing ? 'Checking the inbox…' : 'Press refresh to check the inbox.'}</p>`;
    return;
  }
  $('inbox-meta').textContent = inbox.unread_estimate != null ? `~${inbox.unread_estimate} unread` : '';
  const threads = inbox.needs_you || [];
  $('inbox').innerHTML = `${inbox.summary ? `<p class="inbox-summary">${esc(inbox.summary)}</p>` : ''}
    ${threads.length ? `<ul class="threads">${threads.map((t) => `<li><a href="${esc(t.link)}" target="_blank" rel="noopener">
      <div class="row"><span class="from">${esc(t.from)}</span><span class="when">${esc(t.received || '')}</span></div>
      <div class="subj">${esc(t.subject)}</div>${t.why ? `<div class="why">${esc(t.why)}</div>` : ''}</a></li>`).join('')}</ul>` : ''}`;
}
$('refresh').addEventListener('click', async () => {
  try { await fetch('/api/refresh', { method: 'POST' }); } catch (e) {}
  loadTasks(); loadDigest(); loadBrief();
});

loadTasks(); loadDigest(); loadBrief();
setInterval(() => { loadTasks(); loadDigest(); }, 120_000);

// ---------- voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const state = $('state');
const transcript = $('transcript');
let listening = false, recog = null, heard = '', interimEl = null;
let micStream = null, audioCtx = null, levelRaf = null;
let thinkTimer = null;

function setState(text, active = false) {
  state.innerHTML = text;
  state.classList.toggle('active', active);
}
const IDLE = '';
setState(IDLE);
if (!SR) $('typed').hidden = false;

function addLine(cls, text) {
  const p = document.createElement('p');
  p.className = cls; p.textContent = text;
  transcript.append(p);
  while (transcript.children.length > 6) transcript.firstElementChild.remove();
  transcript.scrollTop = transcript.scrollHeight;
  return p;
}

async function startMicLevel() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(micStream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const step = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      orb.setLevel(Math.min(1, Math.max(0, (rms - 0.01) * 9)));
      levelRaf = requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    console.warn('mic level unavailable', e);
  }
}
function stopMicLevel() {
  cancelAnimationFrame(levelRaf);
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  orb.setLevel(0);
}

function startListening() {
  if (listening || !SR) return;
  window.speechSynthesis.cancel();
  orb.setSpeaking(false);
  listening = true; heard = '';
  $('talk').classList.add('on');
  setState('Listening…', true);
  interimEl = null;
  recog = new SR();
  recog.lang = 'en-US';
  recog.continuous = true;
  recog.interimResults = true;
  recog.onresult = (ev) => {
    let fin = '', interim = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
    }
    heard = (fin + interim).trim();
    if (!interimEl) interimEl = addLine('you interim', '');
    interimEl.textContent = heard;
  };
  recog.onerror = (ev) => {
    if (ev.error === 'not-allowed') setState('Microphone blocked. Allow it in the browser’s site settings.');
    else if (ev.error !== 'no-speech' && ev.error !== 'aborted') console.warn('speech error', ev.error);
  };
  recog.onend = () => {
    const text = heard.trim();
    if (interimEl) { interimEl.classList.remove('interim'); if (!text) interimEl.remove(); }
    recog = null;
    if (text) ask(text); else if (!listening) setState(IDLE);
  };
  recog.start();
  startMicLevel();
}
function stopListening() {
  if (!listening) return;
  listening = false;
  $('talk').classList.remove('on');
  stopMicLevel();
  setState('…');
  // give the recogniser a beat to deliver the last words
  setTimeout(() => recog?.stop(), 250);
}

async function ask(text) {
  if (!interimEl || interimEl.textContent !== text) addLine('you', text);
  interimEl = null;
  setState('Thinking…', true);
  thinkTimer = setInterval(() => orb.pulse(), 1100);
  orb.pulse();
  try {
    const r = await getJSON('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    clearInterval(thinkTimer);
    addLine('claude', r.reply);
    $('new-chat').hidden = false;
    speak(r.reply);
    // the turn may have edited a note or the calendar
    loadTasks(); loadBrief();
  } catch (e) {
    clearInterval(thinkTimer);
    addLine('claude', 'Sorry, that didn’t go through.');
    setState(IDLE);
    console.error(e);
  }
}

// Pick a British voice if the system has one ("Daniel" on macOS).
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis.getVoices();
  voice = vs.find((v) => /daniel/i.test(v.name) && /en[-_]GB/i.test(v.lang))
    || vs.find((v) => /en[-_]GB/i.test(v.lang) && v.localService)
    || vs.find((v) => /en[-_]GB/i.test(v.lang))
    || vs.find((v) => /^en/i.test(v.lang)) || null;
}
pickVoice();
window.speechSynthesis.onvoiceschanged = pickVoice;

function speak(text) {
  const clean = text.replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Chrome stops long utterances, so queue sentence-sized chunks.
  const chunks = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  window.speechSynthesis.cancel();
  setState('Speaking', true);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.trim());
    if (voice) u.voice = voice;
    u.rate = 1.03; u.pitch = 0.95;
    u.onstart = () => orb.setSpeaking(true);
    u.onboundary = () => orb.pulse();
    if (i === chunks.length - 1) u.onend = u.onerror = () => { orb.setSpeaking(false); if (!listening) setState(IDLE); };
    window.speechSynthesis.speak(u);
  });
}

// push-to-talk: button (press and hold) and spacebar
const talk = $('talk');
talk.addEventListener('pointerdown', (e) => { e.preventDefault(); talk.setPointerCapture(e.pointerId); startListening(); });
talk.addEventListener('pointerup', stopListening);
talk.addEventListener('pointercancel', stopListening);
const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => {
  if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) startListening(); }
  else if (e.key === '/' || e.code === 'Slash') { e.preventDefault(); $('typed').hidden = false; $('typed-input').focus(); }
  else if (e.key === 'Escape') { window.speechSynthesis.cancel(); orb.setSpeaking(false); setState(IDLE); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing()) { e.preventDefault(); stopListening(); } });
window.addEventListener('blur', stopListening);

$('typed').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('typed-input').value.trim();
  if (!v) return;
  $('typed-input').value = '';
  window.speechSynthesis.cancel();
  ask(v);
});
$('new-chat').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  transcript.innerHTML = '';
  $('new-chat').hidden = true;
  setState(IDLE);
});
