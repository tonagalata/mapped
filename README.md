# BCBA & Client Map

A Next.js app that visualizes BCBAs and clients on a Google Map with drive-time radius filtering. Roster data is loaded per-session from an uploaded Excel file or a Google Sheets link — **nothing is sent to any server**.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

You'll need a **Google Maps API key** with these APIs enabled:

- Maps JavaScript API
- Geocoding API
- Distance Matrix API

Paste it into the sidebar once the map screen loads.

## Loading data

Two ways:

1. **Upload Excel** — drag-and-drop or click to choose. Supports `.xlsx`, `.xls`, `.csv`.
2. **Google Sheet URL** — paste a sharing link. The sheet must be set to "Anyone with the link → Viewer" so the browser can fetch the XLSX export.

Expected column headers in any sheet (multiple sheets are scanned automatically):

- `HIPAA Name` (e.g. `Aid Sco`)
- `City`, `State`, `Zipcode`
- `BCBA Assigned` (JSON-style list: `["Holly Barlow"]`)
- `BCBA Address` (city + state, e.g. `Apex NC`)
- `onboarding_status` (optional, shown in info popup)
- `Is In-Person Possible` or `Is In-Person Possible?` (optional)

Sheets that don't contain these columns are ignored.

## Privacy / HIPAA posture

- **Excel parsing is client-side.** The file is read with SheetJS in the browser. Bytes never reach a server.
- **Google Sheets fetch is client-side.** The browser calls `docs.google.com/...export?format=xlsx` directly.
- **Storage is session-scoped.** Parsed roster lives in `sessionStorage`, which clears when the tab closes. A **Purge** button in the sidebar wipes it immediately.
- **No analytics, no logging, no third-party scripts** beyond the Google Maps SDK (loaded only after the user provides their own key).
- **Markers are city/ZIP-level only.** The street address column is read but is never sent to the geocoder and never displayed. Multiple clients in the same ZIP get a small deterministic jitter so they don't pile up.
- **Hardening headers** (`X-Frame-Options`, `Referrer-Policy`, HSTS, etc.) are set in `netlify.toml`.

> ⚠️ This is privacy hygiene, not a HIPAA compliance certification. If your organization has a BAA requirement, vet the Google Maps Platform terms (Google offers a BAA for some products — verify before going live with PHI).

## Deploying to Netlify

1. Push this repo to GitHub / GitLab.
2. New site in Netlify → "Import an existing project" → pick the repo.
3. Netlify auto-detects Next.js via the included `@netlify/plugin-nextjs` config in `netlify.toml`. No env vars required.
4. Optional but recommended:
   - Force HTTPS (Site settings → Domain → HTTPS → Force).
   - Add Google Maps API key restrictions (HTTP referrer) in Google Cloud Console — restrict to your Netlify domain.

## File layout

```
app/
  layout.tsx        # Root layout
  page.tsx          # Top-level route — flips between Uploader and MapView
  globals.css       # All styles
components/
  Uploader.tsx      # File-drop / sheet-URL screen
  MapView.tsx       # Google Maps + filter logic
lib/
  parseRoster.ts    # XLSX/CSV/Google Sheets → Roster
  session.ts        # sessionStorage helpers (save / load / purge)
```
