'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Roster } from '@/lib/parseRoster';

type Props = {
  roster: Roster;
  onPurge: () => void;
};

// Markers carry a deterministic jitter so multiple clients in the same ZIP
// don't pile onto a single pin. baseLoc is the un-jittered point used for
// the Distance Matrix call so drive-time math isn't distorted.
type ClientItem = {
  idx: number;
  data: Roster['clients'][number];
  baseLoc: google.maps.LatLngLiteral;
  loc: google.maps.LatLngLiteral;
  marker: google.maps.Marker;
};
type BcbaItem = {
  name: string;
  address: string;
  loc: google.maps.LatLngLiteral;
  marker: google.maps.Marker;
};

declare global {
  interface Window {
    google?: typeof google;
    __initBcbaMap?: () => void;
  }
}

function cleanCity(addr: string): string {
  // "Apex NC, USA" -> "Apex, NC"
  return addr.replace(', USA', '').replace(/\s+([A-Z]{2})$/, ', $1');
}

// Seeded jitter so a given client always sits in the same spot.
function jitter(seed: number) {
  const s = Math.sin(seed * 9301 + 49297) * 233280;
  const t = Math.sin(seed * 49297 + 9301) * 233280;
  return { dLat: (s - Math.floor(s) - 0.5) * 0.02, dLng: (t - Math.floor(t) - 0.5) * 0.02 };
}

