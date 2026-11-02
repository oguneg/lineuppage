// Local dev server. On GitHub Pages the same page runs statically: the Action
// builds data/lineup.json and handles are committed through the GitHub API.
// Locally, data/lineup.json is fetched live and handles are written to disk.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { fetchLineup } from './scripts/fetch-lineup.mjs';

const PORT = process.env.PORT || 5173;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const HANDLES_FILE = path.join(PUBLIC_DIR, 'handles.json');
const LINEUP_TTL = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let lineupCache = { at: 0, json: null };
let checking = false;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/data/lineup.json') {
      if (!lineupCache.json || Date.now() - lineupCache.at > LINEUP_TTL || url.searchParams.has('fresh')) {
        lineupCache = { at: Date.now(), json: JSON.stringify(await fetchLineup()) };
      }
      return send(res, 200, lineupCache.json, MIME['.json']);
    }

    // Re-check every Instagram handle and publish (handles page "Re-check" button).
    // Only from this computer itself: it pushes to GitHub with this machine's git login.
    if (url.pathname === '/api/check-profiles' && req.method === 'POST') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, 'only from this computer');
      if (checking) return send(res, 409, JSON.stringify({ ok: false, error: 'a check is already running' }), MIME['.json']);
      checking = true;
      execFile(process.execPath, ['scripts/sync-profiles.mjs', '--all'], { cwd: fileURLToPath(new URL('.', import.meta.url)), timeout: 15 * 60000 }, (err, stdout, stderr) => {
        checking = false;
        console.log(stdout);
        send(res, 200, JSON.stringify(err
          ? { ok: false, error: (stderr || err.message).trim().split('\n').pop() }
          : { ok: true, published: /Published/.test(stdout) }), MIME['.json']);
      });
      return;
    }

    if (url.pathname === '/api/handles' && req.method === 'POST') {
      // Body: the full handles map, already merged by the page
      const handles = JSON.parse(await readBody(req));
      fs.writeFileSync(HANDLES_FILE, JSON.stringify(handles, null, 2) + '\n');
      return send(res, 200, JSON.stringify(handles), MIME['.json']);
    }

    const rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, 502, String(e.message || e));
  }
});

server.listen(PORT, () => console.log(`Lineup tool running at http://localhost:${PORT}`));
