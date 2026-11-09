/**
 * Example designs shown in the UI. They are the same files as the golden
 * tests (tests/golden, boards/), imported as raw text, so every example is
 * known to produce exactly what Icarus Verilog produces.
 */
import adder from '../../tests/golden/adder.v?raw';
import alu from '../../tests/golden/alu.v?raw';
import counter from '../../tests/golden/counter.v?raw';
import fsm from '../../tests/golden/fsm.v?raw';
import monitor from '../../tests/golden/monitor.v?raw';
import nba from '../../tests/golden/nba.v?raw';
import basysTop from '../../boards/basys3/basys3_top.v?raw';
import basysTb from '../../boards/basys3/tb_basys3_top.v?raw';

export interface Example {
  id: string;
  name: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  { id: 'counter', name: 'Counter with enable', source: counter },
  { id: 'nba', name: 'Blocking vs nonblocking', source: nba },
  { id: 'fsm', name: 'FSM: detect 1011', source: fsm },
  { id: 'adder', name: 'Ripple-carry adder', source: adder },
  { id: 'alu', name: '8-bit ALU', source: alu },
  { id: 'basys3', name: 'Basys 3 board demo', source: `${basysTop}\n${basysTb}` },
  { id: 'format', name: '$display formatting', source: monitor },
];
