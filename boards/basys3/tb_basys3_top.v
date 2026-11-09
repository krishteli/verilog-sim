// Testbench for basys3_top. TICK and REFRESH_BITS are shrunk so a count
// happens every 8 clocks and the display scans every few clocks.
module tb_basys3_top;
  reg         clk  = 0;
  reg         btnC = 1;
  reg         btnU = 0;
  reg  [15:0] sw   = 16'hA5C3;
  wire [15:0] led;
  wire [6:0]  seg;
  wire        dp;
  wire [3:0]  an;

  basys3_top #(.TICK(8), .REFRESH_BITS(3)) dut (
    .clk(clk), .btnC(btnC), .btnU(btnU), .sw(sw),
    .led(led), .seg(seg), .dp(dp), .an(an)
  );

  always #5 clk = ~clk; // 10 time units per clock

  initial begin
    #20  btnC = 0;                 // release reset
    #400 btnU = 1;                 // pause for a while
    #200 btnU = 0;
    #200 sw   = 16'h0F0F;
    #200 $display("count=%h led=%h", dut.count, led);
    $finish;
  end

  // Print the counter whenever it changes.
  always @(dut.count) $display("t=%0d count=%h", $time, dut.count);
endmodule
