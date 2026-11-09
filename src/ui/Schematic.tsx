import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Netlist, Span } from '../core';
import { buildSchematic, schematicScopes, type SchNode, type Schematic as SchGraph } from '../core/schematic/schematic';

/**
 * Schematic view: buildSchematic() decides what to draw, ELK (the Eclipse
 * Layout Kernel, compiled to JS) decides where, and we render the result as
 * SVG.
 *
 * ELK's "layered" algorithm is the Sugiyama method used for most circuit and
 * data-flow diagrams: assign nodes to columns so wires flow left to right,
 * reorder each column to minimise crossings, then route wires orthogonally.
 * We size every box and place its pins ourselves (FIXED_POS), so the labels
 * we draw line up exactly with the pins ELK routes wires to.
 */

type Elk = { layout(graph: ElkNode): Promise<ElkNode> };
let elkPromise: Promise<Elk> | null = null;
/** elkjs is ~1.5 MB, so it's loaded only when the schematic is first opened. */
function loadElk(): Promise<Elk> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elkPromise;
}

const CHAR_W = 7; // approx. width of a 12px monospace character
const HEADER = 22;
const SUBTITLE = 15;
const ROW = 18;
const PORT = 6;

interface Box {
  w: number;
  h: number;
  /** Pin positions relative to the box. */
  pins: Map<string, { x: number; y: number }>;
  /** Y offset of the first pin row. */
  top: number;
}

function measure(n: SchNode): Box {
  const pins = new Map<string, { x: number; y: number }>();
  if (n.kind === 'input' || n.kind === 'output') {
    const label = n.title + (n.subtitle ? ` ${n.subtitle}` : '');
    const w = Math.max(48, label.length * CHAR_W + 26);
    const h = 26;
    const p = n.ports[0]!;
    pins.set(p.id, { x: n.kind === 'input' ? w : 0, y: h / 2 });
    return { w, h, pins, top: 0 };
  }
  const ins = n.ports.filter((p) => p.dir === 'in');
  const outs = n.ports.filter((p) => p.dir === 'out');
  const label = (ps: typeof ins) => Math.max(0, ...ps.map((p) => p.name.length));
  const top = HEADER + (n.subtitle ? SUBTITLE : 0) + 4;
  const rows = Math.max(ins.length, outs.length, n.kind === 'expr' ? 0 : 1);
  const w = Math.max(64, n.title.length * CHAR_W + 20, (label(ins) + label(outs)) * CHAR_W + 40, (n.subtitle?.length ?? 0) * CHAR_W + 20);
  const h = n.kind === 'expr' ? 28 : top + rows * ROW + 4;
  ins.forEach((p, i) => pins.set(p.id, { x: 0, y: n.kind === 'expr' ? h / 2 : top + i * ROW + ROW / 2 }));
  outs.forEach((p, i) => pins.set(p.id, { x: w, y: n.kind === 'expr' ? h / 2 : top + i * ROW + ROW / 2 }));
  return { w, h, pins, top };
}

interface Laid {
  graph: SchGraph;
  boxes: Map<string, Box & { x: number; y: number }>;
  wires: { id: string; d: string; signal: string; width: number }[];
  width: number;
  height: number;
}

