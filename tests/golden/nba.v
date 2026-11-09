// Blocking vs nonblocking: swap, shift register, and same-edge reads.
module tb;
  reg clk = 0;
  reg [3:0] a = 4'd3, b = 4'd12;
  reg [3:0] s1 = 0, s2 = 0, s3 = 0;
  reg [3:0] b1 = 0, b2 = 0, b3 = 0;
  reg [3:0] d = 4'd1;

  always @(posedge clk) begin
    a <= b;
    b <= a;
  end

  always @(posedge clk) begin
    s1 <= d;
    s2 <= s1;
    s3 <= s2;
  end

  always @(posedge clk) begin
    b1 = d;
    b2 = b1;
    b3 = b2;
  end

  always @(posedge clk) d <= d + 4'd1;

  always #5 clk = ~clk;

  always @(negedge clk)
    $display("%0d: a=%0d b=%0d | nba %0d %0d %0d | blocking %0d %0d %0d", $time, a, b, s1, s2, s3, b1, b2, b3);

  initial #60 $finish;
endmodule
