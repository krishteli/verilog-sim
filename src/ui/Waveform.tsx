import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Netlist, SimResult, Signal } from '../core';
import { toVcd } from '../core/vcd';
import { formatValue, indexAt, niceStep, RADIX_LABEL, RADIX_ORDER, valueAt, type Radix } from './wave-utils';

const ROW_H = 28;
const AXIS_H = 26;
const NAME_W = 220;

interface Props {
  netlist: Netlist;
  result: SimResult;
}

interface View {
  /** Time at the left edge of the canvas. */
  t0: number;
  /** Zoom: pixels per time unit. */
  scale: number;
}

/**
 * Waveform viewer.
 *
 * Signal names and values are ordinary DOM (selectable, accessible); the
 * traces are drawn on a <canvas>. Canvas suits this part: a few thousand
 * line segments redrawn on every zoom/pan frame would be slow as DOM/SVG
 * nodes, but are cheap as immediate-mode drawing. Each frame only draws the
 * changes inside the visible time window, found by binary search, so cost
 * scales with what's on screen rather than with simulation length.
 */
export function Waveform({ netlist, result }: Props) {
  const signals = netlist.signals;
  const endTime = Math.max(result.endTime, 1);

  const defaultShown = useMemo(() => pickDefaultSignals(netlist), [netlist]);
  const [shown, setShown] = useState<number[]>(defaultShown);
  const [radix, setRadix] = useState<Record<number, Radix>>({});
  const [defaultRadix, setDefaultRadix] = useState<Radix>('hex');
  const [cursor, setCursor] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [view, setView] = useState<View>({ t0: 0, scale: 1 });
  const [width, setWidth] = useState(600);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // New simulation: keep the user's selection by *name* (ids change between
  // runs), falling back to the defaults when nothing carries over.
  const prevSignals = useRef(signals);
  useEffect(() => {
    const old = prevSignals.current;
    prevSignals.current = signals;
    if (old === signals) return;
    setShown((prev) => {
      const names = new Set(prev.map((id) => old[id]?.name));
      const kept = signals.filter((s) => names.has(s.name)).map((s) => s.id);
      return kept.length ? kept : defaultShown;
    });
    setCursor(null);
  }, [signals, defaultShown]);

  // "Fitted" means the user hasn't zoomed or panned since the last fit; then
  // a resize (or the first real measurement of the width) re-fits.
  const fitted = useRef(true);
  const fit = useCallback(() => {
    fitted.current = true;
    setView({ t0: 0, scale: width / endTime });
  }, [width, endTime]);
  useEffect(() => {
    fitted.current = true;
  }, [result]);
  useEffect(() => {
    if (fitted.current) fit();
  }, [fit, result]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(100, el.clientWidth - NAME_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const radixOf = (id: number): Radix => radix[id] ?? (signals[id]!.width === 1 ? 'bin' : defaultRadix);

  // ---- drawing ----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const height = AXIS_H + shown.length * ROW_H;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(canvas);
    const color = (name: string) => css.getPropertyValue(name).trim() || '#888';
    const C = {
      bg: color('--wave-bg'),
      grid: color('--wave-grid'),
      axis: color('--text-muted'),
      trace: color('--wave-trace'),
      bus: color('--wave-bus'),
      busFill: color('--wave-bus-fill'),
      text: color('--text'),
      cursor: color('--accent'),
      after: color('--wave-after'),
    };
    const mono = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const { t0, scale } = view;
    const t1 = t0 + width / scale;
    const x = (t: number) => (t - t0) * scale;

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    // Past the end of simulation: shaded, values are unknown there.
    if (endTime < t1) {
      ctx.fillStyle = C.after;
      ctx.fillRect(Math.max(0, x(endTime)), 0, width, height);
    }

    // Time axis and grid.
    const step = niceStep(scale);
    ctx.font = mono;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.axis;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const px = Math.round(x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, AXIS_H - 6);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.fillText(String(t), px + 3, AXIS_H / 2);
    }

    // Traces.
    shown.forEach((id, row) => {
      const sig = signals[id]!;
      const wave = result.waves[id]!;
      const top = AXIS_H + row * ROW_H + 5;
      const bottom = AXIS_H + (row + 1) * ROW_H - 5;
      const mid = (top + bottom) / 2;
      const tEnd = Math.min(t1, endTime);
      let i = indexAt(wave, t0);

      if (sig.width === 1) {
        ctx.strokeStyle = C.trace;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let y = wave.values[i] ? top : bottom;
        ctx.moveTo(Math.max(0, x(wave.times[i]!)), y);
        for (i = i + 1; i < wave.times.length && wave.times[i]! <= tEnd; i++) {
          const px = x(wave.times[i]!);
          ctx.lineTo(px, y);
          y = wave.values[i] ? top : bottom;
          ctx.lineTo(px, y);
        }
        ctx.lineTo(x(tEnd), y);
        ctx.stroke();
        return;
      }

      // Bus: a hexagon per stable value, labelled when there's room.
      const r = radixOf(id);
      for (; i < wave.times.length && wave.times[i]! < tEnd; i++) {
        const a = Math.max(x(wave.times[i]!), -10);
        const b = Math.min(x(Math.min(wave.times[i + 1] ?? tEnd, tEnd)), width + 10);
        const slant = Math.min(3, (b - a) / 2);
        ctx.beginPath();
        ctx.moveTo(a, mid);
        ctx.lineTo(a + slant, top);
        ctx.lineTo(b - slant, top);
        ctx.lineTo(b, mid);
        ctx.lineTo(b - slant, bottom);
        ctx.lineTo(a + slant, bottom);
        ctx.closePath();
        ctx.fillStyle = C.busFill;
        ctx.fill();
        ctx.strokeStyle = C.bus;
        ctx.lineWidth = 1;
        ctx.stroke();

        const label = formatValue(wave.values[i]!, sig.width, r);
        const visA = Math.max(a, 0) + slant + 3;
        const visB = Math.min(b, width) - slant - 3;
        const tw = ctx.measureText(label).width;
        if (visB - visA >= tw) {
          ctx.fillStyle = C.text;
          ctx.fillText(label, (visA + visB - tw) / 2, mid + 0.5);
        } else if (visB - visA > 14) {
          ctx.fillStyle = C.text;
          ctx.save();
          ctx.beginPath();
          ctx.rect(visA, top, visB - visA, bottom - top);
          ctx.clip();
          ctx.fillText(label, visA, mid + 0.5);
          ctx.restore();
        }
      }
    });

    // Cursor.
    if (cursor !== null && cursor >= t0 && cursor <= t1) {
      const px = Math.round(x(cursor)) + 0.5;
      ctx.strokeStyle = C.cursor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      const label = String(cursor);
      const tw = ctx.measureText(label).width + 8;
      const lx = Math.min(px + 1, width - tw);
      ctx.fillStyle = C.cursor;
      ctx.fillRect(lx, 2, tw, AXIS_H - 8);
      ctx.fillStyle = C.bg;
      ctx.fillText(label, lx + 4, AXIS_H / 2 - 1);
    }
    // radixOf depends on radix/defaultRadix, listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, width, shown, result, cursor, radix, defaultRadix, signals, endTime]);

  // ---- interaction ------------------------------------------------------------------
  const zoomAt = useCallback(
    (factor: number, px: number) => {
      fitted.current = false;
      setView((v) => {
        const minScale = (width / endTime) * 0.5;
        const scale = Math.min(Math.max(v.scale * factor, minScale), 200);
        const tAt = v.t0 + px / v.scale; // keep the time under the pointer fixed
        return { scale, t0: clampT0(tAt - px / scale, scale) };
      });
    },
    [width, endTime],
  );

  const clampT0 = (t0: number, scale: number) => Math.min(Math.max(t0, 0), Math.max(0, endTime - (width / scale) * 0.9));

  // Wheel: ctrl/cmd (and trackpad pinch) zooms, horizontal or shift scroll pans.
  // Registered manually because React's onWheel is passive and can't preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const px = e.offsetX;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.002), px);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = e.shiftKey ? e.deltaY : e.deltaX;
        fitted.current = false;
        setView((v) => ({ ...v, t0: clampT0(v.t0 + d / v.scale, v.scale) }));
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  });

  const drag = useRef<{ x: number; t0: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, t0: view.t0, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    if (d.moved) fitted.current = false;
    if (d.moved) setView((v) => ({ ...v, t0: clampT0(d.t0 - dx / v.scale, v.scale) }));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const rect = e.currentTarget.getBoundingClientRect();
      const t = Math.round(view.t0 + (e.clientX - rect.left) / view.scale);
      setCursor(Math.min(Math.max(t, 0), result.endTime));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '+' || e.key === '=') zoomAt(1.5, width / 2);
    else if (e.key === '-') zoomAt(1 / 1.5, width / 2);
    else if (e.key === 'f') fit();
    else if (e.key === 'ArrowLeft') setView((v) => ({ ...v, t0: clampT0(v.t0 - (width / v.scale) * 0.2, v.scale) }));
    else if (e.key === 'ArrowRight') setView((v) => ({ ...v, t0: clampT0(v.t0 + (width / v.scale) * 0.2, v.scale) }));
    else return;
    e.preventDefault();
  };

  const cycleRadix = (id: number) => {
    const next = RADIX_ORDER[(RADIX_ORDER.indexOf(radixOf(id)) + 1) % RADIX_ORDER.length]!;
    setRadix((r) => ({ ...r, [id]: next }));
  };

  const downloadVcd = () => {
    const blob = new Blob([toVcd(netlist, result)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${netlist.tops[0] ?? 'sim'}.vcd`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const cursorT = cursor ?? result.endTime;

  return (
    <div className="wave">
      <div className="wave-toolbar" role="toolbar" aria-label="Waveform controls">
        <button onClick={() => zoomAt(1.5, width / 2)} title="Zoom in (+, or Ctrl+scroll)">
          +
        </button>
        <button onClick={() => zoomAt(1 / 1.5, width / 2)} title="Zoom out (-)">
          −
        </button>
        <button onClick={fit} title="Fit whole simulation (f)">
          Fit
        </button>
        <label className="wave-radix">
          Radix
          <select value={defaultRadix} onChange={(e) => setDefaultRadix(e.target.value as Radix)}>
            {RADIX_ORDER.map((r) => (
              <option key={r} value={r}>
                {RADIX_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setPicker((p) => !p)} aria-expanded={picker}>
          Signals ({shown.length}/{signals.length})
        </button>
        <span className="spacer" />
        <span className="wave-hint">drag to pan · ctrl+scroll to zoom · click to place cursor</span>
        <button onClick={downloadVcd} title="Download a VCD file for GTKWave or Surfer">
          Export VCD
        </button>
      </div>

      {picker && <SignalPicker signals={signals} shown={shown} onChange={setShown} />}

      <div className="wave-body" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Waveforms">
        <div className="wave-names" style={{ width: NAME_W }}>
          <div className="wave-names-head" style={{ height: AXIS_H }}>
            {cursor === null ? `values at end (t=${result.endTime})` : `values at t=${cursor}`}
          </div>
          {shown.map((id) => {
            const s = signals[id]!;
            return (
              <div className="wave-name" key={id} style={{ height: ROW_H }} title={`${s.name}${rangeText(s)}`}>
                <span className="wave-sig">{displayName(s, netlist)}</span>
                <span className="wave-val">{formatValue(valueAt(result.waves[id]!, cursorT), s.width, radixOf(id))}</span>
                {s.width > 1 ? (
                  <button className="wave-rbtn" onClick={() => cycleRadix(id)} title="Change radix">
                    {RADIX_LABEL[radixOf(id)]}
                  </button>
                ) : (
                  <span className="wave-rbtn placeholder" />
                )}
              </div>
            );
          })}
          {shown.length === 0 && <div className="wave-empty">No signals selected.</div>}
        </div>
        <canvas
          ref={canvasRef}
          className="wave-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
    </div>
  );
}

function SignalPicker({ signals, shown, onChange }: { signals: Signal[]; shown: number[]; onChange: (ids: number[]) => void }) {
  const byScope = useMemo(() => {
    const m = new Map<string, Signal[]>();
    for (const s of signals) {
      const list = m.get(s.scope) ?? [];
      list.push(s);
      m.set(s.scope, list);
    }
    return [...m.entries()];
  }, [signals]);
  const set = new Set(shown);
  const toggle = (id: number) => onChange(set.has(id) ? shown.filter((x) => x !== id) : [...shown, id]);
  const setScope = (ids: number[], on: boolean) =>
    onChange(on ? [...shown, ...ids.filter((id) => !set.has(id))] : shown.filter((id) => !ids.includes(id)));

  return (
    <div className="picker">
      {byScope.map(([scope, list]) => (
        <fieldset key={scope}>
          <legend>
            {scope}
            <button onClick={() => setScope(list.map((s) => s.id), true)}>all</button>
            <button onClick={() => setScope(list.map((s) => s.id), false)}>none</button>
          </legend>
          {list.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={set.has(s.id)} onChange={() => toggle(s.id)} />
              {s.local}
              <span className="muted">{rangeText(s)}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function rangeText(s: Signal): string {
  return s.width > 1 ? ` [${s.msb}:${s.lsb}]` : '';
}

/** Top-level signals by local name; deeper ones relative to the top (`dut.q`). */
function displayName(s: Signal, netlist: Netlist): string {
  const top = netlist.tops.find((t) => s.name.startsWith(t + '.'));
  return top && netlist.tops.length === 1 ? s.name.slice(top.length + 1) : s.name;
}

/** Start with the top module's own signals (the testbench view); fall back to everything. */
function pickDefaultSignals(netlist: Netlist): number[] {
  const top = netlist.signals.filter((s) => netlist.tops.includes(s.scope));
  const list = top.length ? top : netlist.signals;
  return list.slice(0, 40).map((s) => s.id);
}
