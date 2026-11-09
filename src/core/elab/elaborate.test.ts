import { describe, expect, it } from 'vitest';
import { compile, run } from '../index';
import { expectVerilogError } from '../parser/test-utils';

const sigNames = (src: string) => compile(src).signals.map((s) => `${s.name}[${s.width}]`);

describe('elaborator: hierarchy', () => {
  it('picks modules nobody instantiates as tops', () => {
    const n = compile('module leaf(input a); endmodule\nmodule top; wire x; leaf u(.a(x)); endmodule');
    expect(n.tops).toEqual(['top']);
    expect(n.instances.map((i) => i.path)).toEqual(['top', 'top.u']);
  });

  it('gives every instance its own copy of the signals', () => {
    expect(
      sigNames(`
        module inv(input a, output y); assign y = ~a; endmodule
        module top; wire a, b, c; inv u0(.a(a), .y(b)); inv u1(.a(b), .y(c)); endmodule`),
    ).toEqual(['top.a[1]', 'top.b[1]', 'top.c[1]', 'top.u0.a[1]', 'top.u0.y[1]', 'top.u1.a[1]', 'top.u1.y[1]']);
  });

  it('turns port connections into continuous assignments', () => {
    const n = compile('module inv(input a, output y); assign y = ~a; endmodule\nmodule top; wire p, q; inv u(.a(p), .y(q)); endmodule');
    expect(n.assigns.map((a) => a.origin)).toEqual(['assign', 'port', 'port']);
  });

  it('supports positional connections', () => {
    const n = compile('module inv(input a, output y); assign y = ~a; endmodule\nmodule top; wire p, q; inv u(p, q); endmodule');
    expect(n.assigns.filter((a) => a.origin === 'port')).toHaveLength(2);
  });

  it('rejects unknown modules and ports', () => {
    expect(expectVerilogError(() => compile('module top; nope u(); endmodule')).message).toMatch(/unknown module 'nope'/);
    expect(
      expectVerilogError(() => compile('module m(input a); endmodule\nmodule top; m u(.b(1)); endmodule')).message,
    ).toMatch(/no port named 'b'/);
  });

  it('rejects recursive instantiation', () => {
    expect(expectVerilogError(() => compile('module a; b u(); endmodule\nmodule b; a u(); endmodule\nmodule t; a x(); endmodule')).message).toMatch(
      /instantiates itself/,
    );
  });
});

describe('elaborator: parameters', () => {
  it('uses defaults and evaluates widths from parameters', () => {
    expect(sigNames('module m #(parameter W = 8) (input [W-1:0] a); endmodule')).toEqual(['m.a[8]']);
  });

  it('applies named and positional overrides', () => {
    const leaf = 'module leaf #(parameter W = 1, parameter D = 2) (input [W-1:0] a); wire [D-1:0] d; endmodule\n';
    expect(sigNames(leaf + 'module top; leaf #(.W(4)) u(); endmodule').slice(-2)).toEqual(['top.u.a[4]', 'top.u.d[2]']);
    expect(sigNames(leaf + 'module top; leaf #(3, 5) u(); endmodule').slice(-2)).toEqual(['top.u.a[3]', 'top.u.d[5]']);
  });

  it('evaluates parameters in terms of earlier parameters', () => {
    expect(sigNames('module m; localparam A = 3; localparam B = A * 2 + 1; wire [B:0] x; endmodule')).toEqual(['m.x[8]']);
  });

  it('refuses to override a localparam', () => {
    expect(
      expectVerilogError(() => compile('module leaf; localparam W = 1; endmodule\nmodule top; leaf #(.W(4)) u(); endmodule')).message,
    ).toMatch(/no overridable parameter 'W'/);
  });

  it('rejects signals in constant expressions', () => {
    expect(expectVerilogError(() => compile('module m; wire a; wire [a:0] b; endmodule')).message).toMatch(/constant is required/);
  });
});

describe('elaborator: checks with fix-it messages', () => {
  it('rejects undeclared names', () => {
    expect(expectVerilogError(() => compile('module m; wire y; assign y = nope; endmodule')).message).toMatch(/'nope' is not declared/);
  });

  it('rejects assign to a reg', () => {
    expect(expectVerilogError(() => compile('module m; reg y; assign y = 1; endmodule')).message).toMatch(/declare it as a wire/);
  });

  it('rejects procedural assignment to a wire', () => {
    expect(expectVerilogError(() => compile('module m; wire y; initial y = 1; endmodule')).message).toMatch(/declare it as reg/);
  });

  it('rejects driving an input port', () => {
    expect(expectVerilogError(() => compile('module m(input a); assign a = 1; endmodule')).message).toMatch(/input port 'a'/);
  });

  it('rejects connecting an output port to a reg', () => {
    expect(
      expectVerilogError(() => compile('module s(output y); assign y = 1; endmodule\nmodule t; reg r; s u(.y(r)); endmodule')).message,
    ).toMatch(/output port 'y' of 'u' drives 'r'/);
  });

  it('rejects duplicate declarations', () => {
    expect(expectVerilogError(() => compile('module m; wire a; reg a; endmodule')).message).toMatch(/'a' is already declared/);
  });

  it('rejects out-of-range and reversed constant selects', () => {
    expect(expectVerilogError(() => compile('module m; wire [3:0] a; wire b; assign b = a[4]; endmodule')).message).toMatch(/out of range/);
    expect(expectVerilogError(() => compile('module m; wire [3:0] a; wire [1:0] b; assign b = a[0:1]; endmodule')).message).toMatch(/reversed/);
  });

  it('rejects an always block with nothing to wait on at simulation time, not compile time', () => {
    // Statically legal; the simulator reports it (see simulator tests).
    expect(() => compile('module m; reg a; always a = ~a; endmodule')).not.toThrow();
  });
});

describe('elaborator: hierarchical references', () => {
  const design = `
    module counter(input clk, output reg [3:0] q); reg [3:0] hidden = 4'd9; always @(posedge clk) q <= q + 1; endmodule
    module tb; reg clk = 0; wire [3:0] q; counter dut(.clk(clk), .q(q));
      initial #1 $display("%0d", dut.hidden);
    endmodule`;

  it('reads a child signal through a dotted name', () => {
    expect(run(design).result.output).toBe('9\n');
  });

  it('accepts absolute paths and reports unknown ones', () => {
    expect(run(design.replace('dut.hidden', 'tb.dut.hidden')).result.output).toBe('9\n');
    expect(expectVerilogError(() => compile(design.replace('dut.hidden', 'dut.nope'))).message).toMatch(/does not match any signal/);
  });

  it('rejects assignment through a hierarchical name', () => {
    expect(expectVerilogError(() => compile(design.replace('$display("%0d", dut.hidden)', 'dut.hidden = 1'))).message).toMatch(
      /hierarchical name/,
    );
  });
});

describe('elaborator: sensitivity', () => {
  it('derives the @(*) sensitivity list from what the block reads', () => {
    const n = compile('module m(input a, input b, input s, output reg y); always @(*) if (s) y = a; else y = b; endmodule');
    const p = n.processes[0]!;
    const names = p.comb!.sigs.map((id) => n.signals[id]!.local).sort();
    expect(names).toEqual(['a', 'b', 's']);
  });
});
