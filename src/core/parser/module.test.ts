import { describe, expect, it } from 'vitest';
import type * as A from './ast';
import { parse } from './parser';
import { expectVerilogError, sexpr } from './test-utils';

function onlyModule(src: string): A.ModuleDecl {
  const file = parse(src);
  expect(file.modules).toHaveLength(1);
  return file.modules[0]!;
}

function portSummary(m: A.ModuleDecl): string[] {
  return m.ports.map((p) => {
    const range = p.range ? `[${sexpr(p.range.msb)}:${sexpr(p.range.lsb)}]` : '';
    return `${p.direction} ${p.netType}${p.signed ? ' signed' : ''}${range} ${p.name}`;
  });
}

describe('parser: module headers', () => {
  it('parses an empty file', () => {
    expect(parse('  // nothing\n').modules).toEqual([]);
  });

  it('parses a module with no port list (testbench style)', () => {
    const m = onlyModule('module tb; endmodule');
    expect(m.name).toBe('tb');
    expect(m.ports).toEqual([]);
  });

  it('parses an empty port list', () => {
    expect(onlyModule('module m(); endmodule').ports).toEqual([]);
  });

  it('parses ANSI ports with types, signedness and widths', () => {
    const m = onlyModule(`
      module alu(input wire [7:0] a, input signed [3:0] b, output reg [7:0] y, inout io);
      endmodule`);
    expect(portSummary(m)).toEqual([
      'input wire[7:0] a',
      'input wire signed[3:0] b',
      'output reg[7:0] y',
      'inout wire io',
    ]);
  });

  it('lets bare names inherit the previous port declaration', () => {
    const m = onlyModule('module m(input [3:0] a, b, output y, z); endmodule');
    expect(portSummary(m)).toEqual(['input wire[3:0] a', 'input wire[3:0] b', 'output wire y', 'output wire z']);
  });

  it('parses leading-comma style port lists', () => {
    const m = onlyModule(`
      module m
        ( input  wire       clk
        , input  wire       rst
        , output reg  [3:0] q
        );
      endmodule`);
    expect(portSummary(m)).toEqual(['input wire clk', 'input wire rst', 'output reg[3:0] q']);
  });

  it('parses a parameter header and uses parameters in widths', () => {
    const m = onlyModule('module m #(parameter W = 8, D = 2, parameter [3:0] K = 4\'d3) (input [W-1:0] a); endmodule');
    expect(m.params.map((p) => [p.assignments[0]!.name, sexpr(p.assignments[0]!.value)])).toEqual([
      ['W', '8'],
      ['D', '2'],
      ['K', "4'3"],
    ]);
    expect(portSummary(m)).toEqual(['input wire[(- W 1):0] a']);
  });

  it('parses several modules in one file', () => {
    expect(parse('module a; endmodule\nmodule b; endmodule').modules.map((m) => m.name)).toEqual(['a', 'b']);
  });
});

describe('parser: module header errors', () => {
  it('rejects non-ANSI port lists with a helpful message', () => {
    const err = expectVerilogError(() => parse('module m(a, b);\n input a;\nendmodule'));
    expect(err.message).toMatch(/non-ANSI port lists are not supported/);
    expect(err.span).toMatchObject({ line: 1, col: 10 });
  });

  it('rejects body-level port declarations', () => {
    expect(expectVerilogError(() => parse('module m(); input a; endmodule')).message).toMatch(/belong in the module header/);
  });

  it("rejects 'input reg'", () => {
    expect(expectVerilogError(() => parse('module m(input reg a); endmodule')).message).toMatch(/input port cannot be declared 'reg'/);
  });

  it('rejects keywords used as names', () => {
    expect(expectVerilogError(() => parse('module m(input begin); endmodule')).message).toMatch(/'begin' is a reserved keyword/);
  });

  it('reports a missing endmodule at end of file', () => {
    const err = expectVerilogError(() => parse('module m;\n wire a;\n'));
    expect(err.message).toMatch(/expected 'endmodule' to close module 'm', but found end of file/);
  });

  it('suggests a missing endmodule when modules appear nested', () => {
    expect(expectVerilogError(() => parse('module a;\nmodule b; endmodule')).message).toMatch(/forget 'endmodule'/);
  });

  it('requires default values for parameters', () => {
    expect(expectVerilogError(() => parse('module m #(parameter W) (); endmodule')).message).toMatch(/need a default value/);
  });
});

