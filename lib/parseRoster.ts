// Client-side roster parser. Runs entirely in the browser — no server upload.
// Accepts either an uploaded Excel/CSV file or a Google Sheets URL (which we
// transform into a CSV export URL and fetch from the user's browser).

import * as XLSX from 'xlsx';

export type Client = {
  name: string;       // HIPAA-safe abbreviated name from the sheet (e.g. "Aid Sco")
  city: string;
  state: string;
  zip: string;
  status: string;
  bcbas: string[];
  bcba_city: string;  // BCBA's home city, used as label only
  in_person: string;
};

export type Bcba = {
  name: string;
  address: string;    // geocodable string, e.g. "Apex NC, USA"
};

export type Roster = {
  clients: Client[];
  bcbas: Bcba[];
};

// Try to parse the BCBA cell as a JSON array (the spreadsheet stores it as
// '["Holly Barlow"]'). Fall back to a single trimmed name. Returns [] for empty.
function parseBcbaList(cell: unknown): string[] {
  if (cell == null) return [];
  const s = String(cell).trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.replace(/'/g, '"'));
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    // not JSON — treat as a single name
  }
  return [s];
}

// Map a row from one of the client sheets to our Client shape.
// We pull only the fields we display; street address is intentionally dropped
// to keep marker placement at city/ZIP granularity.
function rowToClient(row: Record<string, unknown>): Client | null {
  const name = String(row['HIPAA Name'] ?? '').trim();
  const city = String(row['City'] ?? '').trim();
  const state = String(row['State'] ?? '').trim();
  if (!name || !city || !state) return null;

  // "Is In-Person Possible" appears with and without a trailing "?" across the
  // NC and SC sheets — normalize.
  const inPerson =
    row['Is In-Person Possible'] ??
    row['Is In-Person Possible?'] ??
    '';

  return {
    name,
    city,
    state,
    zip: String(row['Zipcode'] ?? '').trim(),
    status: String(row['onboarding_status'] ?? '').trim(),
    bcbas: parseBcbaList(row['BCBA Assigned']),
    bcba_city: String(row['BCBA Address'] ?? '').trim(),
    in_person: String(inPerson).trim(),
  };
}

// Pull every row that looks like a client row from every sheet in the workbook.
// We scan every sheet (rather than hard-coding "NC Clients" / "SC Clients") so
// users can add MA Clients, GA Clients, etc., without changing code.
function workbookToRoster(wb: XLSX.WorkBook): Roster {
  const clients: Client[] = [];
  const bcbaMap = new Map<string, string>(); // name -> first non-empty city seen

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });
    for (const row of rows) {
      // Heuristic: it's a client row only if it has all three of HIPAA Name + City + State.
      // Compliance summary / reassignment sheets won't have all three.
      if (!row['HIPAA Name'] || !row['City'] || !row['State']) continue;
      const c = rowToClient(row);
      if (!c) continue;
      clients.push(c);
      // Build the BCBA roster from the client rows themselves
      for (const bcbaName of c.bcbas) {
        if (c.bcba_city && !bcbaMap.has(bcbaName)) {
          bcbaMap.set(bcbaName, c.bcba_city);
        } else if (!bcbaMap.has(bcbaName)) {
          bcbaMap.set(bcbaName, '');
        }
      }
    }
  }

  const bcbas: Bcba[] = Array.from(bcbaMap.entries())
    .map(([name, city]) => ({
      name,
      // Normalize to a geocodable string. The sheet stores values like
      // "Apex NC" — append ", USA" to bias Google's geocoder.
      address: city ? `${city}, USA` : '',
    }))
    .filter((b) => b.address)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { clients, bcbas };
}

export async function parseExcelFile(file: File): Promise<Roster> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return workbookToRoster(wb);
}

// Convert a typical Google Sheets URL into the CSV export endpoint and fetch.
// Supports:
//   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>
//   https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing
// The sheet must be either public or shared with "anyone with the link".
export async function parseGoogleSheetUrl(url: string): Promise<Roster> {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('That does not look like a Google Sheets URL.');
  const id = m[1];

  // Use the xlsx export so we get every tab in one shot (CSV export only returns one tab).
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
  const resp = await fetch(exportUrl);
  if (!resp.ok) {
    throw new Error(
      `Could not fetch the sheet (HTTP ${resp.status}). Make sure link sharing is on (Anyone with the link → Viewer).`,
    );
  }
  const buf = await resp.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return workbookToRoster(wb);
}
