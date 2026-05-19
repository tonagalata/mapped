// sessionStorage helpers. Data is scoped to a single tab and is purged when
// the tab closes — never persisted to disk and never sent to a server.

import type { Roster } from './parseRoster';

const KEY = 'bcba-map-roster-v1';

export function saveRoster(roster: Roster): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(roster));
  } catch {
    // Quota or private-mode failures — silent. The roster is still in memory.
  }
}

export function loadRoster(): Roster | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Roster;
  } catch {
    return null;
  }
}

export function purgeRoster(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
