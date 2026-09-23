// Parses the standupsverige.se/lineup page into { bigben: [event], comedynation: [event] }.
// Works on any DOM Document (linkedom in Node).

export const SECTIONS = { bigben: 'lineup-big-ben-standup', comedynation: 'lineup-comedy-nation' };
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

const clean = s => (s || '').replace(/\s+/g, ' ').trim();

export function todayStockholm() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
}

function isoFor(day, monthIdx, today) {
  const [ty, tm] = today.split('-').map(Number);
  // The lineup only lists upcoming shows; a month far "behind" today belongs to next year.
  const year = monthIdx + 1 < tm - 2 ? ty + 1 : ty;
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseLineup(doc, today = todayStockholm()) {
  const out = {};
  for (const [club, id] of Object.entries(SECTIONS)) {
    const section = doc.getElementById(id);
    out[club] = !section ? [] : [...section.querySelectorAll('.event-item')].map(item => {
      const day = parseInt(clean(item.querySelector('.event-time.day')?.textContent), 10);
      const monthIdx = MONTHS.indexOf(clean(item.querySelector('.event-time.month')?.textContent).toLowerCase());
      const performers = [...item.querySelectorAll('.komiker-parent')].map(p => {
        const href = p.querySelector('a.komiker-name.anchor')?.getAttribute('href') || '';
        return {
          role: clean(p.querySelector('.table-komiker')?.textContent),
          name: clean(p.querySelector('p.komiker-name')?.textContent),
          slug: (href.match(/komikerprofil\/([^/?#]+)/) || [])[1] || null,
          img: p.querySelector('img.playlist-image-komiker')?.getAttribute('src') || null,
          bio: clean(p.querySelector('.biography-playlist')?.textContent).replace(/…$/, '').trim(),
        };
      }).filter(p => p.name);
      return {
        date: monthIdx >= 0 && day ? isoFor(day, monthIdx, today) : null,
        title: clean(item.querySelector('.club-name-date-time')?.textContent),
        time: clean(item.querySelector('.event-day-date-time')?.textContent),
        performers,
      };
    });
  }
  return out;
}
