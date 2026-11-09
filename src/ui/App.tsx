import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EXAMPLES } from '../examples';
import { Editor } from './Editor';
import { shareUrl, sourceFromHash } from './share';
import { SimClient } from './simClient';
import type { SimResponse } from './simTypes';
import { Waveform } from './Waveform';

type Status = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; res: SimResponse };

const DEFAULT_MAX_TIME = 100_000;
const STORAGE_KEY = 'vsim:source';

function loadSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(source: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // Storage can be unavailable (private mode, blocked); saving drafts is just a convenience.
  }
}

export function App() {
  const [source, setSource] = useState<string>(() => loadSaved() ?? EXAMPLES[0]!.source);
  const [exampleId, setExampleId] = useState<string>('');
  const [maxTime, setMaxTime] = useState(DEFAULT_MAX_TIME);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [revealToken, setRevealToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const client = useMemo(() => new SimClient(), []);
  const lastGood = useRef<Extract<SimResponse, { ok: true }> | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const run = useCallback(
    async (src = sourceRef.current) => {
      setStatus({ kind: 'running' });
      const res = await client.run(src, maxTime);
      if (!res) return; // superseded or stopped
      if (res.ok) lastGood.current = res;
      setStatus({ kind: 'done', res });
    },
    [client, maxTime],
  );

  // On load: a shared link wins over the saved draft. Then run once so the
  // page opens with waveforms instead of an empty panel.
  useEffect(() => {
    void (async () => {
      const shared = await sourceFromHash();
      const src = shared ?? sourceRef.current;
      if (shared) setSource(shared);
      void run(src);
    })();
    // Runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => save(source), 400);
    return () => clearTimeout(t);
  }, [source]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const chooseExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setExampleId(id);
    setSource(ex.source);
    void run(ex.source);
  };

  const share = async () => {
    const url = await shareUrl(source);
    window.history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setToast('Link copied to clipboard');
    } catch {
      setToast('Link is in the address bar');
    }
  };

  const res = status.kind === 'done' ? status.res : null;
  const error = res && !res.ok ? { message: res.message, span: res.span } : null;
  // Keep showing the last good waveform while there's an error, so a typo doesn't blank the viewer.
  const shown = res?.ok ? res : lastGood.current;

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Verilog Sim <span className="muted">in your browser</span>
        </h1>
        <select
          aria-label="Load an example"
          value={exampleId}
          onChange={(e) => chooseExample(e.target.value)}
        >
          <option value="" disabled>
            Examples…
          </option>
          {EXAMPLES.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.name}
            </option>
          ))}
        </select>
        <label className="maxtime" title="Stop the simulation at this time if $finish isn't reached">
          Max time
          <input
            type="number"
            min={1}
            step={1000}
            value={maxTime}
            onChange={(e) => setMaxTime(Math.max(1, Number(e.target.value) || DEFAULT_MAX_TIME))}
          />
        </label>
        <span className="spacer" />
        <button onClick={share} title="Copy a link that contains this code">
          Share
        </button>
        {status.kind === 'running' ? (
          <button className="primary" onClick={() => client.stop()}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => void run()} title="Run (Ctrl+Enter)">
            ▶ Run
          </button>
        )}
      </header>

      <main className="panes">
        <section className="pane editor-pane">
          <Editor value={source} onChange={setSource} onRun={() => void run()} error={error} revealToken={revealToken} />
        </section>
        <section className="pane right-pane">
          <div className="wave-pane">
            {shown ? (
              <Waveform netlist={shown.netlist} result={shown.result} />
            ) : (
              <div className="placeholder">{status.kind === 'running' ? 'Simulating…' : 'Press Run to simulate.'}</div>
            )}
          </div>
          <Console status={status} onJump={() => setRevealToken((n) => n + 1)} />
        </section>
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function Console({ status, onJump }: { status: Status; onJump: () => void }) {
  let header: React.ReactNode = 'Console';
  let body: React.ReactNode = null;
  if (status.kind === 'running') header = 'Running…';
  if (status.kind === 'done') {
    const res = status.res;
    if (res.ok) {
      const why =
        res.result.stopReason === 'finish'
          ? '$finish'
          : res.result.stopReason === 'maxTime'
            ? 'max time reached'
            : 'nothing left to simulate';
      header = (
        <>
          Finished at t={res.result.endTime} ({why}) · {res.netlist.signals.length} signals · {res.ms.toFixed(0)} ms
        </>
      );
      body = res.result.output || <span className="muted">(no $display output)</span>;
    } else {
      header = <span className="err">Error</span>;
      body = (
        <span className="err">
          {res.span ? (
            <button className="link" onClick={onJump} title="Show in editor">
              line {res.span.line}, col {res.span.col}
            </button>
          ) : null}
          {res.span ? ': ' : ''}
          {res.message.replace(/^\d+:\d+: /, '')}
        </span>
      );
    }
  }
  return (
    <div className="console" aria-live="polite">
      <div className="console-head">{header}</div>
      <pre className="console-body">{body}</pre>
    </div>
  );
}
