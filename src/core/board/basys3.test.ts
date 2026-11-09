import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, createSession, parse } from '..';
import { Basys3, findBoardTop } from './basys3';

const demo =
  readFileSync(new URL('../../../boards/basys3/basys3_top.v', import.meta.url), 'utf8') +
  readFileSync(new URL('../../../boards/basys3/tb_basys3_top.v', import.meta.url), 'utf8');

/** Decode a digit's segment brightnesses back into a hex character. */
const SEGS: Record<string, string> = {
  '1111110': '0', '0110000': '1', '1101101': '2', '1111001': '3', '0110011': '4', '1011011': '5', '1011111': '6',
  '1110000': '7', '1111111': '8', '1111011': '9', '1110111': 'A', '0011111': 'b', '1001110': 'C', '0111101': 'd',
  '1001111': 'E', '1000111': 'F',
};
const show = (digits: number[][]) =>
  [...digits]
    .reverse() // digits[0] is the rightmost
    .map((d) => SEGS[d.slice(0, 7).map((b) => (b > 0.5 ? '1' : '0')).join('')] ?? '?')
    .join('');

function board(source: string, params: Record<string, bigint> = {}) {
  const top = findBoardTop(parse(source), source)!;
  const netlist = compile(source, { top: top.name, params });
  return new Basys3(createSession(netlist), netlist, top.name);
}

describe('findBoardTop', () => {
  it('picks the design, not its testbench, and lists its parameters', () => {
    const top = findBoardTop(parse(demo), demo);
    expect(top).toEqual({
      name: 'basys3_top',
      params: [
        { name: 'TICK', defaultText: '100_000_000' },
        { name: 'REFRESH_BITS', defaultText: '18' },
      ],
    });
  });

  it('returns null when no module has board-named ports', () => {
    const src = 'module m(input a, output b); assign b = a; endmodule';
    expect(findBoardTop(parse(src), src)).toBeNull();
  });
});

describe('Basys3', () => {
  it('switches drive LEDs through the design', () => {
    const b = board('module top(input [15:0] sw, output [15:0] led); assign led = ~sw; endmodule');
    b.setSwitch(0, true);
    b.setSwitch(5, true);
    b.runCycles(1);
    const { leds } = b.snapshot();
    expect(leds[0]).toBe(0);
    expect(leds[5]).toBe(0);
    expect(leds[1]).toBe(1);
  });

  it('measures PWM duty cycle as LED brightness', () => {
    const b = board(`module top(input clk, output [15:0] led);
      reg [1:0] n = 0;
      always @(posedge clk) n <= n + 1;
      assign led = {15'b0, n == 0};
    endmodule`);
    b.runCycles(400);
    expect(b.snapshot().leds[0]).toBeCloseTo(0.25, 2);
  });

  it('runs the demo: multiplexed hex counter, reset and pause buttons', () => {
    // Count every 64 cycles; with REFRESH_BITS=3 the display scans all 4 digits every 8.
    const b = board(demo, { TICK: 64n, REFRESH_BITS: 3n });
    /** Look at the display for exactly one scan, like a camera with a short exposure. */
    const look = () => {
      b.snapshot();
      b.runCycles(8);
      return show(b.snapshot().digits);
    };
    b.runCycles(64 * 0x12 + 20);
    expect(look()).toBe('0012');

    b.setButton('btnU', true); // hold to pause
    b.runCycles(300);
    expect(look()).toBe('0012');
    b.setButton('btnU', false);

    b.setButton('btnC', true); // reset
    b.runCycles(16);
    expect(look()).toBe('0000');
  });

  it('reports design inputs that are not board pins', () => {
    const b = board('module top(input clk, input go, output [15:0] led); assign led = {16{go}}; endmodule');
    expect(b.unconnected).toEqual(['go']);
    expect(b.used.has('clk')).toBe(true);
    expect(b.used.has('sw')).toBe(false);
  });
});
