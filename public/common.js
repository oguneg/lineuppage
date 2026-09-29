// Shared by the story maker (app.js) and the handles page (handles-page.js):
// small helpers plus reading/writing repo files through the GitHub API.

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) || /^192\.168\.|^10\./.test(location.hostname);

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

function todayStockholm() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function normalizeHandle(v) {
  return String(v || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/[/?#].*$/, '');
}

// ---------- GitHub storage ----------

const HANDLES_PATH = 'public/handles.json';
const PROFILES_PATH = 'public/profiles.json';

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

  async readJson(path) {
    const f = await this.api(`/contents/${path}?ref=main`);
    // files over 1 MB come back without inline content
    const text = f.content
      ? new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\n/g, '')), c => c.charCodeAt(0)))
      : await (await fetch(f.download_url, { cache: 'no-store' })).text();
    return { sha: f.sha, data: JSON.parse(text) };
  },

  async readHandles() {
    const { sha, data } = await this.readJson(HANDLES_PATH);
    return { sha, handles: data };
  },

  async writeHandles(handles, sha, message) {
    const bytes = new TextEncoder().encode(JSON.stringify(handles, null, 2) + '\n');
    const content = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
    return this.api(`/contents/${HANDLES_PATH}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content, sha, branch: 'main' }),
    });
  },

  dispatch(workflow, inputs = {}) {
    return this.api(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs }) });
  },
};

const canSync = () => !IS_LOCAL && github.repo && github.token;

function explainGitHubError(e) {
  if (/401/.test(e.message)) return 'GitHub rejected the token — it was probably copied incompletely. Generate a new one and paste the whole thing.';
  if (/403/.test(e.message)) return 'The token can\'t write to this repo — edit it on GitHub and set Contents (and Actions) to Read and write.';
  if (/404/.test(e.message)) return 'The token can\'t see this repo — edit it on GitHub and give it access to lineuppage.';
  return e.message;
}

function sortHandles(h) {
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => a.localeCompare(b)));
}

// edits: slug -> { name, instagram, none }. `none` marks "has no Instagram" so nobody goes
// looking again; an edit with neither removes the entry.
function applyEdits(handles, edits) {
  const out = { ...handles };
  for (const [slug, v] of Object.entries(edits)) {
    if (v.instagram) out[slug] = { name: v.name, instagram: v.instagram };
    else if (v.none) out[slug] = { name: v.name, none: true };
    else delete out[slug];
  }
  return sortHandles(out);
}

// Last-resort photo for comedians without one on the site: their Instagram profile picture
// (a small inline image saved by the profile check), if the handle checked out.
function instagramPic(handles, profiles, slug) {
  const h = handles[slug]?.instagram;
  const prof = h && profiles[h.toLowerCase()];
  return prof?.status === 'ok' && prof.pic ? prof.pic : null;
}

// Read-only copy of a repo file: raw GitHub (fresh within minutes, no deploy needed), or disk when local
async function readPublicJson(path, fallback) {
  const url = IS_LOCAL || !github.repo ? path.replace(/^public\//, '') : `https://raw.githubusercontent.com/${github.repo}/main/${path}`;
  const r = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
  return r.ok ? r.json() : fallback;
}

// Saves edits: straight to disk through the local server, or as one commit on GitHub.
async function commitHandleEdits(edits) {
  const names = Object.values(edits).map(v => v.name).join(', ');
  if (IS_LOCAL) {
    const merged = applyEdits(await readPublicJson(HANDLES_PATH, {}), edits);
    const r = await fetch('/api/handles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged) });
    if (!r.ok) throw new Error(await r.text());
    return merged;
  }
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
