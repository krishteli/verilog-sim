/**
 * Golden tests: every design in tests/golden/ must print exactly what Icarus
 * Verilog prints. The expected outputs are produced by scripts/update-golden.sh
 * (CI re-runs it with a real iverilog to keep them honest).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/core';

const dir = fileURLToPath(new URL('./golden/', import.meta.url));
const designs = readdirSync(dir).filter((f) => f.endsWith('.v'));

describe('matches Icarus Verilog output', () => {
  it('has golden designs', () => {
    expect(designs.length).toBeGreaterThan(0);
  });

  it.each(designs)('%s', (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const expected = readFileSync(join(dir, file.replace(/\.v$/, '.expected')), 'utf8').replace(/\r/g, '');
    expect(run(source).result.output).toBe(expected);
  });
});