async function layout(graph: SchGraph): Promise<Laid> {
  const elk = await loadElk();
  const sizes = new Map(graph.nodes.map((n) => [n.id, measure(n)]));
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      // Lay out unconnected pieces (e.g. `assign dp = 1`) together with the rest,
      // so every input lands in the first column and every output in the last.
      'elk.separateConnectedComponents': 'false',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    children: graph.nodes.map((n) => {
      const b = sizes.get(n.id)!;
      return {
        id: n.id,
        width: b.w,
        height: b.h,
        layoutOptions: {
          'elk.portConstraints': 'FIXED_POS',
          // Module inputs in the first column, outputs in the last, like a datasheet.
          ...(n.kind === 'input' ? { 'elk.layered.layering.layerConstraint': 'FIRST' } : {}),
          ...(n.kind === 'output' ? { 'elk.layered.layering.layerConstraint': 'LAST' } : {}),
        },
        ports: n.ports.map((p) => {
          const pos = b.pins.get(p.id)!;
          return {
            id: p.id,
            width: PORT,
            height: PORT,
            x: pos.x - (p.dir === 'in' ? PORT : 0),
            y: pos.y - PORT / 2,
            layoutOptions: { 'elk.port.side': p.dir === 'in' ? 'WEST' : 'EAST' },
          };
        }),
      };
    }),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const out = await elk.layout(root);
  const boxes = new Map<string, Box & { x: number; y: number }>();
  for (const c of out.children ?? []) boxes.set(c.id, { ...sizes.get(c.id)!, x: c.x ?? 0, y: c.y ?? 0 });
  const byId = new Map(graph.edges.map((e) => [e.id, e]));
  const wires = ((out.edges ?? []) as ElkExtendedEdge[]).map((e) => {
    const info = byId.get(e.id)!;
    const d = (e.sections ?? [])
      .map((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '))
      .join(' ');
    return { id: e.id, d, signal: info.signal, width: info.width };
  });
  return { graph, boxes, wires, width: out.width ?? 0, height: out.height ?? 0 };
}

interface Props {
  netlist: Netlist;
  onReveal: (span: Span) => void;
}

export function Schematic({ netlist, onReveal }: Props) {
  const scopes = useMemo(() => schematicScopes(netlist), [netlist]);
  const [scope, setScope] = useState(scopes[0]?.path ?? '');
  // A new run may not contain the instance we were looking at.
  const current = scopes.some((s) => s.path === scope) ? scope : (scopes[0]?.path ?? '');
  const graph = useMemo(() => (current ? buildSchematic(netlist, current) : null), [netlist, current]);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!graph) return;
    let stale = false;
    layout(graph).then(
      (l) => !stale && (setLaid(l), setError(null)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [graph]);

  const fit = useCallback(() => {
    const el = host.current;
    if (!el || !laid) return;
    const k = Math.min(1.5, el.clientWidth / laid.width, el.clientHeight / laid.height);
    setView({ k, x: (el.clientWidth - laid.width * k) / 2, y: Math.max(0, (el.clientHeight - laid.height * k) / 2) });
  }, [laid]);
  useEffect(fit, [fit]);

  // Wheel zoom around the cursor. A native listener, because React's wheel
  // handler is passive and can't preventDefault the page scroll.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(4, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const shown = laid && laid.graph === graph ? laid : null;
  const parent = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : null;

  const onNode = (n: SchNode) => {
    if (drag.current?.moved) return;
    if (n.instancePath) setScope(n.instancePath);
    else onReveal(n.span);
  };

  return (
    <div className="schematic">
      <div className="wave-toolbar">
        <label className="wave-radix">
          Module
          <select value={current} onChange={(e) => setScope(e.target.value)} aria-label="Instance to show">
            {scopes.map((s) => (
              <option key={s.path} value={s.path}>
                {'  '.repeat(s.depth)}
                {s.path.split('.').pop()} ({s.module})
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => parent && setScope(parent)} disabled={!parent} title="Go to the parent module">
          ↑ Up
        </button>
        <button onClick={fit}>Fit</button>
        <span className="wave-hint">click an instance to open it · click a block to see its code · scroll to zoom, drag to pan</span>
      </div>
      <div
        className="sch-canvas"
        ref={host}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
          d.moved = true;
          setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={() => setTimeout(() => (drag.current = null))}
      >
        {error && <div className="placeholder err">Layout failed: {error}</div>}
        {!shown && !error && <div className="placeholder">Laying out…</div>}
        {shown && (
          <svg width="100%" height="100%" role="img" aria-label={`Schematic of ${current} (${shown.graph.module})`}>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {shown.wires.map((w) => (
                <path
                  key={w.id}
                  d={w.d}
                  className={`sch-wire${w.width > 1 ? ' bus' : ''}${hover === w.signal ? ' hot' : ''}`}
                  onPointerEnter={() => setHover(w.signal)}
                  onPointerLeave={() => setHover(null)}
                >
                  <title>{w.width > 1 ? `${w.signal} [${w.width} bits]` : w.signal}</title>
                </path>
              ))}
              {shown.graph.nodes.map((n) => (
                <NodeView key={n.id} n={n} box={shown.boxes.get(n.id)!} hover={hover} onClick={() => onNode(n)} />
              ))}
            </g>
          </svg>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Partial<Record<SchNode['kind'], string>> = { seq: 'sequential', comb: 'combinational', initial: 'testbench / timed' };

function NodeView({ n, box, hover, onClick }: { n: SchNode; box: Box & { x: number; y: number }; hover: string | null; onClick: () => void }) {
  const { x, y, w, h } = box;
  const title = `${n.kind === 'instance' ? `${n.title}: ${n.subtitle} (click to open)` : n.title}${KIND_LABEL[n.kind] ? ` — ${KIND_LABEL[n.kind]}` : ''}`;
  if (n.kind === 'input' || n.kind === 'output') {
    // Arrow-shaped port flags, pointing in the direction data flows.
    const pts =
      n.kind === 'input'
        ? `0,0 ${w - 10},0 ${w},${h / 2} ${w - 10},${h} 0,${h}`
        : `10,0 ${w},0 ${w},${h} 10,${h} 0,${h / 2}`;
    return (
      <g transform={`translate(${x},${y})`} className={`sch-node ${n.kind}${hover === n.title ? ' hot' : ''}`} onClick={onClick}>
        <title>{`${n.kind} ${n.title}${n.subtitle ? ' ' + n.subtitle : ''}`}</title>
        <polygon points={pts} />
        <text x={n.kind === 'input' ? 8 : 16} y={h / 2 + 4} className="sch-name">
          {n.title}
          {n.subtitle && <tspan className="sch-sub"> {n.subtitle}</tspan>}
        </text>
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y})`} className={`sch-node ${n.kind}`} onClick={onClick}>
      <title>{title}</title>
      <rect width={w} height={h} rx={n.kind === 'expr' ? 12 : 4} />
      {n.kind === 'instance' && <rect className="sch-inner" x={3} y={3} width={w - 6} height={h - 6} rx={2} />}
      <text x={n.kind === 'expr' ? w / 2 : 8} y={n.kind === 'expr' ? h / 2 + 4 : 15} className="sch-title" textAnchor={n.kind === 'expr' ? 'middle' : 'start'}>
        {n.title}
      </text>
      {n.subtitle && (
        <text x={8} y={15 + SUBTITLE} className="sch-sub">
          {n.subtitle}
        </text>
      )}
      {n.kind !== 'expr' && <line x1={0} x2={w} y1={box.top - 4} y2={box.top - 4} className="sch-divider" />}
      {n.kind !== 'expr' &&
        n.ports.map((p) => {
          const pos = box.pins.get(p.id)!;
          const left = p.dir === 'in';
          return (
            <g key={p.id} className={hover === p.name ? 'hot' : undefined}>
              {p.edge ? (
                // The classic clock-input triangle; a bubble in front of it means negedge.
                <>
                  <polyline points={`0,${pos.y - 5} 7,${pos.y} 0,${pos.y + 5}`} className="sch-clock" />
                  {p.edge === 'negedge' && <circle cx={-4} cy={pos.y} r={3} className="sch-bubble" />}
                </>
              ) : null}
              <text x={left ? (p.edge ? 11 : 6) : w - 6} y={pos.y + 4} textAnchor={left ? 'start' : 'end'} className={`sch-pin${p.probe ? ' probe' : ''}`}>
                {p.name}
              </text>
            </g>
          );
        })}
    </g>
  );
}
