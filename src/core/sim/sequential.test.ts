/** Clocked logic, nonblocking assignment, delays and the scheduler's regions. */
import { describe, expect, it } from 'vitest';
import { VerilogError } from '../diagnostics';
import { run } from '../index';
import { formatArgs } from './format';

const out = (src: string, maxTime?: number) => run(src, maxTime ? { maxTime } : undefined).result.output;

describe('delays and time', () => {
  it('advances time with # delays and reports $time', () => {
    expect(out('module t; initial begin #5 $display("%0d", $time); #10 $display("%0d", $time); end endmodule')).toBe('5\n15\n');
  });

  it('interleaves processes by time', () => {
    const src = `module t;
      initial begin #10 $display("A10"); #20 $display("A30"); end
      initial begin #5 $display("B5"); #20 $display("B25"); end
    endmodule`;
    expect(out(src)).toBe('B5\nA10\nB25\nA30\n');
  });

  it('stops at $finish', () => {
    const { result } = run('module t; initial begin #3 $finish; end initial #10 $display("late"); endmodule');
    expect(result).toMatchObject({ output: '', stopReason: 'finish', endTime: 3 });
  });

  it('stops when nothing is left to do', () => {
    expect(run('module t; initial #7; endmodule').result).toMatchObject({ stopReason: 'idle', endTime: 7 });
  });

  it('stops at maxTime for free-running clocks', () => {
    const { result } = run('module t; reg clk = 0; always #5 clk = ~clk; endmodule', { maxTime: 100 });
    expect(result).toMatchObject({ stopReason: 'maxTime', endTime: 100 });
  });

  it('uses parameters and expressions as delays', () => {
    expect(out('module t; localparam P = 4; initial begin #(P*2) $display("%0d", $time); #P $display("%0d", $time); end endmodule')).toBe('8\n12\n');
  });
});

describe('nonblocking assignment', () => {
  it('swaps registers', () => {
    const src = `module t; reg clk = 0; reg [3:0] a = 1, b = 2;
      always @(posedge clk) begin a <= b; b <= a; end
      initial begin #1 clk = 1; #1 $display("%0d %0d", a, b); end endmodule`;
    expect(out(src)).toBe('2 1\n');
  });

  it('makes a shift register shift one stage per clock', () => {
    const src = `module t; reg clk = 0; reg d = 1; reg q1 = 0, q2 = 0, q3 = 0;
      always @(posedge clk) begin q1 <= d; q2 <= q1; q3 <= q2; end
      always #5 clk = ~clk;
      initial begin
        @(negedge clk) $display("%b%b%b", q1, q2, q3);
        @(negedge clk) $display("%b%b%b", q1, q2, q3);
        @(negedge clk) $display("%b%b%b", q1, q2, q3);
        $finish;
      end endmodule`;
    expect(out(src)).toBe('100\n110\n111\n');
  });

  it('contrasts with blocking assignment, which ripples through in one clock', () => {
    const src = `module t; reg clk = 0; reg d = 1; reg q1 = 0, q2 = 0, q3 = 0;
      always @(posedge clk) begin q1 = d; q2 = q1; q3 = q2; end
      initial begin #1 clk = 1; #1 $display("%b%b%b", q1, q2, q3); end endmodule`;
    expect(out(src)).toBe('111\n');
  });

  it('reads the value from before the clock edge in a $display at the edge', () => {
    const src = `module t; reg clk = 0; reg [3:0] q = 0;
      always @(posedge clk) begin q <= q + 1; $display("old=%0d", q); end
      initial begin #1 clk = 1; #1 $display("new=%0d", q); end endmodule`;
    expect(out(src)).toBe('old=0\nnew=1\n');
  });

  it('shows $strobe values after NBA updates', () => {
    const src = `module t; reg [3:0] q = 0; initial begin q <= 5; $display("d=%0d", q); $strobe("s=%0d", q); end endmodule`;
    expect(out(src)).toBe('d=0\ns=5\n');
  });

  it('evaluates the target index when the assignment executes, not when it lands', () => {
    const src = `module t; reg [3:0] r = 0; reg [1:0] i = 1;
      initial begin r[i] <= 1; i = 3; #1 $display("%b", r); end endmodule`;
    expect(out(src)).toBe('0010\n');
  });
});

