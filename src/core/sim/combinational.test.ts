/**
 * Combinational semantics: operators, widths and signedness. Each case drives
 * inputs from a tiny testbench and checks printed results, so these tests
 * exercise parser + elaborator + evaluator together.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../index';

/** Evaluate a Verilog expression over declared wires and print it with %0d (or another format). */
function evalExpr(decls: string, expr: string, fmt = '%0d'): string {
  const src = `module t; ${decls} initial begin #1 $display("${fmt}", ${expr}); end endmodule`;
  return run(src).result.output.trim();
}

/** Assign an expression to a sized wire and print it, to test context-determined sizing. */
function assignTo(width: number, decls: string, expr: string, fmt = '%0d'): string {
  const src = `module t; ${decls} wire [${width - 1}:0] r = ${expr}; initial #1 $display("${fmt}", r); endmodule`;
  return run(src).result.output.trim();
}

describe('arithmetic and widths', () => {
  it('wraps around at the target width', () => {
    expect(assignTo(4, "wire [3:0] a = 4'd15;", 'a + 1')).toBe('0');
  });

  it('keeps the carry when the target is wider (context-determined sizing)', () => {
    expect(assignTo(5, "wire [3:0] a = 4'd15, b = 4'd1;", 'a + b')).toBe('16');
  });

  it('loses the carry inside a concatenation (self-determined sizing)', () => {
    expect(assignTo(8, "wire [3:0] a = 4'd15, b = 4'd1;", '{a + b}')).toBe('0');
  });

  it('subtracts with two’s-complement wrap', () => {
    expect(assignTo(8, "wire [7:0] a = 8'd3;", 'a - 5')).toBe('254');
  });

  it('multiplies, divides and takes remainders', () => {
    expect(evalExpr('', '7 * 6')).toBe('42');
    expect(evalExpr('', '43 / 6')).toBe('7');
    expect(evalExpr('', '43 % 6')).toBe('1');
  });

  it('divides signed values toward zero', () => {
    expect(evalExpr('', '-7 / 2')).toBe('-3');
    expect(evalExpr('', '-7 % 2')).toBe('-1');
  });

  it('gives 0 for divide by zero in 2-state mode', () => {
    expect(evalExpr('', '5 / 0')).toBe('0');
  });

  it('computes powers modulo the width', () => {
    expect(evalExpr('', "8'd2 ** 3")).toBe('8');
    expect(evalExpr('', "8'd2 ** 9")).toBe('0');
  });
});

describe('signedness', () => {
  it('sign-extends signed operands in a signed expression', () => {
    expect(assignTo(8, "wire signed [3:0] a = -4'sd2;", 'a', '%b')).toBe('11111110');
  });

  it('zero-extends when any operand is unsigned', () => {
    expect(assignTo(8, "wire signed [3:0] a = -4'sd2; wire [3:0] b = 4'd0;", 'a + b', '%b')).toBe('00001110');
  });

  it('compares signed values as signed', () => {
    expect(evalExpr("wire signed [3:0] a = -4'sd1;", 'a < 0')).toBe('1');
  });

  it('compares as unsigned when one side is unsigned', () => {
    expect(evalExpr("wire signed [3:0] a = -4'sd1; wire [3:0] z = 0;", 'a < z')).toBe('0');
  });

  it('honours $signed and $unsigned', () => {
    expect(evalExpr("wire [3:0] a = 4'b1111;", '$signed(a) < 0')).toBe('1');
    expect(evalExpr("wire signed [3:0] a = -4'sd1;", '$unsigned(a)')).toBe('15');
  });

  it('shifts arithmetically only for signed values', () => {
    expect(evalExpr("wire signed [7:0] a = -8'sd16;", 'a >>> 2', '%b')).toBe('11111100');
    expect(evalExpr("wire [7:0] a = 8'b11110000;", 'a >>> 2', '%b')).toBe('00111100');
  });
});

