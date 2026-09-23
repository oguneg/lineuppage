// Lineup Story Maker — draws the chosen show's lineup onto the club's story template.
// Lineup data comes from data/lineup.json (built by the GitHub Action, or live by the
// local dev server). Instagram handles live in handles.json in the repo.

const CLUBS = {
  bigben: { template: 'templates/bigben.png', label: 'bigben' },
  comedynation: { template: 'templates/comedynation.png', label: 'comedynation' },
};

const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const WEEKDAYS = ['Söndag', 'Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag'];

const W = 1080, H = 1920;
const COLORS = {
  red: '#d24a43',     // performer photo ring
  role: '#f08a7e',    // performer role label
  host: '#f2c14e',    // konferencier ring + role label
  date: '#f2c14e',
  text: '#f6f1e7',
  muted: '#b3ada3',
};
const FONT = 'Poppins, system-ui, sans-serif';
const isHost = p => /konferencier|\bhost\b|\bmc\b/i.test(p.role);

const $ = s => document.querySelector(s);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) || /^192\.168\.|^10\./.test(location.hostname);

const state = {
  club: lsGet('club') || 'bigben',
  events: {},       // club -> [event]
  fetchedAt: null,
  eventIndex: 0,
  handles: {},
  dirty: JSON.parse(lsGet('pendingHandles') || '{}'), // slug -> { name, instagram }, survives reloads until saved
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function todayStockholm() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function normalizeHandle(v) {
  return String(v || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/?#].*$/, '');
}

// ---------- GitHub storage ----------

const github = {
  get repo() {
    const saved = lsGet('ghRepo');
    if (saved) return saved;
    if (location.hostname.endsWith('.github.io')) {
      const owner = location.hostname.split('.')[0];
      const seg = location.pathname.split('/')[1];
      return `${owner}/${seg || location.hostname}`;
    }
    return '';
  },
  get token() { return lsGet('ghToken') || ''; },
  path: 'public/handles.json',

  async api(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || r.statusText}`);
    return r.status === 204 ? null : r.json();
  },

  async readHandles() {
    const f = await this.api(`/contents/${this.path}?ref=main`);
    const bytes = Uint8Array.from(atob(f.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    return { sha: f.sha, handles: JSON.parse(new TextDecoder().decode(bytes)) };
  },

  async writeHandles(handles, sha, message) {
    const bytes = new TextEncoder().encode(JSON.stringify(handles, null, 2) + '\n');
    const content = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
    return this.api(`/contents/${this.path}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content, sha, branch: 'main' }),
    });
  },

  dispatchRefresh() {
    return this.api('/actions/workflows/lineup.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  },
};

const canSync = () => !IS_LOCAL && github.repo && github.token;

function sortHandles(h) {
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
}

function applyEdits(handles, edits) {
  const out = { ...handles };
  for (const [slug, v] of Object.entries(edits)) {
    if (v.instagram) out[slug] = { name: v.name, instagram: v.instagram };
    else delete out[slug];
  }
  return sortHandles(out);
}

async function loadHandles() {
  if (canSync()) {
    try { return (await github.readHandles()).handles; } catch (e) { setStatus(e.message, true); }
  }
  const r = await fetch(`handles.json?ts=${Date.now()}`, { cache: 'no-store' });
  return r.ok ? r.json() : {};
}

async function saveHandles() {
  const edits = state.dirty;
  const names = Object.values(edits).map(v => v.name).join(', ');
  if (IS_LOCAL) {
    const merged = applyEdits(await loadHandles(), edits);
    const r = await fetch('/api/handles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
    if (!r.ok) throw new Error(await r.text());
    return merged;
  }
  if (!canSync()) throw new Error('Add your GitHub token under "GitHub sync" to save handles.');
  // Re-read right before writing so edits from another device aren't overwritten; retry once on a race.
  for (let attempt = 0; ; attempt++) {
    const { sha, handles } = await github.readHandles();
    const merged = applyEdits(handles, edits);
    try {
      await github.writeHandles(merged, sha, `Instagram handles: ${names}`);
      return merged;
    } catch (e) {
      if (attempt || !/409|422/.test(e.message)) throw e;
    }
  }
}

// ---------- Lineup data ----------

async function loadLineup(fresh = false) {
  const r = await fetch(`data/lineup.json?ts=${Date.now()}${fresh && IS_LOCAL ? '&fresh=1' : ''}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  state.events = data.clubs;
  state.fetchedAt = data.fetchedAt;
}

function fetchedLabel() {
  if (!state.fetchedAt) return '';
  const mins = Math.round((Date.now() - new Date(state.fetchedAt)) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `Lineup fetched ${ago}.`;
}

function defaultEventIndex(events) {
  const today = todayStockholm();
  const isWorkshop = e => /workshop/i.test(e.title);
  let i = events.findIndex(e => e.date === today && !isWorkshop(e) && e.performers.length);
  if (i < 0) i = events.findIndex(e => e.date >= today && !isWorkshop(e));
  return Math.max(0, i);
}

// ---------- UI ----------

function fmtDate(iso, long = false) {
  const d = new Date(iso + 'T12:00:00');
  const wd = WEEKDAYS[d.getDay()];
  const m = MONTHS[d.getMonth()];
  return long ? `${wd} ${d.getDate()} ${m}` : `${wd.slice(0, 3)} ${d.getDate()} ${m.slice(0, 3)}`;
}

function renderClubTabs() {
  document.querySelectorAll('#clubs button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.club === state.club)));
}

function renderEventSelect(keepSelection = false) {
  const events = state.events[state.club] || [];
  const today = todayStockholm();
  const prev = keepSelection ? currentEvent() : null;
  $('#event').innerHTML = events.map((e, i) => {
    const tag = e.date === today ? 'IDAG · ' : '';
    const label = `${tag}${e.date ? fmtDate(e.date) : '?'} · ${e.time.split(' ')[0]} · ${e.title} (${e.performers.length})`;
    return `<option value="${i}">${escapeHtml(label)}</option>`;
  }).join('');
  const kept = prev ? events.findIndex(e => e.date === prev.date && e.title === prev.title && e.time === prev.time) : -1;
  state.eventIndex = kept >= 0 ? kept : defaultEventIndex(events);
  $('#event').value = String(state.eventIndex);
}

function currentEvent() { return (state.events[state.club] || [])[state.eventIndex]; }

function handleFor(p) {
  if (!p.slug) return '';
  if (state.dirty[p.slug]) return state.dirty[p.slug].instagram;
  return state.handles[p.slug]?.instagram || '';
}

function uniquePeople(ev) {
  const seen = new Set();
  return (ev?.performers || []).filter(p => {
    const key = p.slug || p.name;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function renderInstagram() {
  const people = uniquePeople(currentEvent());
  $('#igList').innerHTML = people.map(p => {
    if (!p.slug) return `<li class="nolink"><div class="who">${escapeHtml(p.name)}<small>${escapeHtml(p.role)} · no profile</small></div></li>`;
    const h = handleFor(p);
    return `<li class="${h ? '' : 'missing'}">
      <div class="who">${escapeHtml(p.name)}<small>${escapeHtml(p.role)}</small></div>
      <div class="at"><input type="text" data-slug="${p.slug}" data-name="${escapeHtml(p.name)}" value="${escapeHtml(h)}" placeholder="handle" autocomplete="off" spellcheck="false"></div>
    </li>`;
  }).join('');
  updateIgString();
  renderSaveButton();
}

function updateIgString() {
  const handles = [...new Set(uniquePeople(currentEvent()).map(handleFor).filter(Boolean))];
  $('#igString').textContent = handles.map(h => '@' + h).join(' ');
}

function renderSaveButton() {
  const n = Object.keys(state.dirty).length;
  $('#save').disabled = !n;
  $('#save').textContent = n ? `Save ${n} handle${n > 1 ? 's' : ''}` : 'All handles saved';
}

function renderSync() {
  $('#sync').hidden = IS_LOCAL;
  $('#ghRepo').value = github.repo;
  $('#ghToken').value = github.token;
  $('#syncState').textContent = canSync() ? '✓ connected' : 'not connected';
}

// ---------- Canvas ----------

const imageCache = new Map();
function loadImage(src, cors = false) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise(resolve => {
      const img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return imageCache.get(src);
}
// wsrv.nl serves with CORS headers (keeps the canvas exportable) and crops square around faces
const photoUrl = url => `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=320&h=320&fit=cover&a=attention&output=jpg&q=85`;

function fitFont(text, maxW, size, weight, min = 20) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function ellipsize(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text.trimEnd() + '…';
}

function wrapLines(text, maxW, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = words[i];
      if (lines.length === maxLines) { line = ''; lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + ' ' + words.slice(i).join(' '), maxW); break; }
    } else line = test;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function drawAvatar(img, cx, cy, r, ring) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#222';
  ctx.fill();
  ctx.clip();
  if (img) {
    const scale = Math.max((2 * r) / img.width, (2 * r) / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - r - Math.max(0, (h - 2 * r) * 0.3), w, h);
  }
  ctx.restore();
}

let drawToken = 0;
async function draw() {
  const token = ++drawToken;
  const ev = currentEvent();
  const cfg = CLUBS[state.club];
  const showDate = $('#optDate').checked;
  const showBio = $('#optBio').checked;

  await Promise.all(['800 40px Poppins', '700 40px Poppins', '600 40px Poppins', 'italic 400 20px Poppins'].map(f => document.fonts.load(f)));
  const [bg, ...photos] = await Promise.all([
    loadImage(cfg.template),
    ...(ev?.performers || []).map(p => p.img ? loadImage(photoUrl(p.img), true) : null),
  ]);
  if (token !== drawToken) return; // a newer draw started meanwhile

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);
  if (bg) ctx.drawImage(bg, 0, 0, W, H);
  if (!ev) return;

  let top = H * 0.245;
  const bottom = H * 0.905;

  if (showDate && ev.date) {
    const label = `${fmtDate(ev.date, true)}  ·  ${ev.time.split(' ')[0]}`.toUpperCase();
    ctx.font = `600 38px ${FONT}`;
    ctx.letterSpacing = '4px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const y = top + 30;
    ctx.fillStyle = COLORS.date;
    ctx.fillText(label, W / 2, y);
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(W / 2 - tw / 2 - 90, y - 2, 60, 4);
    ctx.fillRect(W / 2 + tw / 2 + 30, y - 2, 60, 4);
    ctx.letterSpacing = '0px';
    top += 90;
  } else {
    top += 20;
  }

  const n = ev.performers.length;
  if (!n) {
    ctx.font = `600 44px ${FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = 'center';
    ctx.fillText('Lineup kommer snart', W / 2, (top + bottom) / 2);
    return;
  }

  const cols = n > 9 ? 2 : 1;
  const rows = Math.ceil(n / cols);
  const areaH = bottom - top;
  const rowH = Math.min(cols === 1 ? 210 : 230, areaH / rows);
  const startY = top + (areaH - rowH * rows) / 2;

  const sideMargin = cols === 1 ? 110 : 55;
  const gap = 40;
  const colW = (W - 2 * sideMargin - (cols - 1) * gap) / cols;
  const r = Math.min(rowH * 0.38, cols === 1 ? 74 : 60);
  const nameSize = Math.round(Math.min(cols === 1 ? 54 : 40, rowH * (showBio ? 0.28 : 0.34)));
  const roleSize = Math.round(Math.max(17, nameSize * 0.46));
  const bioSize = Math.round(Math.max(16, nameSize * 0.42));

  // Single column: center the block on its widest line instead of hugging the left edge
  let offsetX = 0;
  if (cols === 1) {
    const textMax = colW - (2 * r + 44);
    let widest = 0;
    ev.performers.forEach(p => {
      fitFont(p.name, textMax, nameSize, 800, Math.round(nameSize * 0.6));
      widest = Math.max(widest, ctx.measureText(p.name).width);
      if (showBio && p.bio) widest = textMax;
    });
    offsetX = (colW - (2 * r + 44 + Math.min(widest, textMax))) / 2;
  }

  ev.performers.forEach((p, i) => {
    // column-major, matching the reading order on the website
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = sideMargin + offsetX + col * (colW + gap);
    const cy = startY + row * rowH + rowH / 2;
    const host = isHost(p);

    drawAvatar(photos[i], x + r + 5, cy, r, host ? COLORS.host : COLORS.red);

    const tx = x + 2 * r + 34;
    const tw = colW - offsetX - (tx - x);
    const bioLines = showBio && p.bio ? (ctx.font = `italic 400 ${bioSize}px ${FONT}`, wrapLines(p.bio, tw, 2)) : [];

    const blockH = roleSize * 1.3 + nameSize * 1.15 + bioLines.length * bioSize * 1.35 + (bioLines.length ? 6 : 0);
    let y = cy - blockH / 2;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.font = `700 ${roleSize}px ${FONT}`;
    ctx.letterSpacing = '3px';
    ctx.fillStyle = host ? COLORS.host : COLORS.role;
    ctx.fillText(ellipsize(p.role.toUpperCase(), tw), tx, y);
    ctx.letterSpacing = '0px';
    y += roleSize * 1.3;

    fitFont(p.name, tw, nameSize, 800, Math.round(nameSize * 0.6));
    ctx.fillStyle = COLORS.text;
    ctx.fillText(ellipsize(p.name, tw), tx, y);
    y += nameSize * 1.15 + (bioLines.length ? 6 : 0);

    if (bioLines.length) {
      ctx.font = `italic 400 ${bioSize}px ${FONT}`;
      ctx.fillStyle = COLORS.muted;
      bioLines.forEach(line => { ctx.fillText(line, tx, y); y += bioSize * 1.35; });
    }
  });
}

// ---------- Actions ----------

function fileName() {
  const ev = currentEvent();
  return `${CLUBS[state.club].label}-${ev?.date || 'lineup'}.png`;
}

function canvasBlob() { return new Promise(res => canvas.toBlob(res, 'image/png')); }

$('#download').addEventListener('click', async () => {
  const blob = await canvasBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })) {
  $('#share').hidden = false;
  $('#share').addEventListener('click', async () => {
    const file = new File([await canvasBlob()], fileName(), { type: 'image/png' });
    try { await navigator.share({ files: [file] }); } catch {}
  });
}

$('#copy').addEventListener('click', async () => {
  const text = $('#igString').textContent;
  try { await navigator.clipboard.writeText(text); } catch {
    const r = document.createRange(); r.selectNodeContents($('#igString'));
    getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy');
  }
  $('#copy').textContent = 'Copied!';
  setTimeout(() => ($('#copy').textContent = 'Copy'), 1200);
});

$('#igList').addEventListener('input', e => {
  const input = e.target.closest('input[data-slug]');
  if (!input) return;
  const ig = normalizeHandle(input.value);
  const saved = state.handles[input.dataset.slug]?.instagram || '';
  if (ig === saved) delete state.dirty[input.dataset.slug];
  else state.dirty[input.dataset.slug] = { name: input.dataset.name, instagram: ig };
  lsSet('pendingHandles', JSON.stringify(state.dirty));
  input.closest('li').classList.toggle('missing', !ig);
  renderSaveButton();
  updateIgString();
});

$('#save').addEventListener('click', async () => {
  $('#save').disabled = true;
  $('#save').textContent = 'Saving…';
  try {
    state.handles = await saveHandles();
    state.dirty = {};
    lsSet('pendingHandles', null);
    setStatus(IS_LOCAL ? 'Handles saved to handles.json.' : 'Handles committed to GitHub.');
  } catch (e) {
    setStatus('Not saved (kept on this device): ' + e.message, true);
  }
  renderInstagram();
});

$('#clubs').addEventListener('click', e => {
  const b = e.target.closest('button[data-club]');
  if (!b || b.dataset.club === state.club) return;
  state.club = b.dataset.club;
  lsSet('club', state.club);
  renderClubTabs();
  renderEventSelect();
  renderInstagram();
  draw();
});

$('#event').addEventListener('change', e => {
  state.eventIndex = Number(e.target.value);
  renderInstagram();
  draw();
});

['#optDate', '#optBio'].forEach(id => $(id).addEventListener('change', draw));

$('#syncSave').addEventListener('click', async () => {
  lsSet('ghRepo', $('#ghRepo').value.trim() || null);
  lsSet('ghToken', $('#ghToken').value.trim() || null);
  renderSync();
  if (canSync()) {
    try {
      state.handles = await loadHandles();
      setStatus('Connected to GitHub.');
      renderInstagram();
    } catch (e) { setStatus(e.message, true); }
  }
});

$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.disabled = true;
  try {
    if (canSync()) {
      // Ask the Action to re-scrape and redeploy, then wait for the new lineup.json to go live
      const before = state.fetchedAt;
      await github.dispatchRefresh();
      const started = Date.now();
      while (Date.now() - started < 5 * 60000) {
        setStatus(`Re-fetching from standupsverige.se… (${Math.round((Date.now() - started) / 1000)}s, usually ~1 min)`);
        await new Promise(r => setTimeout(r, 8000));
        await loadLineup();
        if (state.fetchedAt !== before) break;
      }
    } else {
      setStatus('Reloading lineup…');
      await loadLineup(true);
    }
    state.handles = await loadHandles();
    setStatus(fetchedLabel());
    renderEventSelect(true);
    renderInstagram();
    draw();
  } catch (e) {
    setStatus('Refresh failed: ' + e.message, true);
  }
  btn.disabled = false;
});

async function init() {
  renderSync();
  try {
    const [, handles] = await Promise.all([loadLineup(), loadHandles()]);
    state.handles = handles;
    setStatus(fetchedLabel());
  } catch (e) {
    setStatus('Could not load lineup: ' + e.message, true);
  }
  renderClubTabs();
  renderEventSelect();
  renderInstagram();
  draw();
}

init();