describe('edges and event controls', () => {
  it('distinguishes posedge and negedge', () => {
    const src = `module t; reg c = 0;
      always @(posedge c) $display("pos %0d", $time);
      always @(negedge c) $display("neg %0d", $time);
      initial begin #1 c = 1; #1 c = 0; #1 c = 1; end endmodule`;
    expect(out(src)).toBe('pos 1\nneg 2\npos 3\n');
  });

  it('handles asynchronous reset with or in the sensitivity list', () => {
    const src = `module t; reg clk = 0, rst_n = 1; reg [3:0] q = 4'd9;
      always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= q + 1;
      initial begin #1 rst_n = 0; #1 $display("%0d", q); rst_n = 1; #1 clk = 1; #1 $display("%0d", q); end endmodule`;
    expect(out(src)).toBe('0\n1\n');
  });

  it('wakes level-sensitive lists on any change (and on the X -> init change at time 0)', () => {
    // Matches Icarus: the initializers count as X -> 0 changes, so "0: 00" prints;
    // writing b = 1 again at time 3 is not a change and prints nothing.
    const src = `module t; reg a = 0, b = 0;
      always @(a or b) $display("%0d: %b%b", $time, a, b);
      initial begin #1 a = 1; #1 b = 1; #1 b = 1; end endmodule`;
    expect(out(src)).toBe('0: 00\n1: 10\n2: 11\n');
  });

  it('treats the first write to an uninitialized reg as a change from X', () => {
    const src = `module t; reg u; reg c;
      always @(u) $display("u=%0d at %0d", u, $time);
      always @(negedge c) $display("negedge c at %0d", $time);
      initial begin #1 u = 0; c = 0; #1 u = 0; end endmodule`;
    expect(out(src)).toBe('u=0 at 1\nnegedge c at 1\n');
  });

  it('does not treat declaration initializers as edges', () => {
    const src = `module t; reg c = 1; always @(posedge c) $display("posedge"); initial #1 $display("done"); endmodule`;
    expect(out(src)).toBe('done\n');
  });

  it('waits for an edge inside an initial block', () => {
    const src = `module t; reg clk = 0; always #5 clk = ~clk;
      initial begin @(posedge clk); @(posedge clk); $display("%0d", $time); $finish; end endmodule`;
    expect(out(src)).toBe('15\n');
  });
});

describe('$monitor', () => {
  it('prints once at the call and again whenever an argument changes', () => {
    const src = `module t; reg [1:0] a = 0;
      initial $monitor("%0d a=%0d", $time, a);
      initial begin #2 a = 1; #2 a = 1; #2 a = 2; end endmodule`;
    expect(out(src)).toBe('0 a=0\n2 a=1\n6 a=2\n');
  });
});

describe('a full counter design', () => {
  it('counts with synchronous reset and enable', () => {
    const src = `
      module counter #(parameter W = 4) (input clk, input rst, input en, output reg [W-1:0] q);
        always @(posedge clk) if (rst) q <= 0; else if (en) q <= q + 1'b1;
      endmodule
      module tb; reg clk = 0, rst = 1, en = 0; wire [3:0] q;
        counter #(.W(4)) dut(.clk(clk), .rst(rst), .en(en), .q(q));
        always #5 clk = ~clk;
        initial begin
          #12 rst = 0; en = 1;
          #100 $display("q=%0d", q);
          #60 $display("q=%0d", q);
          $finish;
        end
      endmodule`;
    // posedges at 5,15,...; counting starts at the 15 edge. By t=112 edges 15..105 => 10 counts.
    // By t=172: 16 counts -> wraps to 0 at the 16th.
    expect(out(src)).toBe('q=10\nq=0\n');
  });
});

describe('runtime errors', () => {
  it('reports an always block with no timing control', () => {
    expect(() => run('module t; reg a = 0; always a = ~a; endmodule')).toThrow(/no delay or event control/);
  });

  it('reports combinational loops', () => {
    const src = 'module t; wire a; assign a = ~a; endmodule';
    expect(() => run(src, { maxStepsPerTime: 1000 })).toThrow(VerilogError);
    expect(() => run(src, { maxStepsPerTime: 1000 })).toThrow(/combinational loop/);
  });

  it('reports format errors at the $display', () => {
    expect(() => run('module t; initial $display("%d"); endmodule')).toThrow(/missing argument/);
  });
});

describe('waveform recording', () => {
  it('records one entry per change, collapsing same-time glitches', () => {
    const src = `module t; reg [3:0] r = 0;
      initial begin #5 r = 1; r = 2; #5 r = 2; #5 r = 3; r = 2; end endmodule`;
    const { netlist, result } = run(src);
    const id = netlist.signals.find((s) => s.local === 'r')!.id;
    expect(result.waves[id]).toEqual({ times: [0, 5], values: [0n, 2n] });
  });
});

describe('$display formatting', () => {
  const v = (value: bigint, width: number, signed = false) => ({ k: 'val' as const, value, width, signed });
  const s = (value: string) => ({ k: 'str' as const, value });

  it('pads %d to the widest value of the type', () => {
    expect(formatArgs([s('[%d]'), v(5n, 8)], 't')).toBe('[  5]');
    expect(formatArgs([s('[%d]'), v(5n, 32, true)], 't')).toBe('[          5]');
  });

  it('prints negative signed values', () => {
    expect(formatArgs([s('%0d'), v(0xfen, 8, true)], 't')).toBe('-2');
  });

  it('zero-pads binary and hex to full width', () => {
    expect(formatArgs([s('%b %h %o'), v(5n, 6), v(10n, 12), v(8n, 6)], 't')).toBe('000101 00a 10');
    expect(formatArgs([s('%0b %0h'), v(5n, 6), v(10n, 12)], 't')).toBe('101 a');
  });

  it('supports %c, %s, %m, %% and explicit widths', () => {
    expect(formatArgs([s('%c%s %m 100%% [%4d]'), v(65n, 8), s('hi'), v(7n, 8)], 'tb.dut')).toBe('Ahi tb.dut 100% [   7]');
  });

  it('prints values with no format string in decimal', () => {
    expect(formatArgs([v(7n, 4), s(' x')], 't')).toBe(' 7 x');
  });
});
