import { describe, expect, it } from 'vitest';
import { run } from './index';
import { toVcd } from './vcd';

describe('VCD export', () => {
  const src = `
    module sub(input a, output y); assign y = ~a; endmodule
    module tb; reg a = 0; reg [3:0] n = 4'd5; wire y;
      sub u(.a(a), .y(y));
      initial begin #10 a = 1; n = 4'd10; #5 $finish; end
    endmodule`;
  const { netlist, result } = run(src);
  const vcd = toVcd(netlist, result);

  it('declares nested scopes and variables with widths and ranges', () => {
    expect(vcd).toContain('$scope module tb $end');
    expect(vcd).toContain('$scope module u $end');
    expect(vcd).toMatch(/\$var reg 4 \S+ n \[3:0\] \$end/);
    expect(vcd).toMatch(/\$var wire 1 \S+ y \$end/);
    expect(vcd.indexOf('$scope module u')).toBeLessThan(vcd.lastIndexOf('$upscope'));
  });

  it('dumps initial values and then changes by time', () => {
    const body = vcd.slice(vcd.indexOf('$enddefinitions'));
    expect(body).toMatch(/#0\n\$dumpvars\n[\s\S]*b101 [\s\S]*\$end/);
    expect(body).toMatch(/#10\n[\s\S]*b1010 /);
    expect(body.trimEnd().endsWith('#15')).toBe(true);
  });

  it('gives each signal a unique identifier code', () => {
    const codes = [...vcd.matchAll(/\$var \S+ \d+ (\S+) /g)].map((m) => m[1]);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
