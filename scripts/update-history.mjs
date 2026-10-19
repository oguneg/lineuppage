// Keeps a running record of every show in public/history.json, so the stats page can count
// how often each comedian appears. The site only lists upcoming shows, so each fetch upserts
// what it sees: a show's lineup keeps updating until its date has passed, then stays frozen.
// Future shows that vanish from the site (cancelled or moved) are dropped.
//
// Reads public/data/lineup.json (run fetch-lineup first).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { todayStockholm } from './parse-lineup.mjs';

const LINEUP_FILE = fileURLToPath(new URL('../public/data/lineup.json', import.meta.url));
const HISTORY_FILE = fileURLToPath(new URL('../public/history.json', import.meta.url));

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const showKey = (club, e) => `${club}|${e.date}|${e.time.split(' ')[0]}|${e.title}`;
// Workshops etc. aren't comedy nights
const isShow = e => e.date && !/workshop/i.test(e.title);

const lineup = readJson(LINEUP_FILE, null);
if (!lineup) throw new Error('Run fetch-lineup first: public/data/lineup.json is missing');
const history = readJson(HISTORY_FILE, { since: null, updatedAt: null, shows: {} });
const today = todayStockholm();

const seen = new Set();
let added = 0, changed = 0;
for (const [club, events] of Object.entries(lineup.clubs)) {
  for (const e of events.filter(isShow)) {
    const key = showKey(club, e);
    seen.add(key);
    if (e.date < today && history.shows[key]) continue; // already happened: keep what was recorded
    // One entry per comedian; secret guests have no profile and aren't counted
    const performers = [];
    for (const p of e.performers) {
      if (p.slug && !performers.some(x => x.slug === p.slug)) performers.push({ slug: p.slug, name: p.name, role: p.role });
    }
    const show = { club, date: e.date, time: e.time.split(' ')[0], title: e.title, performers };
    const prev = history.shows[key];
    if (!prev) added++;
    else if (JSON.stringify(prev.performers) !== JSON.stringify(performers)) changed++;
    history.shows[key] = show;
  }
}

let dropped = 0;
for (const [key, show] of Object.entries(history.shows)) {
  if (show.date > today && !seen.has(key)) { delete history.shows[key]; dropped++; }
}

history.shows = Object.fromEntries(Object.entries(history.shows).sort(([, a], [, b]) =>
  a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.club.localeCompare(b.club)));
history.since ||= today;
history.updatedAt = new Date().toISOString();
writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1) + '\n');
console.log(`History: ${Object.keys(history.shows).length} shows (${added} new, ${changed} lineups changed, ${dropped} cancelled/moved)`);
