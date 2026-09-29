// Fetches standupsverige.se/lineup and writes public/data/lineup.json.
// Run by the GitHub Action on a schedule; also imported by the local dev server.

import { parseHTML } from 'linkedom';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLineup } from './parse-lineup.mjs';

const LINEUP_URL = 'https://standupsverige.se/lineup/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const OUT_FILE = fileURLToPath(new URL('../public/data/lineup.json', import.meta.url));

// ---------- Photos ----------
// Comedians without a picture show the site's placeholder or a blank Gravatar. For those we
// borrow the photo from another profile with the same name (the site has duplicates like
// "brennan-dilts" / "brennan-dilts-2"); anyone still without one is flagged `photoMissing`
// so the page can fall back to their Instagram picture.

const photoChecks = new Map(); // url -> Promise<boolean>

function hasRealPhoto(url) {
  if (!url || /standupsverige-fallback/.test(url)) return Promise.resolve(false);
  if (!/gravatar\.com\/avatar/.test(url)) return Promise.resolve(true);
  if (!photoChecks.has(url)) {
    // d=404 makes Gravatar answer 404 instead of drawing its default silhouette
    const u = new URL(url);
    u.searchParams.set('d', '404');
    photoChecks.set(url, fetch(u, { method: 'HEAD' }).then(r => r.ok, () => true));
  }
  return photoChecks.get(url);
}

const nameKey = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// The profile page shows the comedian's photo as an <img> whose alt is their name
async function profilePagePhoto(slug, name) {
  const r = await fetch(`https://standupsverige.se/komikerprofil/${slug}/`, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const { document } = parseHTML(await r.text());
  const img = [...document.querySelectorAll('img[alt]')].find(i => nameKey(i.getAttribute('alt')) === nameKey(name));
  const src = img?.getAttribute('src');
  return src && await hasRealPhoto(src) ? src : null;
}

async function resolvePhotos(clubs) {
  const performers = Object.values(clubs).flat().flatMap(e => e.performers).filter(p => p.slug);
  await Promise.all(performers.map(async p => { p.photoMissing = !(await hasRealPhoto(p.img)); }));

  const byName = new Map();
  for (const p of performers) if (!p.photoMissing && !byName.has(nameKey(p.name))) byName.set(nameKey(p.name), p.img);

  const found = new Map(); // slug -> borrowed photo url | null
  for (const p of performers.filter(p => p.photoMissing)) {
    if (!found.has(p.slug)) {
      let photo = byName.get(nameKey(p.name)) || null;
      if (!photo) {
        // Sibling profiles: name, name-2, name-3…
        const base = p.slug.replace(/-\d+$/, '');
        for (const s of [base, `${base}-2`, `${base}-3`].filter(s => s !== p.slug)) {
          photo = await profilePagePhoto(s, p.name).catch(() => null);
          if (photo) break;
        }
      }
      found.set(p.slug, photo);
    }
    if (found.get(p.slug)) {
      p.img = found.get(p.slug);
      p.photoMissing = false;
    }
  }
  return [...found].filter(([, v]) => v).length;
}

export async function fetchLineup() {
  const r = await fetch(LINEUP_URL, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`standupsverige.se answered ${r.status}`);
  const { document } = parseHTML(await r.text());
  const clubs = parseLineup(document);
  const total = Object.values(clubs).reduce((a, e) => a + e.length, 0);
  if (!total) throw new Error('No shows found — has the site layout changed?');
  const borrowed = await resolvePhotos(clubs);
  return { fetchedAt: new Date().toISOString(), borrowedPhotos: borrowed, clubs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await fetchLineup();
  mkdirSync(new URL('../public/data/', import.meta.url), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(data));
  const missing = new Set(Object.values(data.clubs).flat().flatMap(e => e.performers).filter(p => p.photoMissing).map(p => p.name));
  console.log(`Wrote ${OUT_FILE}: ${Object.entries(data.clubs).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  console.log(`Photos borrowed from namesakes: ${data.borrowedPhotos}; still without photo: ${[...missing].join(', ') || 'none'}`);
}
