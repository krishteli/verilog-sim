// Counter with synchronous reset and enable, printed every clock.
module counter #(parameter W = 4) (
  input  wire         clk,
  input  wire         rst,
  input  wire         en,
  output reg  [W-1:0] q
);
  always @(posedge clk)
    if (rst)     q <= {W{1'b0}};
    else if (en) q <= q + 1'b1;
endmodule

module tb;
  reg clk = 0, rst = 1, en = 0;
  wire [3:0] q;
  counter #(.W(4)) dut (.clk(clk), .rst(rst), .en(en), .q(q));

  always #5 clk = ~clk;
  always @(negedge clk) $display("t=%0d rst=%b en=%b q=%d (%b, %h)", $time, rst, en, q, q, q);

  initial begin
    #12  rst = 0;
    #20  en  = 1;
    #200 en  = 0;
    #30  rst = 1;
    #20  $finish;
  end
endmodule