describe('parser: declarations and assigns', () => {
  it('parses wire/reg/integer declarations with ranges and initializers', () => {
    const m = onlyModule("module m; wire [7:0] a, b; reg signed [3:0] r = 4'd1; integer i; endmodule");
    const [w, r, i] = m.items as A.NetDecl[];
    expect(w!.declarators.map((d) => d.name)).toEqual(['a', 'b']);
    expect(w!.range && sexpr(w!.range.msb)).toBe('7');
    expect(r).toMatchObject({ netType: 'reg', signed: true });
    expect(r!.declarators[0]!.init && sexpr(r!.declarators[0]!.init)).toBe("4'1");
    expect(i).toMatchObject({ netType: 'integer', range: null });
  });

  it('parses parameter and localparam declarations in the body', () => {
    const m = onlyModule('module m; localparam IDLE = 0, RUN = 1; parameter N = 4; endmodule');
    const [lp, p] = m.items as A.ParamDecl[];
    expect(lp).toMatchObject({ local: true });
    expect(lp!.assignments.map((a) => a.name)).toEqual(['IDLE', 'RUN']);
    expect(p).toMatchObject({ local: false });
  });

  it('parses continuous assignments, including several in one statement', () => {
    const m = onlyModule('module m; assign y = a & b, z = ~a; assign {c, s} = a + b; endmodule');
    const [a1, a2] = m.items as A.ContinuousAssign[];
    expect(a1!.assignments.map((a) => `${sexpr(a.lhs)}=${sexpr(a.rhs)}`)).toEqual(['y=(& a b)', 'z=(~ a)']);
    expect(sexpr(a2!.assignments[0]!.lhs)).toBe('{c s}');
  });

  it('rejects memories as unsupported', () => {
    expect(expectVerilogError(() => parse('module m; reg [7:0] mem [0:15]; endmodule')).message).toMatch(/memories/);
  });

  it("explains that module-level assignments need 'assign'", () => {
    expect(expectVerilogError(() => parse('module m; y = 1; endmodule')).message).toMatch(/need 'assign'/);
  });

  it('rejects generate as unsupported', () => {
    expect(expectVerilogError(() => parse('module m; generate endgenerate endmodule')).message).toMatch(/'generate' is not supported yet/);
  });
});

describe('parser: always and initial', () => {
  it('represents always @(posedge clk) as Always wrapping an EventControl', () => {
    const m = onlyModule('module m(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule');
    const always = m.items[0] as A.AlwaysBlock;
    expect(always.kind).toBe('Always');
    expect(always.body.kind).toBe('EventControl');
  });

  it('parses a combinational always block with a case', () => {
    const m = onlyModule(`
      module mux(input [1:0] s, input [3:0] d, output reg y);
        always @(*) begin
          case (s)
            0: y = d[0];
            1: y = d[1];
            default: y = d[3];
          endcase
        end
      endmodule`);
    const body = (m.items[0] as A.AlwaysBlock).body as A.EventControl;
    expect(body.sensitivity.kind).toBe('Star');
    expect((body.body as A.Block).stmts[0]!.kind).toBe('Case');
  });

  it('parses a clock generator with no event control', () => {
    const m = onlyModule('module tb; reg clk = 0; always #5 clk = ~clk; endmodule');
    expect((m.items[1] as A.AlwaysBlock).body.kind).toBe('Delay');
  });
});