describe('bitwise, logical and reduction operators', () => {
  it('handles bitwise operators', () => {
    const d = "wire [3:0] a = 4'b1100, b = 4'b1010;";
    expect(evalExpr(d, 'a & b', '%b')).toBe('1000');
    expect(evalExpr(d, 'a | b', '%b')).toBe('1110');
    expect(evalExpr(d, 'a ^ b', '%b')).toBe('0110');
    expect(evalExpr(d, 'a ~^ b', '%b')).toBe('1001');
    expect(evalExpr(d, '~a', '%b')).toBe('0011');
  });

  it('handles reductions', () => {
    const d = "wire [3:0] a = 4'b1011;";
    expect(evalExpr(d, '&a')).toBe('0');
    expect(evalExpr(d, '|a')).toBe('1');
    expect(evalExpr(d, '^a')).toBe('1');
    expect(evalExpr(d, '~^a')).toBe('0');
    expect(evalExpr("wire [3:0] a = 4'b1111;", '&a')).toBe('1');
  });

  it('handles logical operators and !', () => {
    expect(evalExpr("wire [3:0] a = 4'd2, b = 0;", 'a && b')).toBe('0');
    expect(evalExpr("wire [3:0] a = 4'd2, b = 0;", 'a || b')).toBe('1');
    expect(evalExpr("wire [3:0] a = 4'd2;", '!a')).toBe('0');
  });

  it('shifts logically', () => {
    expect(evalExpr("wire [7:0] a = 8'b00010110;", 'a << 2', '%b')).toBe('01011000');
    expect(evalExpr("wire [7:0] a = 8'b00010110;", 'a >> 2', '%b')).toBe('00000101');
    expect(evalExpr("wire [7:0] a = 8'b00010110;", 'a << 9', '%b')).toBe('00000000');
  });

  it('handles the conditional operator', () => {
    expect(evalExpr("wire s = 1; wire [3:0] a = 4'd3, b = 4'd9;", 's ? a : b')).toBe('3');
    expect(evalExpr("wire s = 0; wire [3:0] a = 4'd3, b = 4'd9;", 's ? a : b')).toBe('9');
  });
});

describe('selects and concatenation', () => {
  const d = "wire [7:0] a = 8'b1010_0110;";

  it('selects bits and ranges', () => {
    expect(evalExpr(d, 'a[1]')).toBe('1');
    expect(evalExpr(d, 'a[7:4]', '%b')).toBe('1010');
  });

  it('selects with variable indices and part-selects', () => {
    const v = `${d} wire [2:0] i = 3'd2;`;
    expect(evalExpr(v, 'a[i]')).toBe('1');
    expect(evalExpr(v, 'a[i +: 4]', '%b')).toBe('1001');
    expect(evalExpr(v, 'a[i+3 -: 4]', '%b')).toBe('1001');
  });

  it('reads 0 for an out-of-range variable index', () => {
    expect(evalExpr(`${d} wire [3:0] i = 4'd12;`, 'a[i]')).toBe('0');
  });

  it('handles little-endian [0:7] vectors', () => {
    expect(evalExpr("wire [0:7] a = 8'b1000_0000;", 'a[0]')).toBe('1');
    expect(evalExpr("wire [0:7] a = 8'b1100_0000;", 'a[0:1]', '%b')).toBe('11');
  });

  it('concatenates and replicates', () => {
    expect(evalExpr("wire [1:0] a = 2'b10; wire b = 1;", "{a, b, 2'b00}", '%b')).toBe('10100');
    expect(evalExpr("wire [1:0] a = 2'b10;", '{3{a}}', '%b')).toBe('101010');
  });

  it('assigns to concatenations and part-selects', () => {
    const src = `module t; reg [3:0] hi, lo; reg [7:0] r = 0;
      initial begin {hi, lo} = 8'hA5; r[3:0] = 4'hF; r[7] = 1; #1 $display("%h %h %b", hi, lo, r); end endmodule`;
    expect(run(src).result.output.trim()).toBe('a 5 10001111');
  });
});

describe('combinational modules', () => {
  it('evaluates a ripple-carry adder built from full adders', () => {
    const src = `
      module fa(input a, input b, input cin, output s, output cout);
        assign s = a ^ b ^ cin;
        assign cout = (a & b) | (cin & (a ^ b));
      endmodule
      module add4(input [3:0] a, input [3:0] b, output [4:0] sum);
        wire c1, c2, c3;
        fa f0(a[0], b[0], 1'b0, sum[0], c1);
        fa f1(a[1], b[1], c1, sum[1], c2);
        fa f2(a[2], b[2], c2, sum[2], c3);
        fa f3(a[3], b[3], c3, sum[3], sum[4]);
      endmodule
      module tb;
        reg [3:0] a, b; wire [4:0] s;
        add4 dut(.a(a), .b(b), .sum(s));
        initial begin
          a = 4'd9; b = 4'd8; #1 $display("%0d", s);
          a = 4'd15; b = 4'd15; #1 $display("%0d", s);
          a = 4'd3; b = 4'd4; #1 $display("%0d", s);
        end
      endmodule`;
    expect(run(src).result.output).toBe('17\n30\n7\n');
  });

  it('evaluates always @(*) with case, including at time 0 with no input change', () => {
    const src = `
      module dec(input [1:0] s, output reg [3:0] y);
        always @(*) case (s) 0: y = 4'b0001; 1: y = 4'b0010; 2: y = 4'b0100; default: y = 4'b1000; endcase
      endmodule
      module tb; reg [1:0] s = 0; wire [3:0] y; dec d(.s(s), .y(y));
        initial begin #1 $display("%b", y); s = 3; #1 $display("%b", y); end
      endmodule`;
    expect(run(src).result.output).toBe('0001\n1000\n');
  });
});
