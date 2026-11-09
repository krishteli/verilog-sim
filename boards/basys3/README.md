# Running a design on a real Basys 3

The simulator runs in the browser; it can't program an FPGA by itself. The
workflow is: **simulate here first, then build the same Verilog with Vivado
and program the board.** Everything in the supported subset is synthesizable,
so the file you simulate is the file you put on the board.

## Files

| File | Purpose |
| --- | --- |
| `basys3_top.v` | The design that goes on the board (synthesizable). |
| `tb_basys3_top.v` | Testbench for simulation only — **don't** add it to Vivado as a design source. |
| `basys3.xdc` | Pin constraints: which FPGA pin each port connects to. |

The demo: the 16 switches light the 16 LEDs above them, the 7-segment display
counts up in hex once per second, **btnC** (centre) resets the counter, and
holding **btnU** (up) pauses it.

## 1. Simulate first

In the web app, choose the **Basys 3 board demo** example and press **Run**.
The testbench shrinks the 1-second tick to 8 clock cycles so you can see it
count in the waveform. Or run it under Icarus Verilog:

```bash
iverilog -o basys3.vvp boards/basys3/basys3_top.v boards/basys3/tb_basys3_top.v
vvp basys3.vvp
```

## 2. Install Vivado (one time)

1. Download **AMD Vivado ML Standard** (the free edition) from AMD's website. You
   need a free AMD account. The Standard edition supports the Basys 3's Artix-7
   XC7A35T chip.
2. In the installer, choose *Vivado*, then *Vivado ML Standard*. Under devices
   you only need **7 Series → Artix-7**, which keeps the download much smaller.
3. Vivado runs on Windows and Linux. On a Mac you need a Windows/Linux VM or another machine.
4. Optional but handy: install Digilent's board files so *Basys 3* appears in
   the board picker (see Digilent's "Installing Vivado, Vitis and Digilent Board Files" guide).

## 3. Build the bitstream

1. **Create Project** → RTL Project → next.
2. **Add Sources**: add `basys3_top.v` only.
3. **Add Constraints**: add `basys3.xdc`.
4. **Part**: pick `xc7a35tcpg236-1` (or the *Basys 3* board if you installed board files).
5. Make sure `basys3_top` is the top module (it should be bold in the Sources panel).
6. Click **Generate Bitstream**. Vivado runs synthesis and implementation
   automatically first; it takes a few minutes the first time.

## 4. Program the board

1. Plug the Basys 3 into USB (the micro-USB port labelled PROG) and switch it on.
   Make sure the mode jumper JP1 is set to JTAG.
2. In Vivado: **Open Hardware Manager → Open Target → Auto Connect**.
3. **Program Device** → select the generated `basys3_top.bit` → **Program**.
4. The DONE LED lights up and the display starts counting. Flip switches to see
   the LEDs follow.

Programming over JTAG is lost when the board powers off. To keep the design,
write it to the on-board flash instead (Vivado: *Add Configuration Memory Device*).

## Using your own design

- Your top module's port names must match the names in `basys3.xdc`. The
  easiest way is to keep `clk`, `sw`, `led`, `seg`, `an`, `dp`, `btnC`, ... and
  delete the lines in the `.xdc` for ports you don't use.
- The clock is **100 MHz**. Anything a human should see (blinking, counting)
  needs a divider; the demo's `TICK` parameter shows the pattern.
- The 7-segment display is **active low**, and only one digit can be lit at a
  time. Scan the digits quickly (the `refresh` counter in the demo).
- Buttons bounce. For anything edge-triggered on a button press, add a
  debouncer or synchronizer; the demo only uses buttons as levels.
- Keep a parameter for anything time-related so the testbench can shrink it.

## Troubleshooting

- *"[Place 30-574] Poor placement for routing between an IO pin and BUFG"*:
  usually means a button or switch is being used as a clock. Clock everything
  from `clk`.
- *"[DRC NSTD-1] Unspecified I/O Standard"*: a top-level port has no line in the
  `.xdc`. Add one, or remove the port.
- Display shows garbage or all eights: check that segments and anodes are
  driven active low.
