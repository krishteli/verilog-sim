# One-command Vivado build (and optional programming) for the Basys 3 demo.
#
#   vivado -mode batch -source boards/basys3/build.tcl                   # build only
#   vivado -mode batch -source boards/basys3/build.tcl -tclargs program  # build + program
#
# This uses Vivado's "non-project mode": instead of creating a .xpr project and
# clicking through the GUI, each step (synthesis, placement, routing, bitstream)
# is one Tcl command run in memory. It's scriptable, needs no GUI, and the only
# output is boards/basys3/build/ (bitstream + reports), which git ignores.

set here [file dirname [file normalize [info script]]]
set out  [file join $here build]
file mkdir $out

read_verilog [file join $here basys3_top.v]
read_xdc     [file join $here basys3.xdc]

# xc7a35tcpg236-1 is the Artix-7 chip on the Basys 3.
synth_design -top basys3_top -part xc7a35tcpg236-1
opt_design
place_design
route_design

report_utilization    -file [file join $out utilization.rpt]
report_timing_summary -file [file join $out timing.rpt]
write_bitstream -force [file join $out basys3_top.bit]
puts "Bitstream: [file join $out basys3_top.bit]"

if {[lindex $argv 0] eq "program"} {
  # Talks to the board over the USB-JTAG cable (needs Vivado's cable drivers).
  open_hw_manager
  connect_hw_server
  open_hw_target
  set dev [lindex [get_hw_devices xc7a35t*] 0]
  current_hw_device $dev
  set_property PROGRAM.FILE [file join $out basys3_top.bit] $dev
  program_hw_devices $dev
  close_hw_manager
  puts "Programmed $dev"
}