export default function MapView({ roster, onPurge }: Props) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const distanceMatrixRef = useRef<google.maps.DistanceMatrixService | null>(null);
  const infoWinRef = useRef<google.maps.InfoWindow | null>(null);
  const clientItemsRef = useRef<ClientItem[]>([]);
  const bcbaItemsRef = useRef<BcbaItem[]>([]);
  const bcbaCirclesRef = useRef<google.maps.Circle[]>([]);
  const geocodeCacheRef = useRef<Map<string, google.maps.LatLngLiteral>>(new Map());

  // Active filter state — kept in refs because filter handlers read/write it
  // alongside imperative Google Maps calls. State doubles run in React 18 dev,
  // which would otherwise re-trigger Distance Matrix.
  const filterStateRef = useRef({
    bcba: { active: false, names: [] as string[], minutes: 30, clientHits: null as Set<number> | null },
    client: { active: false, names: [] as string[] },
  });

  const [apiKey, setApiKey] = useState('');
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [status, setStatus] = useState<{ msg: string; err?: boolean }>({ msg: '' });
  const [stats, setStats] = useState({ clientsShown: 0, bcbasShown: 0 });
  const [selectedBcbas, setSelectedBcbas] = useState<string[]>([]);
  const [selectedClients, setSelectedClients] = useState<number[]>([]);
  const [radiusMinutes, setRadiusMinutes] = useState(30);

  // Sorted client list for the dropdown — sorted once, kept stable.
  const clientOptions = useMemo(
    () =>
      roster.clients.map((c, i) => ({
        idx: i,
        label: `${c.name} — ${c.city}, ${c.state}`,
      })),
    [roster.clients],
  );

  // ---------------- Load Google Maps SDK on demand ----------------
  function loadMaps() {
    const key = apiKey.trim();
    if (!key) {
      setStatus({ msg: 'Enter an API key first', err: true });
      return;
    }
    if (window.google?.maps) {
      // Already loaded (e.g. from a previous mount); initialize directly.
      initMap();
      return;
    }
    setStatus({ msg: 'Loading Google Maps…' });
    window.__initBcbaMap = initMap;
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key,
    )}&callback=__initBcbaMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => setStatus({ msg: 'Failed to load Google Maps.', err: true });
    document.head.appendChild(script);
  }

  async function initMap() {
    if (!mapEl.current) return;
    const map = new google.maps.Map(mapEl.current, {
      center: { lat: 34.5, lng: -80.5 },
      zoom: 7,
      mapTypeControl: false,
      streetViewControl: false,
    });
    mapRef.current = map;
    geocoderRef.current = new google.maps.Geocoder();
    distanceMatrixRef.current = new google.maps.DistanceMatrixService();
    setMapsLoaded(true);
    setStatus({ msg: 'Map loaded. Geocoding…' });
    await geocodeAll();
    setStatus({
      msg: `Ready. ${clientItemsRef.current.length} clients & ${bcbaItemsRef.current.length} BCBAs plotted.`,
    });
    // One-time fit to all markers
    const bounds = new google.maps.LatLngBounds();
    [...clientItemsRef.current, ...bcbaItemsRef.current].forEach((o) => bounds.extend(o.loc));
    if (!bounds.isEmpty()) map.fitBounds(bounds);
    renderVisibility();
  }

  // ---------------- Geocoding ----------------
  function geocode(addr: string): Promise<google.maps.LatLngLiteral | null> {
    const cache = geocodeCacheRef.current;
    if (cache.has(addr)) return Promise.resolve(cache.get(addr)!);
    return new Promise((resolve) => {
      geocoderRef.current!.geocode({ address: addr }, (results, status) => {
        if (status === 'OK' && results && results[0]) {
          const loc = {
            lat: results[0].geometry.location.lat(),
            lng: results[0].geometry.location.lng(),
          };
          cache.set(addr, loc);
          resolve(loc);
        } else if (status === 'OVER_QUERY_LIMIT') {
          setTimeout(() => geocode(addr).then(resolve), 1500);
        } else {
          resolve(null);
        }
      });
    });
  }

  async function geocodeAll() {
    const map = mapRef.current!;
    // BCBAs first (small set, fast)
    for (const b of roster.bcbas) {
      const loc = await geocode(b.address);
      if (!loc) continue;
      const marker = new google.maps.Marker({
        position: loc,
        map,
        icon: bcbaIcon(),
        title: `${b.name} (${cleanCity(b.address)})`,
      });
      marker.addListener('click', () =>
        openInfo(
          marker,
          `<div class="info-window"><h3>${escapeHtml(b.name)}</h3><div class="meta">BCBA · ${escapeHtml(
            cleanCity(b.address),
          )}</div></div>`,
        ),
      );
      bcbaItemsRef.current.push({ name: b.name, address: b.address, loc, marker });
    }

    // Clients — geocode at city/state/ZIP only, never the street address.
    for (let i = 0; i < roster.clients.length; i++) {
      const c = roster.clients[i];
      const cityAddr = `${c.city}, ${c.state} ${c.zip}, USA`;
      const loc = await geocode(cityAddr);
      if ((i + 1) % 20 === 0) setStatus({ msg: `Geocoding clients… ${i + 1}/${roster.clients.length}` });
      if (!loc) continue;
      const j = jitter(i);
      const pos = { lat: loc.lat + j.dLat, lng: loc.lng + j.dLng };
      const marker = new google.maps.Marker({ position: pos, map, icon: clientIcon(), title: c.name });
      const bcbaList = c.bcbas.length ? c.bcbas.join(', ') : '(unassigned)';
      marker.addListener('click', () =>
        openInfo(
          marker,
          `<div class="info-window">
            <h3>${escapeHtml(c.name)}</h3>
            <div class="meta">${escapeHtml(c.city)}, ${escapeHtml(c.state)}</div>
            <div class="meta">BCBA: ${escapeHtml(bcbaList)}</div>
            <div class="meta">In-person: ${escapeHtml(c.in_person || 'n/a')}</div>
            <span class="badge">${escapeHtml(c.status || 'no status')}</span>
          </div>`,
        ),
      );
      clientItemsRef.current.push({ idx: i, data: c, baseLoc: loc, loc: pos, marker });
    }
  }

  function openInfo(marker: google.maps.Marker, html: string) {
    infoWinRef.current?.close();
    const iw = new google.maps.InfoWindow({ content: html });
    iw.open({ map: mapRef.current!, anchor: marker });
    infoWinRef.current = iw;
  }

  // ---------------- Visibility engine ----------------
  function renderVisibility() {
    let visibleClients = clientItemsRef.current.slice();
    let visibleBcbas = bcbaItemsRef.current.slice();
    const fs = filterStateRef.current;

    if (fs.bcba.active && fs.bcba.names.length) {
      const set = new Set(fs.bcba.names);
      visibleBcbas = visibleBcbas.filter((b) => set.has(b.name));
      const hits = fs.bcba.clientHits;
      visibleClients = hits
        ? visibleClients.filter((c) => hits.has(c.idx))
        : visibleClients.filter((c) => c.data.bcbas.some((n) => set.has(n)));
    }

    if (fs.client.active && fs.client.names.length) {
      const set = new Set(fs.client.names);
      visibleClients = visibleClients.filter((c) => set.has(c.data.name));
      const assigned = new Set<string>();
      visibleClients.forEach((c) => c.data.bcbas.forEach((n) => assigned.add(n)));
      visibleBcbas = visibleBcbas.filter((b) => assigned.has(b.name));
    }

    const cSet = new Set(visibleClients.map((c) => c.idx));
    const bSet = new Set(visibleBcbas.map((b) => b.name));
    clientItemsRef.current.forEach((c) => c.marker.setMap(cSet.has(c.idx) ? mapRef.current : null));
    bcbaItemsRef.current.forEach((b) => b.marker.setMap(bSet.has(b.name) ? mapRef.current : null));
    setStats({ clientsShown: visibleClients.length, bcbasShown: visibleBcbas.length });
  }

  function clearBcbaCircles() {
    bcbaCirclesRef.current.forEach((c) => c.setMap(null));
    bcbaCirclesRef.current = [];
  }

  async function driveTimeHits(
    origin: google.maps.LatLngLiteral,
    minutes: number,
    items: { key: number; loc: google.maps.LatLngLiteral }[],
  ): Promise<number[]> {
    const hits: number[] = [];
    const dm = distanceMatrixRef.current!;
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        dm.getDistanceMatrix(
          {
            origins: [origin],
            destinations: chunk.map((o) => o.loc),
            travelMode: google.maps.TravelMode.DRIVING,
            unitSystem: google.maps.UnitSystem.IMPERIAL,
          },
          (resp, status) => {
            if (status === 'OK' && resp) {
              resp.rows[0].elements.forEach((el, j) => {
                if (el.status === 'OK' && el.duration.value / 60 <= minutes) {
                  hits.push(chunk[j].key);
                }
              });
            }
            resolve();
          },
        );
      });
    }
    return hits;
  }

  // ---------------- Filter A: BCBA + drive-time ----------------
  async function applyBcba() {
    if (!selectedBcbas.length) {
      setStatus({ msg: 'Pick at least one BCBA (hold Cmd/Ctrl for multi).', err: true });
      return;
    }
    const minutes = Number(radiusMinutes);
    if (!minutes || minutes < 1) {
      setStatus({ msg: 'Enter a radius in minutes.', err: true });
      return;
    }

    clearBcbaCircles();
    const radiusMeters = minutes * 0.67 * 1609.34;
    const selected = bcbaItemsRef.current.filter((b) => selectedBcbas.includes(b.name));
    selected.forEach((b) => {
      bcbaCirclesRef.current.push(
        new google.maps.Circle({
          map: mapRef.current!,
          center: b.loc,
          radius: radiusMeters,
          strokeColor: '#0071e3',
          strokeOpacity: 0.5,
          strokeWeight: 2,
          fillColor: '#0071e3',
          fillOpacity: 0.06,
          clickable: false,
        }),
      );
    });

    setStatus({ msg: `Computing drive times from ${selected.length} BCBA(s)…` });
    const hits = new Set<number>();
    for (const b of selected) {
      // eslint-disable-next-line no-await-in-loop
      const reached = await driveTimeHits(
        b.loc,
        minutes,
        clientItemsRef.current.map((c) => ({ key: c.idx, loc: c.baseLoc })),
      );
      reached.forEach((k) => hits.add(k));
    }

    filterStateRef.current.bcba = { active: true, names: selectedBcbas.slice(), minutes, clientHits: hits };
    renderVisibility();
    setStatus({
      msg: `${hits.size} client(s) within ${minutes} min drive of ${selected.length} selected BCBA(s).`,
    });
  }

  function clearBcba() {
    filterStateRef.current.bcba = { active: false, names: [], minutes: 30, clientHits: null };
    setSelectedBcbas([]);
    clearBcbaCircles();
    renderVisibility();
    setStatus({ msg: 'BCBA filter cleared.' });
  }

  // ---------------- Filter B: Client ----------------
  function applyClient() {
    if (!selectedClients.length) {
      setStatus({ msg: 'Pick at least one client.', err: true });
      return;
    }
    filterStateRef.current.client = {
      active: true,
      names: selectedClients.map((i) => roster.clients[i].name),
    };
    renderVisibility();
    setStatus({ msg: `Client filter: ${selectedClients.length} selected.` });
  }
  function clearClient() {
    filterStateRef.current.client = { active: false, names: [] };
    setSelectedClients([]);
    renderVisibility();
    setStatus({ msg: 'Client filter cleared.' });
  }

  function resetAll() {
    clearBcba();
    clearClient();
    setStatus({ msg: 'All filters cleared.' });
  }

  // ---------------- Marker icon factories ----------------
  function clientIcon(): google.maps.Symbol {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 6,
      fillColor: '#ff3b30',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    };
  }
  function bcbaIcon(): google.maps.Symbol {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#0071e3',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    };
  }

  // Cleanup on unmount: drop all markers & circles so React fast-refresh
  // doesn't leave ghost overlays.
  useEffect(() => {
    return () => {
      clientItemsRef.current.forEach((c) => c.marker.setMap(null));
      bcbaItemsRef.current.forEach((b) => b.marker.setMap(null));
      bcbaCirclesRef.current.forEach((c) => c.setMap(null));
    };
  }, []);

  return (
    <div id="app">
      <aside id="sidebar">
        <div className="sidebar-header">
          <div>
            <h1>BCBA & Client Map</h1>
            <p className="sub">HIPAA-safe view · drive-time radius</p>
          </div>
          <button className="purge-btn" onClick={onPurge} title="Purge session data and return to upload">
            Purge
          </button>
        </div>

        {!mapsLoaded && (
          <div id="api-setup">
            <strong>Setup:</strong> Google Maps API key (Maps JS + Geocoding + Distance Matrix).
            <input
              type="text"
              placeholder="AIza..."
              style={{ marginTop: 8 }}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button className="action" style={{ marginTop: 8 }} onClick={loadMaps}>
              Load map
            </button>
          </div>
        )}

        <div className="section" style={mapsLoaded ? { borderTop: 'none', paddingTop: 0, marginTop: 0 } : {}}>
          <div className="section-title">Filter A · BCBA + drive-time radius</div>
          <div className="field">
            <label htmlFor="bcba">BCBAs to display (hold Cmd/Ctrl for multi)</label>
            <select
              id="bcba"
              multiple
              disabled={!mapsLoaded}
              value={selectedBcbas}
              onChange={(e) =>
                setSelectedBcbas(Array.from(e.target.selectedOptions, (o) => o.value))
              }
            >
              {roster.bcbas.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name} — {cleanCity(b.address)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="radius">Driving radius from each BCBA (minutes)</label>
            <div className="radius-row">
              <input
                type="number"
                id="radius"
                min={5}
                max={240}
                step={5}
                value={radiusMinutes}
                disabled={!mapsLoaded}
                onChange={(e) => setRadiusMinutes(Number(e.target.value))}
              />
              <span>min</span>
            </div>
          </div>
          <p className="hint" style={{ marginBottom: 8 }}>
            Shows selected BCBAs + any clients within drive-time of any selected BCBA.
          </p>
          <div className="btn-row">
            <button className="action" disabled={!mapsLoaded} onClick={applyBcba}>
              Apply
            </button>
            <button className="action secondary" disabled={!mapsLoaded} onClick={clearBcba}>
              Clear
            </button>
          </div>
        </div>

        <div className="section">
          <div className="section-title">Filter B · Client</div>
          <div className="field">
            <label htmlFor="client">Specific clients to display</label>
            <select
              id="client"
              multiple
              disabled={!mapsLoaded}
              value={selectedClients.map(String)}
              onChange={(e) =>
                setSelectedClients(Array.from(e.target.selectedOptions, (o) => Number(o.value)))
              }
            >
              {clientOptions.map((c) => (
                <option key={c.idx} value={c.idx}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button className="action" disabled={!mapsLoaded} onClick={applyClient}>
              Apply
            </button>
            <button className="action secondary" disabled={!mapsLoaded} onClick={clearClient}>
              Clear
            </button>
          </div>
        </div>

        <button
          className="action secondary"
          style={{ marginTop: 14 }}
          disabled={!mapsLoaded}
          onClick={resetAll}
        >
          Reset all filters
        </button>

        <div id="status" className={status.err ? 'err' : ''}>
          {status.msg}
        </div>

        <div className="stats">
          <div>
            <span>Clients shown</span>
            <b>{stats.clientsShown}</b>
          </div>
          <div>
            <span>BCBAs shown</span>
            <b>{stats.bcbasShown}</b>
          </div>
          <div>
            <span>Total clients</span>
            <b>{roster.clients.length}</b>
          </div>
          <div>
            <span>Total BCBAs</span>
            <b>{roster.bcbas.length}</b>
          </div>
        </div>

        <div className="legend">
          <div className="legend-item">
            <span className="dot bcba" /> BCBA home city (origin when selected)
          </div>
          <div className="legend-item">
            <span className="dot client" /> Client
          </div>
        </div>
      </aside>

      <div id="map" ref={mapEl} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
