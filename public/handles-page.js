// Handles page: every comedian with their Instagram handle, editable, next to what
// Instagram shows for that handle (from profiles.json, filled in by the profile-check Action).

const $ = s => document.querySelector(s);
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const CLUB_NAMES = { bigben: 'Big Ben', comedynation: 'Comedy Nation' };

const state = {
  handles: {},      // slug -> { name, instagram }
  profiles: {},     // lowercase handle -> { status, name, pic, checkedAt, stale }
  checkedAt: null,
  people: [],       // [{ slug, name, img, next }]
  dirty: JSON.parse(lsGet('pendingHandles') || '{}'), // shared with the story maker
  filter: 'all',
  query: '',
};

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

// ---------- Gate ----------

async function connect() {
  $('#ghRepo').value = github.repo;
  $('#ghToken').value = github.token;
  if (IS_LOCAL) return true;
  if (!canSync()) return false;
  $('#gateMsg').textContent = 'Checking your GitHub token…';
  try {
    state.handles = (await github.readHandles()).handles;
    return true;
  } catch (e) {
    $('#gateMsg').textContent = explainGitHubError(e);
    $('#gateMsg').classList.add('error');
    return false;
  }
}

$('#connect').addEventListener('click', async () => {
  lsSet('ghRepo', $('#ghRepo').value.trim() || null);
  lsSet('ghToken', $('#ghToken').value.replace(/\s+/g, '') || null);
  $('#gateMsg').classList.remove('error');
  if (await connect()) start();
});

// ---------- Data ----------

async function loadProfiles() {
  let data = null;
  if (IS_LOCAL) data = await readPublicJson(PROFILES_PATH, null);
  else {
    try { data = (await github.readJson(PROFILES_PATH)).data; } catch (e) { if (!/404/.test(e.message)) throw e; }
  }
  state.profiles = data?.profiles || {};
  state.checkedAt = data?.checkedAt || null;
}

// Everyone in upcoming lineups plus everyone who already has a handle
async function loadPeople() {
  const r = await fetch(`data/lineup.json?ts=${Date.now()}`, { cache: 'no-store' });
  const clubs = r.ok ? (await r.json()).clubs : {};
  const bySlug = new Map();
  for (const [club, events] of Object.entries(clubs)) {
    for (const ev of events) {
      for (const p of ev.performers) {
        if (!p.slug) continue;
        const cur = bySlug.get(p.slug);
        if (!cur) bySlug.set(p.slug, { slug: p.slug, name: p.name, img: p.img, photoMissing: p.photoMissing, next: { date: ev.date, club } });
        else if (ev.date && (!cur.next || ev.date < cur.next.date)) cur.next = { date: ev.date, club };
      }
    }
  }
  for (const [slug, v] of Object.entries(state.handles)) {
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: v.name, img: null, photoMissing: true, next: null });
  }
  state.people = [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
}

// ---------- Row state ----------

const savedHandle = p => state.handles[p.slug]?.instagram || '';
const currentHandle = p => (state.dirty[p.slug] ? state.dirty[p.slug].instagram : savedHandle(p));
// "none" = flagged as having no Instagram, so nobody keeps looking for them
const savedNone = p => !!state.handles[p.slug]?.none;
const currentNone = p => (state.dirty[p.slug] ? !!state.dirty[p.slug].none : savedNone(p));

function setEdit(p, instagram, none) {
  none = !instagram && none;
  if (instagram === savedHandle(p) && none === savedNone(p)) delete state.dirty[p.slug];
  else state.dirty[p.slug] = { name: p.name, instagram, none };
  lsSet('pendingHandles', Object.keys(state.dirty).length ? JSON.stringify(state.dirty) : null);
}

function rowStatus(p) {
  const h = currentHandle(p);
  if (state.dirty[p.slug]) return 'unsaved';
  if (!h) return currentNone(p) ? 'noig' : 'nohandle';
  const prof = state.profiles[h.toLowerCase()];
  if (!prof) return 'unchecked';
  if (prof.status === 'ok') return prof.stale ? 'stale' : 'ok';
  return prof.status; // missing | error
}

const FILTERS = [
  ['all', 'All', () => true],
  ['nohandle', 'No handle', s => s === 'nohandle'],
  ['noig', 'No Instagram', s => s === 'noig'],
  ['problems', 'Not found', s => s === 'missing' || s === 'error'],
  ['unchecked', 'Unchecked', s => s === 'unchecked'],
  ['unsaved', 'Unsaved', s => s === 'unsaved'],
];

