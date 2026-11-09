import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '..';
import { exprText } from './exprText';
import { buildSchematic, schematicScopes, type Schematic } from './schematic';

const counter = readFileSync(new URL('../../../tests/golden/counter.v', import.meta.url), 'utf8');

/** Edges as readable "node.port -> node.port" strings. */
function wires(s: Schematic): string[] {
  const where = new Map<string, string>();
  for (const n of s.nodes) {
    const portNode = n.kind === 'input' || n.kind === 'output';
    for (const p of n.ports) where.set(p.id, p.name && !portNode ? `${n.title}.${p.name}` : n.title);
  }
  return s.edges.map((e) => `${where.get(e.from)} -> ${where.get(e.to)}`).sort();
}

describe('buildSchematic', () => {
  it('draws a module: ports, an edge-triggered block, and its feedback loop', () => {
    const s = buildSchematic(compile(counter), 'tb.dut');
    expect(s.module).toBe('counter');
    const seq = s.nodes.find((n) => n.kind === 'seq')!;
    expect(seq.title).toBe('always @(posedge clk)');
    // The clock pin comes first and is marked as an edge.
    expect(seq.ports[0]).toMatchObject({ name: 'clk', dir: 'in', edge: 'posedge' });
    expect(wires(s)).toEqual([
      'always @(posedge clk).q -> always @(posedge clk).q', // q <= q + 1 reads its own output
      'always @(posedge clk).q -> q',
      'clk -> always @(posedge clk).clk',
      'en -> always @(posedge clk).en',
      'rst -> always @(posedge clk).rst',
    ]);
  });

  it('draws a testbench: instances with pins, stimulus blocks, monitors', () => {
    const s = buildSchematic(compile(counter), 'tb');
    const dut = s.nodes.find((n) => n.kind === 'instance')!;
    expect(dut).toMatchObject({ title: 'dut', subtitle: 'counter', instancePath: 'tb.dut' });
    expect(dut.ports.map((p) => `${p.dir} ${p.name}`)).toEqual(['in clk', 'in rst', 'in en', 'out q']);
    const w = wires(s);
    expect(w).toContain('always #5.clk -> dut.clk');
    expect(w).toContain('dut.q -> always @(negedge clk).q');
    expect(w).toContain('initial.rst -> dut.rst');
  });

  it('shows hierarchical probes as extra pins on the instance', () => {
    const src = `module c(input clk); reg [3:0] n = 0; always @(posedge clk) n <= n + 1; endmodule
      module tb; reg clk = 0; c u(.clk(clk)); always #1 clk = ~clk; initial #9 $display("%d", u.n); endmodule`;
    const s = buildSchematic(compile(src), 'tb');
    const u = s.nodes.find((n) => n.title === 'u')!;
    expect(u.ports.find((p) => p.name === 'n')).toMatchObject({ dir: 'out', probe: true });
    expect(wires(s)).toContain('u.n -> initial.u.n');
  });

  it('puts a box between an instance pin and a non-signal connection', () => {
    const src = `module inv(input [3:0] a, output [3:0] y); assign y = ~a; endmodule
      module top(input [3:0] sw, output [3:0] led); inv i(.a(sw ^ 4'd5), .y(led)); endmodule`;
    const s = buildSchematic(compile(src), 'top');
    expect(wires(s)).toEqual(['i.y -> led', 'sw -> sw ^ 4\'d5.sw', "sw ^ 4'd5 -> i.a"]);
    expect(buildSchematic(compile(src), 'top.i').nodes.map((n) => n.title)).toEqual(['a', 'y', 'y = ~a']);
  });

  it('lists every instance as a viewable scope', () => {
    expect(schematicScopes(compile(counter))).toEqual([
      { path: 'tb', module: 'tb', depth: 0 },
      { path: 'tb.dut', module: 'counter', depth: 1 },
    ]);
  });
});

describe('exprText', () => {
  it('prints selects with declared indices and parenthesises nested operators', () => {
    const n = compile(`module m(input [7:0] a, input [0:3] b, output [7:0] y);
      assign y = (a[7:4] + b[1]) & ~a ? a : {b, 4'd3};
    endmodule`);
    const a = n.assigns.find((x) => x.origin === 'assign')!;
    expect(exprText(a.rhs, n.signals, 'm')).toBe("((a[7:4] + b[1]) & ~a) ? a : {b, 4'd3}");
  });

  it('prints part selects with the bits they really select', () => {
    const n = compile(`module m #(parameter N = 6)(input [7:0] a, input [2:0] i, input [8:15] c, output [9:0] y);
      assign y = {a[N-1 -: 2], a[i +: 2], a[i -: 3], a[i], c[i +: 2]};
    endmodule`);
    const a = n.assigns.find((x) => x.origin === 'assign')!;
    expect(exprText(a.rhs, n.signals, 'm')).toBe('{a[5:4], a[i +: 2], a[i - 2 +: 3], a[i], c[i +: 2]}');
  });
});
