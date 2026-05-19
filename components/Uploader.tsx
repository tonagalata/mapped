'use client';

import { useRef, useState } from 'react';
import { parseExcelFile, parseGoogleSheetUrl, type Roster } from '@/lib/parseRoster';

type Props = { onLoaded: (roster: Roster) => void };

export default function Uploader({ onLoaded }: Props) {
  const [mode, setMode] = useState<'file' | 'sheet'>('file');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const roster = await parseExcelFile(file);
      if (!roster.clients.length) {
        throw new Error('No client rows found. Check column headers: HIPAA Name, City, State, BCBA Assigned, BCBA Address.');
      }
      onLoaded(roster);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not parse file.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSheet() {
    setError(null);
    if (!url.trim()) {
      setError('Paste a Google Sheets link.');
      return;
    }
    setBusy(true);
    try {
      const roster = await parseGoogleSheetUrl(url.trim());
      if (!roster.clients.length) {
        throw new Error('No client rows found. The sheet must use these headers: HIPAA Name, City, State, BCBA Assigned, BCBA Address.');
      }
      onLoaded(roster);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load sheet.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-shell">
      <div className="upload-card">
        <h1>BCBA & Client Map</h1>
        <p className="sub">Load a roster to begin. Data lives only in this browser tab.</p>

        <div className="upload-tabs">
          <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>
            Upload Excel
          </button>
          <button className={mode === 'sheet' ? 'active' : ''} onClick={() => setMode('sheet')}>
            Google Sheet URL
          </button>
        </div>

        {mode === 'file' ? (
          <>
            <div
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
            >
              <strong>Drop .xlsx file here</strong>
              <span className="hint">or click to choose · .xlsx, .xls, .csv</span>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </div>
            {busy && <p className="sub" style={{ marginTop: 12 }}>Parsing…</p>}
          </>
        ) : (
          <div className="url-field">
            <input
              type="text"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="hint">
              Share setting must be &ldquo;Anyone with the link → Viewer.&rdquo; The sheet is
              downloaded straight to your browser — never through our server.
            </p>
            <button className="btn-primary" onClick={handleSheet} disabled={busy}>
              {busy ? 'Loading…' : 'Load sheet'}
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="privacy-note">
          <strong>Privacy:</strong> roster data is parsed in your browser and held in
          <code style={{ margin: '0 4px' }}>sessionStorage</code> only. Closing the tab purges
          everything. Nothing is uploaded to any server.
        </div>
      </div>
    </div>
  );
}
