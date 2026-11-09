/**
 * Golden tests: every design in tests/golden/ must print exactly what Icarus
 * Verilog prints. The expected outputs are produced by scripts/update-golden.sh
 * (CI re-runs it with a real iverilog to keep them honest).
 *
 * A design is `<name>.v`, or `<name>.files` listing sources (repo-relative)
 * that are concatenated, for designs kept elsewhere such as boards/basys3/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/core';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'tests/golden');
const designs = readdirSync(dir).filter((f) => f.endsWith('.v') || f.endsWith('.files'));

function loadSource(file: string): string {
  if (file.endsWith('.v')) return readFileSync(join(dir, file), 'utf8');
  return readFileSync(join(dir, file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((p) => readFileSync(join(root, p.trim()), 'utf8'))
    .join('\n');
}

describe('matches Icarus Verilog output', () => {
  it('has golden designs', () => {
    expect(designs.length).toBeGreaterThan(0);
  });

  it.each(designs)('%s', (file) => {
    const expected = readFileSync(join(dir, file.replace(/\.(v|files)$/, '.expected')), 'utf8').replace(/\r/g, '');
    expect(run(loadSource(file)).result.output).toBe(expected);
  });
});
