'use client';

import { useEffect, useState } from 'react';
import Uploader from '@/components/Uploader';
import MapView from '@/components/MapView';
import { loadRoster, saveRoster, purgeRoster } from '@/lib/session';
import type { Roster } from '@/lib/parseRoster';

export default function Page() {
  // `null` = no roster loaded yet (show Uploader)
  // `undefined` = haven't checked sessionStorage yet (show nothing — avoids flicker)
  const [roster, setRoster] = useState<Roster | null | undefined>(undefined);

  // Rehydrate from sessionStorage on first client render. Refreshing the tab
  // keeps the roster; closing the tab clears it.
  useEffect(() => {
    setRoster(loadRoster());
  }, []);

  function handleLoaded(r: Roster) {
    saveRoster(r);
    setRoster(r);
  }

  function handlePurge() {
    if (!confirm('Purge roster data from this session? This cannot be undone.')) return;
    purgeRoster();
    setRoster(null);
  }

  if (roster === undefined) return null;
  if (roster === null) return <Uploader onLoaded={handleLoaded} />;
  return <MapView roster={roster} onPurge={handlePurge} />;
}
