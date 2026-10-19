// Stats page: how often each comedian plays Big Ben / Comedy Nation, counted from history.json
// (the record the daily workflow keeps of every show, since the site only lists upcoming ones).

const $ = s => document.querySelector(s);
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const isHost = role => /konferencier|\bhost\b|\bmc\b/i.test(role);

const state = {
  club: lsGet('statsClub') || 'bigben',
  days: Number(lsGet('statsDays') ?? 0),
  query: '',
  history: null,    // { since, shows: { key: { club, date, time, title, performers[] } } }
  photos: {},       // slug -> image url
};

const fmtDay = iso => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS_SHORT[m - 1]}`; };

function shiftDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- Gate (same token as the other pages) ----------

async function connect() {
  $('#ghToken').value = github.token;
  if (IS_LOCAL) return true;
  if (!canSync()) return false;
  $('#gateMsg').textContent = 'Checking…';
  try {
    await github.readHandles();
    return true;
  } catch (e) {
    $('#gateMsg').textContent = explainGitHubError(e);
    $('#gateMsg').classList.add('error');
    return false;
  }
}

$('#connect').addEventListener('click', async () => {
  lsSet('ghToken', $('#ghToken').value.replace(/\s+/g, '') || null);
  $('#gateMsg').classList.remove('error');
  if (await connect()) start();
});
$('#ghToken').addEventListener('keydown', e => { if (e.key === 'Enter') $('#connect').click(); });

// ---------- Counting ----------

// Played = shows up to and including tonight; booked = shows after today
function tally() {
  const today = todayStockholm();
  const from = state.days ? shiftDays(today, -state.days + 1) : '';
  const people = new Map();
  let played = 0;
  const get = p => {
    if (!people.has(p.slug)) people.set(p.slug, { slug: p.slug, name: p.name, shows: 0, host: 0, last: null, next: null, booked: 0 });
    return people.get(p.slug);
  };
  for (const show of Object.values(state.history?.shows || {})) {
    if (show.club !== state.club) continue;
    if (show.date > today) {
      for (const p of show.performers) {
        const s = get(p);
        s.booked++;
        if (!s.next || show.date < s.next) s.next = show.date;
      }
    } else if (show.date >= from) {
      played++;
      for (const p of show.performers) {
        const s = get(p);
        s.name = p.name;
        s.shows++;
        if (isHost(p.role)) s.host++;
        if (!s.last || show.date > s.last) s.last = show.date;
      }
    }
  }
  const list = [...people.values()].sort((a, b) =>
    b.shows - a.shows || (b.last || '').localeCompare(a.last || '') || a.name.localeCompare(b.name, 'sv'));
  return { list, played };
}

// ---------- Render ----------

function render() {
  document.querySelectorAll('#clubs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.club === state.club)));
  document.querySelectorAll('#periods button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === state.days)));

  const { list, played } = tally();
  const since = state.history?.since;
  const period = state.days ? `the last ${state.days} days` : 'all time';
  const tracking = since ? `Tracking since ${fmtDay(since)}` : 'No history yet';
  const performers = list.filter(p => p.shows).length;
  $('#summary').textContent = `${tracking} · ${played} show${played === 1 ? '' : 's'} played in ${period} by ${performers} comedian${performers === 1 ? '' : 's'}.`;

  const q = state.query.toLowerCase();
  const max = Math.max(1, ...list.map(p => p.shows));
  const rows = list.filter(p => !q || p.name.toLowerCase().includes(q));
  $('#rows').innerHTML = rows.length ? rows.map(p => {
    const photo = state.photos[p.slug];
    return `<tr class="${p.shows ? '' : 'zero'}">
      <td class="pic">${photo ? `<img src="${photo}" alt="" loading="lazy">` : '<div></div>'}</td>
      <td class="name">${escapeHtml(p.name)}</td>
      <td class="countcell"><div class="count"><span class="bar" style="width:${Math.round((p.shows / max) * 100)}%"></span><b>${p.shows}</b></div></td>
      <td class="num hide-sm">${p.host || ''}</td>
      <td class="hide-sm">${p.last ? fmtDay(p.last) : '—'}</td>
      <td>${p.next ? `${fmtDay(p.next)}${p.booked > 1 ? `<small>+${p.booked - 1} more booked</small>` : ''}` : '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="hint">Nobody matches.</td></tr>';
}

$('#clubs').addEventListener('click', e => {
  const b = e.target.closest('button[data-club]');
  if (!b) return;
  state.club = b.dataset.club;
  lsSet('statsClub', state.club);
  render();
});

$('#periods').addEventListener('click', e => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  state.days = Number(b.dataset.days);
  lsSet('statsDays', String(state.days));
  render();
});

$('#search').addEventListener('input', e => { state.query = e.target.value.trim(); render(); });

// ---------- Start ----------

async function start() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#summary').textContent = 'Loading…';
  const [history, lineup, handles, profiles] = await Promise.all([
    readPublicJson('public/history.json', null),
    fetch(`data/lineup.json?ts=${Date.now()}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
    readPublicJson(HANDLES_PATH, {}),
    readPublicJson(PROFILES_PATH, null),
  ]);
  state.history = history;
  // Photos: from the lineup (site photo), else the comedian's Instagram picture
  for (const p of Object.values(lineup?.clubs || {}).flat().flatMap(e => e.performers)) {
    if (!p.slug || state.photos[p.slug]) continue;
    const ig = p.photoMissing && instagramPic(handles, profiles?.profiles || {}, p.slug);
    if (ig || p.img) state.photos[p.slug] = ig || `https://wsrv.nl/?url=${encodeURIComponent(p.img)}&w=68&h=68&fit=cover&a=attention`;
  }
  for (const slug of Object.keys(handles)) {
    if (!state.photos[slug]) { const ig = instagramPic(handles, profiles?.profiles || {}, slug); if (ig) state.photos[slug] = ig; }
  }
  render();
}

(async () => {
  if (await connect()) start();
})();
