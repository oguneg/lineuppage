// Looks up every Instagram handle in public/handles.json and records what Instagram shows
// (display name + small profile picture) in public/profiles.json, so broken or changed
// handles stand out on the handles page.
//
//   node scripts/check-profiles.mjs          only handles not checked yet (new or changed)
//   node scripts/check-profiles.mjs --all    every handle
//   node scripts/check-profiles.mjs foo bar  just these handles
//
// Instagram serves profile previews (og: tags) to link-preview crawlers without a login.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HANDLES_FILE = fileURLToPath(new URL('../public/handles.json', import.meta.url));
const PROFILES_FILE = fileURLToPath(new URL('../public/profiles.json', import.meta.url));
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const DELAY_MS = 1500;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+property="og:${prop}"[^>]+content="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
};

async function check(handle) {
  const r = await fetch(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en' },
    redirect: 'manual',
  });
  if (r.status === 404) return { status: 'missing' };
  if (r.status !== 200) return { status: 'error', error: `HTTP ${r.status}` }; // login wall, rate limit…
  const html = await r.text();
  const title = meta(html, 'title');
  // Existing profiles: "Display Name (@handle) • Instagram photos and videos"; unknown ones have no og tags
  if (!title) return { status: 'missing' };
  const name = title.replace(/\s*\(@[^)]*\)\s*•.*$/, '').replace(/^@\S+\s*•.*$/, '').trim();
  let pic = null;
  const img = meta(html, 'image');
  if (img) {
    // Instagram's image URLs expire and can't be hot-linked, so keep a small inline copy
    const ir = await fetch(img, { headers: { 'User-Agent': UA } });
    if (ir.ok) pic = `data:${ir.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await ir.arrayBuffer()).toString('base64')}`;
  }
  return { status: 'ok', name, pic };
}

const args = process.argv.slice(2);
const handles = [...new Set(Object.values(readJson(HANDLES_FILE, {})).map(v => v.instagram.toLowerCase()))];
const store = readJson(PROFILES_FILE, { checkedAt: null, profiles: {} });

const targets = args.includes('--all') ? handles
  : args.length ? args.map(a => a.toLowerCase().replace(/^@/, ''))
  : handles.filter(h => !store.profiles[h]);

console.log(`Checking ${targets.length} of ${handles.length} handles`);
let answered = 0;
for (const [i, h] of targets.entries()) {
  if (i) await sleep(DELAY_MS);
  let res;
  try { res = await check(h); } catch (e) { res = { status: 'error', error: e.message }; }
  if (res.status !== 'error') answered++;
  const prev = store.profiles[h];
  // On a failed lookup keep the last good result, just flag it
  store.profiles[h] = res.status === 'error' && prev?.status === 'ok'
    ? { ...prev, stale: true, error: res.error }
    : { ...res, checkedAt: new Date().toISOString() };
  console.log(`${res.status.padEnd(7)} @${h}${res.name ? ` — ${res.name}` : ''}${res.error ? ` (${res.error})` : ''}`);
}

// If Instagram refused everything we're being blocked, not looking at broken handles — don't record that
if (targets.length >= 3 && !answered) {
  console.error('Instagram answered none of the lookups; not saving.');
  process.exit(1);
}

// Drop handles nobody uses any more
for (const h of Object.keys(store.profiles)) if (!handles.includes(h)) delete store.profiles[h];
store.profiles = Object.fromEntries(Object.entries(store.profiles).sort(([a], [b]) => a.localeCompare(b)));
store.checkedAt = new Date().toISOString();
writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 1) + '\n');