function igCell(p, status) {
  const h = currentHandle(p);
  const prof = h ? state.profiles[h.toLowerCase()] : null;
  switch (status) {
    case 'nohandle': return '<button class="flag" data-act="none" title="Mark as not on Instagram, so you can skip them">🚫 No Instagram</button>';
    case 'noig': return '<span class="badge none">🚫 no Instagram</span><button class="linkbtn" data-act="undo">undo</button>';
    case 'unsaved': return currentNone(p) || (!h && savedNone(p))
      ? `<span class="badge warn">${currentNone(p) ? '🚫 no Instagram' : 'flag removed'} — unsaved</span><button class="linkbtn" data-act="${currentNone(p) ? 'undo' : 'none'}">undo</button>`
      : '<span class="badge warn">unsaved — checked after saving</span>';
    case 'unchecked': return '<span class="badge none">not checked yet</span>';
    case 'missing': return `<span class="badge bad">✗ not on Instagram</span><small>checked ${ago(prof.checkedAt)}</small>`;
    case 'error': return `<span class="badge warn">? couldn't check</span><small>${escapeHtml(prof.error || '')}</small>`;
    default: return `${prof.pic ? `<img src="${prof.pic}" alt="">` : ''}
      <div style="min-width:0"><div class="igname">${escapeHtml(prof.name || '(no display name)')}</div>
      <small>${status === 'stale' ? '⚠ last check failed · ' : '✓ '}checked ${ago(prof.checkedAt)}</small></div>`;
  }
}

function nextShow(p) {
  if (!p.next?.date) return 'no upcoming shows';
  const [, m, d] = p.next.date.split('-').map(Number);
  return `next: ${d} ${MONTHS_SHORT[m - 1]} · ${CLUB_NAMES[p.next.club] || p.next.club}`;
}

function rowHtml(p) {
  const status = rowStatus(p);
  const h = currentHandle(p);
  const cls = status === 'missing' || status === 'error' || status === 'nohandle' ? 'warn' : status === 'unsaved' ? 'unsaved' : '';
  const ig = p.photoMissing && instagramPic(state.handles, state.profiles, p.slug);
  const photo = ig || (p.img ? `https://wsrv.nl/?url=${encodeURIComponent(p.img)}&w=88&h=88&fit=cover&a=attention` : '');
  return `<li class="row ${cls}" data-slug="${p.slug}">
    ${photo ? `<img class="avatar" src="${photo}" alt="" loading="lazy">` : '<div class="avatar"></div>'}
    <div class="who"><div class="name">${escapeHtml(p.name)}</div><small>${nextShow(p)}</small></div>
    <div class="at"><input type="text" value="${escapeHtml(h)}" placeholder="${currentNone(p) ? 'no Instagram' : 'handle'}" autocomplete="off" spellcheck="false"></div>
    <div class="ig">${igCell(p, status)}</div>
    <a class="open" href="https://www.instagram.com/${encodeURIComponent(h)}/" target="_blank" rel="noopener" title="Open on Instagram" aria-disabled="${!h}">↗</a>
  </li>`;
}

// ---------- Render ----------

function visiblePeople() {
  const q = state.query.toLowerCase();
  const test = FILTERS.find(f => f[0] === state.filter)[2];
  return state.people.filter(p =>
    test(rowStatus(p)) && (!q || p.name.toLowerCase().includes(q) || currentHandle(p).toLowerCase().includes(q)));
}

function renderFilters() {
  const statuses = state.people.map(rowStatus);
  $('#filters').innerHTML = FILTERS.map(([key, label, test]) =>
    `<button data-filter="${key}" aria-pressed="${state.filter === key}">${label}<b>${statuses.filter(test).length}</b></button>`).join('');
}

function renderRows() {
  const list = visiblePeople();
  $('#rows').innerHTML = list.length ? list.map(rowHtml).join('') : '<li class="hint">Nobody matches.</li>';
}

function renderActions() {
  const n = Object.keys(state.dirty).length;
  $('#save').disabled = !n;
  $('#save').textContent = n ? `Save ${n} change${n > 1 ? 's' : ''}` : 'No changes';
  $('#checkNew').hidden = $('#checkAll').hidden = IS_LOCAL;
}

