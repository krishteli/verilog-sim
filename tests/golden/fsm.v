// Moore FSM that detects the bit pattern 1011 (overlapping), with async reset.
module detect1011 (
  input  wire clk,
  input  wire rst_n,
  input  wire bit_in,
  output wire found
);
  localparam S0 = 3'd0, S1 = 3'd1, S10 = 3'd2, S101 = 3'd3, S1011 = 3'd4;
  reg [2:0] state, next;

  always @(posedge clk or negedge rst_n)
    if (!rst_n) state <= S0;
    else        state <= next;

  always @(*) begin
    case (state)
      S0:    next = bit_in ? S1    : S0;
      S1:    next = bit_in ? S1    : S10;
      S10:   next = bit_in ? S101  : S0;
      S101:  next = bit_in ? S1011 : S10;
      S1011: next = bit_in ? S1    : S10;
      default: next = S0;
    endcase
  end

  assign found = (state == S1011);
endmodule

module tb;
  reg clk = 0, rst_n = 0;
  reg [15:0] pattern = 16'b1011_0110_1101_1011;
  reg [3:0] idx = 4'd15;
  wire found, bit_in;

  assign bit_in = pattern[idx];
  detect1011 dut (.clk(clk), .rst_n(rst_n), .bit_in(bit_in), .found(found));

  always #5 clk = ~clk;
  always @(posedge clk) if (rst_n) idx <= idx - 1;
  always @(negedge clk) $display("%0d in=%b found=%b", $time, bit_in, found);

  initial begin
    #7 rst_n = 1;
    #170 $finish;
  end
endmodule
