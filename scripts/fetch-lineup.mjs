// Fetches standupsverige.se/lineup and writes public/data/lineup.json.
// Run by the GitHub Action on a schedule; also imported by the local dev server.

import { parseHTML } from 'linkedom';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLineup } from './parse-lineup.mjs';

const LINEUP_URL = 'https://standupsverige.se/lineup/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const OUT_FILE = fileURLToPath(new URL('../public/data/lineup.json', import.meta.url));

export async function fetchLineup() {
  const r = await fetch(LINEUP_URL, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`standupsverige.se answered ${r.status}`);
  const { document } = parseHTML(await r.text());
  const clubs = parseLineup(document);
  const total = Object.values(clubs).reduce((a, e) => a + e.length, 0);
  if (!total) throw new Error('No shows found — has the site layout changed?');
  return { fetchedAt: new Date().toISOString(), clubs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await fetchLineup();
  mkdirSync(new URL('../public/data/', import.meta.url), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(data));
  console.log(`Wrote ${OUT_FILE}: ${Object.entries(data.clubs).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
}
