import { useCallback, useEffect, useRef, useState } from 'react';
import type { Span } from '../core';
import { BUTTONS, type BoardSnapshot, type BoardTopInfo, type ButtonName } from '../core/board/basys3';
import type { BoardRequest, BoardResponse } from './boardTypes';

/**
 * The virtual Basys 3. The design runs in board.worker.ts; this component
 * only sends inputs (switch flips, button presses) and paints the snapshot
 * the worker posts each frame.
 */

const SPEEDS: { hz: number; label: string }[] = [
  { hz: 1, label: '1 Hz' },
  { hz: 10, label: '10 Hz' },
  { hz: 1_000, label: '1 kHz' },
  { hz: 10_000, label: '10 kHz' },
  { hz: 100_000, label: '100 kHz' },
  { hz: 1_000_000, label: '1 MHz' },
  { hz: 0, label: 'Max' },
];
const DEFAULT_HZ = 100_000;
const MAX_LOG = 20_000;

type Status =
  | { kind: 'starting' }
  | { kind: 'running'; top: BoardTopInfo; used: Set<string>; unconnected: string[] }
  | { kind: 'noTop' }
  | { kind: 'error'; message: string; span: Span | null };

interface Props {
  source: string;
  /** Bumped by the parent (Run button, Ctrl+Enter) to restart with the current source. */
  runToken: number;
  params: Record<string, string>;
  onParamsChange: (params: Record<string, string>) => void;
  /** Lets the editor underline errors found when starting the board. */
  onError: (err: { message: string; span: Span | null } | null) => void;
  onLoadDemo: () => void;
}