describe('parser: module instantiation', () => {
  it('parses named connections and parameter overrides', () => {
    const m = onlyModule('module top; counter #(.W(8)) u0 (.clk(clk), .rst(1\'b0), .q(count), .unused()); endmodule');
    const inst = m.items[0] as A.Instance;
    expect(inst).toMatchObject({ kind: 'Instance', moduleName: 'counter', instanceName: 'u0' });
    expect(inst.paramOverrides).toMatchObject([{ kind: 'Named', name: 'W' }]);
    expect(inst.connections.map((c) => (c.kind === 'Named' ? `${c.name}:${c.expr ? sexpr(c.expr) : '-'}` : '?'))).toEqual([
      'clk:clk',
      "rst:1'0",
      'q:count',
      'unused:-',
    ]);
  });

  it('parses positional connections and positional parameter overrides', () => {
    const inst = onlyModule('module top; adder #(4) a0 (x, y[3:0], {c, s}); endmodule').items[0] as A.Instance;
    expect(inst.paramOverrides).toMatchObject([{ kind: 'Positional' }]);
    expect(inst.connections.map((c) => sexpr(c.expr!))).toEqual(['x', '(range y 3 0)', '{c s}']);
  });

  it('parses several instances in one statement', () => {
    const items = onlyModule('module top; inv u0 (.a(x), .y(y0)), u1 (.a(y0), .y(y1)); endmodule').items as A.Instance[];
    expect(items.map((i) => i.instanceName)).toEqual(['u0', 'u1']);
    expect(items.every((i) => i.moduleName === 'inv')).toBe(true);
  });

  it('rejects mixing named and positional connections', () => {
    expect(expectVerilogError(() => parse('module top; inv u0 (.a(x), y); endmodule')).message).toMatch(/cannot mix named and positional/);
  });

  it('requires an instance name', () => {
    expect(expectVerilogError(() => parse('module top; inv (.a(x)); endmodule')).message).toMatch(/expected an instance name after module name 'inv'/);
  });
});

describe('parser: complete designs', () => {
  const counter = `
\`timescale 1ns/1ps
// 4-bit counter with synchronous reset and enable
module counter #(parameter W = 4)
  ( input  wire         clk
  , input  wire         rst
  , input  wire         en
  , output reg  [W-1:0] q
  );
  always @(posedge clk) begin
    if (rst)
      q <= {W{1'b0}};
    else if (en)
      q <= q + 1'b1;
  end
endmodule

module tb;
  reg clk = 0, rst = 1, en = 0;
  wire [3:0] q;

  counter #(.W(4)) dut (.clk(clk), .rst(rst), .en(en), .q(q));

  always #5 clk = ~clk;

  initial begin
    #12 rst = 0;
    en = 1;
    begin : repeat_wait
      @(posedge clk);
      @(posedge clk);
    end
    #100;
    $display("q = %d", q);
    $finish;
  end
endmodule
`;

  it('parses a counter and its testbench', () => {
    const file = parse(counter);
    expect(file.modules.map((m) => m.name)).toEqual(['counter', 'tb']);
    const tb = file.modules[1]!;
    expect(tb.items.map((i) => i.kind)).toEqual(['NetDecl', 'NetDecl', 'Instance', 'Always', 'Initial']);
    const initial = tb.items[4] as A.InitialBlock;
    expect((initial.body as A.Block).stmts.map((s) => s.kind)).toEqual([
      'Delay',
      'ProceduralAssign',
      'Block',
      'Delay',
      'SystemTaskCall',
      'SystemTaskCall',
    ]);
  });

  it('produces spans that cover each module exactly', () => {
    const file = parse(counter);
    for (const m of file.modules) {
      const text = counter.slice(m.span.start, m.span.end);
      expect(text.startsWith('module')).toBe(true);
      expect(text.endsWith('endmodule')).toBe(true);
    }
  });

  it('produces JSON-serializable ASTs (numbers aside, which are bigint)', () => {
    const json = JSON.stringify(parse(counter), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).toContain('"kind":"Module"');
  });
});
