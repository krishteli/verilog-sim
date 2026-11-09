import { describe, expect, it } from 'vitest';
import { compile, createSession, VerilogError } from '..';

const id = (netlist: ReturnType<typeof compile>, name: string) => netlist.signals.find((s) => s.name === name)!.id;

describe('createSession', () => {
  it('lets the caller act as the testbench: poke inputs, advance time, read outputs', () => {
    const src = `module ff(input clk, input [3:0] d, output reg [3:0] q, output [3:0] inv);
      always @(posedge clk) q <= d;
      assign inv = ~d;
    endmodule`;
    const n = compile(src);
    const s = createSession(n);
    const [clk, d, q, inv] = ['clk', 'd', 'q', 'inv'].map((x) => id(n, `ff.${x}`)) as [number, number, number, number];
    s.poke(clk, 0n);
    s.poke(d, 0xan);
    expect(s.peek(inv)).toBe(0x5n); // combinational: settles within the poke
    expect(s.peek(q)).toBe(0n);
    s.poke(clk, 1n); // posedge, NBA applied before poke returns
    expect(s.peek(q)).toBe(0xan);
  });

  it('advances through #delays and collects $display output', () => {
    const src = `module t; reg [7:0] x = 0;
      always #10 x = x + 1;
      initial #25 $display("x=%0d at %0t", x, $time);
    endmodule`;
    const n = compile(src);
    const s = createSession(n);
    s.advanceTo(30);
    expect(s.time).toBe(30);
    expect(s.peek(id(n, 't.x'))).toBe(3n);
    expect(s.takeOutput()).toBe('x=2 at 25\n');
    expect(s.takeOutput()).toBe('');
  });

  it('stops at $finish', () => {
    const n = compile('module t; initial #5 $finish; endmodule');
    const s = createSession(n);
    s.advanceTo(100);
    expect(s.finished).toBe(true);
    expect(s.time).toBe(5);
  });
});

describe('elaborate options', () => {
  const src = `module dut #(parameter W = 4)(input [W-1:0] a, output [W-1:0] y); assign y = a; endmodule
    module tb; wire [3:0] y; dut d(.a(4'd1), .y(y)); endmodule`;

  it('elaborates a chosen top with parameter overrides', () => {
    const n = compile(src, { top: 'dut', params: { W: 12n } });
    expect(n.tops).toEqual(['dut']);
    expect(n.signals.find((s) => s.name === 'dut.a')!.width).toBe(12);
  });

  it('rejects an unknown top or parameter', () => {
    expect(() => compile(src, { top: 'nope' })).toThrow(VerilogError);
    expect(() => compile(src, { top: 'dut', params: { X: 1n } })).toThrow(/no overridable parameter 'X'/);
  });
});