export function BoardPanel({ source, runToken, params, onParamsChange, onError, onLoadDemo }: Props) {
  const worker = useRef<Worker | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'starting' });
  const [snap, setSnap] = useState<BoardSnapshot | null>(null);
  const [rate, setRate] = useState(0);
  const [hz, setHz] = useState(DEFAULT_HZ);
  const [paused, setPaused] = useState(false);
  const [switches, setSwitches] = useState(0);
  const [pressed, setPressed] = useState<ReadonlySet<ButtonName>>(new Set());
  const [log, setLog] = useState('');
  // Latest values for the start() callback without making it re-create.
  const latest = useRef({ source, params, hz, switches, onError });
  latest.current = { source, params, hz, switches, onError };

  const send = (msg: BoardRequest) => worker.current?.postMessage(msg);

  const start = useCallback(() => {
    // A fresh worker per run: the simplest way to guarantee no state leaks
    // from the previous design (and to stop a runaway one).
    worker.current?.terminate();
    const w = new Worker(new URL('./board.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setStatus({ kind: 'starting' });
    setSnap(null);
    setLog('');
    setPaused(false);
    setPressed(new Set());
    w.onmessage = (e: MessageEvent<BoardResponse>) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        setSnap(msg.snapshot);
        setRate(msg.rate);
        if (msg.snapshot.output) setLog((l) => (l + msg.snapshot.output).slice(-MAX_LOG));
      } else if (msg.type === 'ready') {
        setStatus({ kind: 'running', top: msg.top, used: new Set(msg.used), unconnected: msg.unconnected });
        latest.current.onError(null);
      } else if (msg.type === 'noBoardTop') {
        setStatus({ kind: 'noTop' });
        latest.current.onError(null);
      } else {
        setStatus({ kind: 'error', message: msg.message, span: msg.span });
        latest.current.onError(msg.span ? { message: msg.message, span: msg.span } : null);
      }
    };
    const { source: src, params: p, hz: speed, switches: sw } = latest.current;
    w.postMessage({ type: 'start', source: src, params: p, hz: speed, switches: sw } satisfies BoardRequest);
  }, []);

  useEffect(() => {
    start();
  }, [start, runToken]);

  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
    },
    [],
  );

  const flip = (i: number) => {
    const on = !(switches & (1 << i));
    setSwitches((s) => (on ? s | (1 << i) : s & ~(1 << i)));
    send({ type: 'switch', index: i, on });
  };

  const press = (name: ButtonName, down: boolean) => {
    setPressed((p) => {
      if (p.has(name) === down) return p;
      const next = new Set(p);
      if (down) next.add(name);
      else next.delete(name);
      return next;
    });
    send({ type: 'button', name, down });
  };

  const used = status.kind === 'running' ? status.used : null;
  const isUsed = (pin: string) => !used || used.has(pin);

  return (
    <div className="board-panel">
      <div className="board-toolbar">
        <BoardStatus status={status} snap={snap} rate={rate} hz={hz} paused={paused} />
        <span className="spacer" />
        <label className="wave-radix">
          Clock
          <select
            value={hz}
            onChange={(e) => {
              const v = Number(e.target.value);
              setHz(v);
              send({ type: 'speed', hz: v });
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s.hz} value={s.hz}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            setPaused(!paused);
            send({ type: 'pause', paused: !paused });
          }}
          disabled={status.kind !== 'running'}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={start} title="Restart the design from time 0 (keeps switch positions)">
          Restart
        </button>
      </div>

      <div className="board-scroll">
        {status.kind === 'noTop' && (
          <div className="board-note">
            <p>
              No module here has ports named like Basys 3 pins (<code>clk</code>, <code>sw</code>, <code>led</code>,{' '}
              <code>seg</code>, <code>an</code>, <code>dp</code>, <code>btnC</code>…). Name your top module’s ports to
              match <code>boards/basys3/basys3.xdc</code> and it will appear on the board.
            </p>
            <button onClick={onLoadDemo}>Load the Basys 3 demo</button>
          </div>
        )}
        {status.kind === 'error' && (
          <div className="board-note err" role="alert">
            {status.span ? `line ${status.span.line}, col ${status.span.col}: ` : ''}
            {status.message.replace(/^\d+:\d+: /, '')}
          </div>
        )}

        <div className="board" aria-label="Virtual Basys 3 board">
          <div className="board-top">
            <div className={`sevenseg${isUsed('an') ? '' : ' unused'}`} aria-label={`Display: ${describeDisplay(snap)}`}>
              {[3, 2, 1, 0].map((d) => (
                <Digit key={d} seg={snap?.digits[d] ?? ZERO_DIGIT} />
              ))}
            </div>
            <div className="dpad" role="group" aria-label="Push buttons">
              {BUTTONS.map((b) => (
                <PushButton key={b} name={b} down={pressed.has(b)} unused={!isUsed(b)} onPress={press} />
              ))}
            </div>
          </div>

          <div className={`led-row${isUsed('led') ? '' : ' unused'}`} role="group" aria-label="LEDs">
            {LEFT_TO_RIGHT.map((i) => {
              const b = snap?.leds[i] ?? 0;
              return (
                <div key={i} className="led-cell">
                  <span className="led" style={{ '--b': b } as React.CSSProperties} aria-label={`LD${i} ${b > 0.5 ? 'on' : 'off'}`} />
                  <span className="pin-label">LD{i}</span>
                </div>
              );
            })}
          </div>

          <div className={`switch-row${isUsed('sw') ? '' : ' unused'}`} role="group" aria-label="Switches">
            {LEFT_TO_RIGHT.map((i) => {
              const on = (switches & (1 << i)) !== 0;
              return (
                <div key={i} className="switch-cell">
                  <button role="switch" aria-checked={on} aria-label={`SW${i}`} className={`slide${on ? ' on' : ''}`} onClick={() => flip(i)}>
                    <span className="knob" />
                  </button>
                  <span className="pin-label">SW{i}</span>
                </div>
              );
            })}
          </div>
        </div>

        {status.kind === 'running' && (
          <BoardSettings top={status.top} unconnected={status.unconnected} params={params} onParamsChange={onParamsChange} onApply={start} />
        )}

        {log && (
          <details className="board-log" open>
            <summary>$display output</summary>
            <pre>{log}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** Board order: LD15/SW15 on the left, LD0/SW0 on the right. */
const LEFT_TO_RIGHT = Array.from({ length: 16 }, (_, k) => 15 - k);
const ZERO_DIGIT = [0, 0, 0, 0, 0, 0, 0, 0];

function BoardStatus({ status, snap, rate, hz, paused }: { status: Status; snap: BoardSnapshot | null; rate: number; hz: number; paused: boolean }) {
  if (status.kind === 'starting') return <span className="muted">Starting…</span>;
  if (status.kind === 'noTop') return <span className="muted">No board design found</span>;
  if (status.kind === 'error') return <span className="err">Error</span>;
  const behind = hz !== 0 && !paused && rate > 0 && rate < hz * 0.8;
  return (
    <span className="board-status">
      <code>{status.top.name}</code>
      <span className="muted">
        {snap?.finished ? ' · $finish reached' : paused ? ' · paused' : ` · ${formatHz(rate)}`}
        {behind ? ' (can’t keep up)' : ''}
      </span>
    </span>
  );
}

function BoardSettings({
  top,
  unconnected,
  params,
  onParamsChange,
  onApply,
}: {
  top: BoardTopInfo;
  unconnected: string[];
  params: Record<string, string>;
  onParamsChange: (p: Record<string, string>) => void;
  onApply: () => void;
}) {
  return (
    <div className="board-settings">
      <p className="muted">
        The real board’s clock is 100 MHz; here it runs at the rate you pick above, so a design that counts 100,000,000
        cycles per second will look slower. Shrink time constants by overriding parameters, the same way a testbench
        does with <code>#(...)</code>.
      </p>
      {top.params.length > 0 && (
        <form
          className="param-grid"
          onSubmit={(e) => {
            e.preventDefault();
            onApply();
          }}
        >
          {top.params.map((p) => (
            <label key={p.name}>
              <code>{p.name}</code>
              <input
                value={params[p.name] ?? ''}
                placeholder={p.defaultText}
                inputMode="numeric"
                onChange={(e) => onParamsChange({ ...params, [p.name]: e.target.value })}
              />
            </label>
          ))}
          <button type="submit">Apply</button>
        </form>
      )}
      {unconnected.length > 0 && (
        <p className="muted">
          Not Basys 3 pins, held at 0: {unconnected.map((n) => <code key={n}>{n} </code>)}
        </p>
      )}
    </div>
  );
}

function formatHz(r: number): string {
  if (r >= 1e6) return `${(r / 1e6).toFixed(2)} MHz`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(1)} kHz`;
  return `${r.toFixed(r < 10 ? 1 : 0)} Hz`;
}

const HEX: Record<string, string> = {
  '1111110': '0', '0110000': '1', '1101101': '2', '1111001': '3', '0110011': '4', '1011011': '5', '1011111': '6',
  '1110000': '7', '1111111': '8', '1111011': '9', '1110111': 'A', '0011111': 'b', '1001110': 'C', '0111101': 'd',
  '1001111': 'E', '1000111': 'F', '0000000': ' ',
};

/** Screen-reader text for the display, e.g. "00A3". */
function describeDisplay(snap: BoardSnapshot | null): string {
  if (!snap) return 'off';
  return [3, 2, 1, 0].map((d) => HEX[snap.digits[d]!.slice(0, 7).map((b) => (b > 0.5 ? '1' : '0')).join('')] ?? '?').join('');
}

// Segment outlines a..g in a 58x94 box: hexagonal bars like a real display.
const H = (x1: number, x2: number, y: number) => `${x1},${y + 4} ${x1 + 4},${y} ${x2 - 4},${y} ${x2},${y + 4} ${x2 - 4},${y + 8} ${x1 + 4},${y + 8}`;
const V = (x: number, y1: number, y2: number) => `${x + 4},${y1} ${x + 8},${y1 + 4} ${x + 8},${y2 - 4} ${x + 4},${y2} ${x},${y2 - 4} ${x},${y1 + 4}`;
const SEGMENTS = [H(8, 46, 2), V(41, 7, 46), V(41, 46, 85), H(8, 46, 82), V(3, 46, 85), V(3, 7, 46), H(8, 46, 42)];

function Digit({ seg }: { seg: number[] }) {
  return (
    <svg className="digit" viewBox="0 0 58 94" aria-hidden="true">
      {SEGMENTS.map((points, k) => (
        <polygon key={k} points={points} className="segment" style={{ '--b': seg[k] ?? 0 } as React.CSSProperties} />
      ))}
      <circle cx="53" cy="88" r="3.5" className="segment" style={{ '--b': seg[7] ?? 0 } as React.CSSProperties} />
    </svg>
  );
}

const BUTTON_LABEL: Record<ButtonName, string> = { btnU: 'U', btnL: 'L', btnC: 'C', btnR: 'R', btnD: 'D' };

function PushButton({ name, down, unused, onPress }: { name: ButtonName; down: boolean; unused: boolean; onPress: (n: ButtonName, d: boolean) => void }) {
  // Momentary: pressed only while held, by pointer or keyboard (Space/Enter).
  return (
    <button
      className={`pushbtn ${name}${down ? ' down' : ''}${unused ? ' unused' : ''}`}
      aria-label={name}
      aria-pressed={down}
      title={`${name}${unused ? ' (not used by this design)' : ' (hold)'}`}
      onPointerDown={(e) => {
        onPress(name, true);
        // Capture so the release is seen even if the pointer slides off the button.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Not every pointer can be captured; the press still counts.
        }
      }}
      onPointerUp={() => onPress(name, false)}
      onPointerCancel={() => onPress(name, false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          onPress(name, true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') onPress(name, false);
      }}
      onBlur={() => down && onPress(name, false)}
    >
      {BUTTON_LABEL[name]}
    </button>
  );
}