function renderAll() {
  renderFilters();
  renderRows();
  renderActions();
}

// Update one row in place while typing, so the input keeps focus
function refreshRow(li, p) {
  const status = rowStatus(p);
  li.className = `row ${status === 'missing' || status === 'error' || status === 'nohandle' ? 'warn' : status === 'unsaved' ? 'unsaved' : ''}`;
  li.querySelector('.ig').innerHTML = igCell(p, status);
  const h = currentHandle(p);
  const input = li.querySelector('input');
  input.placeholder = currentNone(p) ? 'no Instagram' : 'handle';
  if (document.activeElement !== input) input.value = h;
  const a = li.querySelector('.open');
  a.href = `https://www.instagram.com/${encodeURIComponent(h)}/`;
  a.setAttribute('aria-disabled', String(!h));
}

// ---------- Events ----------

$('#rows').addEventListener('input', e => {
  const li = e.target.closest('li.row');
  if (!li) return;
  const p = state.people.find(x => x.slug === li.dataset.slug);
  // typing a handle replaces a "no Instagram" flag; clearing the box brings the saved flag back
  setEdit(p, normalizeHandle(e.target.value), savedNone(p));
  refreshRow(li, p);
  renderFilters();
  renderActions();
});

// 🚫 No Instagram / undo buttons
$('#rows').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const li = b.closest('li.row');
  const p = state.people.find(x => x.slug === li.dataset.slug);
  setEdit(p, '', b.dataset.act === 'none');
  refreshRow(li, p);
  renderFilters();
  renderActions();
});

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  renderFilters();
  renderRows();
});

$('#search').addEventListener('input', e => {
  state.query = e.target.value.trim();
  renderRows();
});

$('#save').addEventListener('click', async () => {
  $('#save').disabled = true;
  $('#save').textContent = 'Saving…';
  try {
    state.handles = await commitHandleEdits(state.dirty);
    state.dirty = {};
    lsSet('pendingHandles', null);
    renderAll();
    if (IS_LOCAL) setStatus('Saved to handles.json. Run "npm run check-profiles" to look them up on Instagram.');
    // Saving handles.json starts the profile check for new handles on GitHub
    else await waitForCheck('Saved. Looking up the new handles on Instagram…');
  } catch (e) {
    setStatus('Not saved (kept on this device): ' + explainGitHubError(e), true);
    renderActions();
  }
});

async function runCheck(mode, label) {
  $('#checkNew').disabled = $('#checkAll').disabled = true;
  try {
    await github.dispatch('profiles.yml', { mode });
    await waitForCheck(label);
  } catch (e) {
    setStatus('Couldn\'t start the check: ' + explainGitHubError(e), true);
  }
  $('#checkNew').disabled = $('#checkAll').disabled = false;
}

// Polls profiles.json until the Action has written a newer result
async function waitForCheck(label) {
  const before = state.checkedAt;
  const started = Date.now();
  while (Date.now() - started < 10 * 60000) {
    setStatus(`${label} (${Math.round((Date.now() - started) / 1000)}s)`);
    await new Promise(r => setTimeout(r, 10000));
    await loadProfiles();
    if (state.checkedAt !== before) {
      renderAll();
      setStatus(`Instagram checked ${ago(state.checkedAt)}.`);
      return;
    }
  }
  setStatus('The check is taking long — see the Actions tab on GitHub. Reload this page later.', true);
}

$('#checkNew').addEventListener('click', () => runCheck('new', 'Looking up unchecked handles on Instagram…'));
$('#checkAll').addEventListener('click', () => {
  const n = new Set(Object.values(state.handles).filter(v => v.instagram).map(v => v.instagram.toLowerCase())).size;
  runCheck('all', `Re-checking all ${n} handles on Instagram (≈${Math.ceil(n * 2 / 60)} min)…`);
});

// ---------- Start ----------

async function start() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  setStatus('Loading…');
  try {
    if (IS_LOCAL) state.handles = await readPublicJson(HANDLES_PATH, {});
    await Promise.all([loadProfiles(), loadPeople()]);
    renderAll();
    setStatus(`${state.people.length} comedians · Instagram checked ${ago(state.checkedAt)}.`);
  } catch (e) {
    setStatus(explainGitHubError(e), true);
  }
}

(async () => {
  if (await connect()) start();
})();
