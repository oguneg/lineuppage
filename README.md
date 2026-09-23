# Lineup Story Maker

Pulls the lineup from https://standupsverige.se/lineup/ and draws it onto the
Big Ben / Comedy Nation story templates, plus builds the `@handle` string for tagging.

## How it works on GitHub Pages

- `.github/workflows/lineup.yml` scrapes the lineup every 30 min (07–23 Swedish time), on every
  push, and on demand, writes `data/lineup.json`, and deploys `public/` to Pages.
- Photos load through [wsrv.nl](https://wsrv.nl) (CORS-enabled image proxy, face-aware crop).
- Instagram handles live in `public/handles.json`. The page commits changes to it through the
  GitHub API using a fine-grained token (repo-only, Contents + Actions read/write) that you paste
  under **GitHub sync**; it's kept in that browser's localStorage only.
- **Refresh** (with a token) triggers the workflow and waits for the new lineup (~1 min).

### Setup

1. Push this folder to a public GitHub repo, branch `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. Open `https://<you>.github.io/<repo>/`, expand **GitHub sync**, paste the token.

GitHub pauses scheduled workflows after 60 days without repo activity; saving handles counts as
activity, and you can always re-enable it under the Actions tab.

## Local

```
npm install
npm start        # http://localhost:5173 — scrapes live, saves handles straight to public/handles.json
```

## Files

- `public/templates/*.png` — the 1080×1920 backgrounds.
- `scripts/parse-lineup.mjs` — the only place that knows the site's HTML structure.
- `public/app.js` — colours (`COLORS`) and layout of the story image.
