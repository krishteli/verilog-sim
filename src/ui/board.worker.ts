/**
 * Runs the virtual Basys 3 off the main thread.
 *
 * The loop is time-sliced: every ~16 ms it simulates as many clock cycles
 * as the target rate calls for (or as many as fit in ~12 ms at "max"), then
 * posts one snapshot of the board for the UI to paint. Yielding between
 * slices (setTimeout) is what lets switch and button messages from the page
 * arrive while the design keeps running.
 */
import { compile, createSession, parse, VerilogError } from '../core';
import { Basys3, findBoardTop } from '../core/board/basys3';
import type { BoardRequest, BoardResponse } from './boardTypes';

const FRAME_MS = 16;
const BUDGET_MS = 12;

let board: Basys3 | null = null;
let hz = 100_000;
let paused = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let last = 0;
/** Fractional cycles owed from previous frames, for slow clock rates like 1 Hz. */
let carry = 0;
/** Recent (time, cycles) points for measuring the achieved clock rate over ~1 s. */
let history: { t: number; cycles: number }[] = [];

const post = (msg: BoardResponse) => self.postMessage(msg);

/** A bad value typed into a parameter box: not tied to a place in the source. */
class ParamError extends Error {}

function fail(err: unknown): void {
  board = null;
  if (timer) clearTimeout(timer);
  if (err instanceof VerilogError) post({ type: 'error', message: err.message, span: err.span });
  else if (err instanceof ParamError) post({ type: 'error', message: err.message, span: null });
  else post({ type: 'error', message: `internal error: ${(err as Error).message}`, span: null });
}

function parseParam(name: string, text: string): bigint {
  const t = text.trim().replace(/_/g, '');
  if (!/^-?\d+$/.test(t)) throw new ParamError(`parameter ${name}: '${text}' is not a whole number`);
  return BigInt(t);
}

function start(req: Extract<BoardRequest, { type: 'start' }>): void {
  if (timer) clearTimeout(timer);
  board = null;
  try {
    const file = parse(req.source);
    const top = findBoardTop(file, req.source);
    if (!top) {
      post({ type: 'noBoardTop' });
      return;
    }
    const params: Record<string, bigint> = {};
    for (const p of top.params) {
      const text = req.params[p.name];
      if (text !== undefined && text.trim() !== '') params[p.name] = parseParam(p.name, text);
    }
    const netlist = compile(req.source, { top: top.name, params });
    const b = new Basys3(createSession(netlist), netlist, top.name);
    for (let i = 0; i < 16; i++) if (req.switches & (1 << i)) b.setSwitch(i, true);
    board = b;
    hz = req.hz;
    carry = 0;
    history = [];
    last = performance.now();
    post({ type: 'ready', top, used: [...b.used], unconnected: b.unconnected });
    timer = setTimeout(tick, 0);
  } catch (err) {
    fail(err);
  }
}

function tick(): void {
  const b = board;
  if (!b) return;
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  try {
    if (!paused) {
      let todo = hz === 0 ? Infinity : hz * dt + carry;
      const deadline = now + BUDGET_MS;
      let done = 0;
      // Run in small chunks and check the clock between them, so a heavy
      // design can't blow the frame budget.
      while (todo - done >= 1 && performance.now() < deadline) {
        const n = Math.min(Math.floor(todo - done), hz === 0 ? 2000 : 500);
        b.runCycles(n);
        done += n;
      }
      // If we couldn't keep up, drop the backlog instead of trying to catch up forever.
      carry = hz === 0 || todo - done >= 1 ? 0 : todo - done;
    }
    const snapshot = b.snapshot();
    history.push({ t: now, cycles: snapshot.cycles });
    while (history.length > 2 && now - history[0]!.t > 1000) history.shift();
    const first = history[0]!;
    const rate = now > first.t ? ((snapshot.cycles - first.cycles) * 1000) / (now - first.t) : 0;
    post({ type: 'frame', snapshot, rate: paused ? 0 : rate });
    if (snapshot.finished) return; // $finish: stop the loop, keep the last picture
  } catch (err) {
    fail(err);
    return;
  }
  timer = setTimeout(tick, Math.max(0, FRAME_MS - (performance.now() - now)));
}

self.onmessage = (event: MessageEvent<BoardRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'start':
      start(msg);
      break;
    case 'switch':
      board?.setSwitch(msg.index, msg.on);
      break;
    case 'button':
      board?.setButton(msg.name, msg.down);
      break;
    case 'speed':
      hz = msg.hz;
      carry = 0;
      history = [];
      break;
    case 'pause':
      paused = msg.paused;
      history = [];
      break;
  }
};
