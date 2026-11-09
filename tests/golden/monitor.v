// $monitor, $strobe, $write and display formatting corner cases.
module tb;
  reg [7:0] x = 8'd5;
  reg signed [7:0] sx = -8'sd3;
  reg [11:0] h = 12'h0a5;
  integer i = -42;

  initial $monitor("monitor: x=%d sx=%d", x, sx);

  initial begin
    $display("[%d] [%0d] [%5d] [%b] [%0b] [%h] [%o]", x, x, x, x, x, h, x);
    $display("[%d] [%0d] [%h]", sx, sx, sx);
    $display("[%d] [%0d]", i, i);
    $display("chars: %c%c %s 100%%", 8'd79, 8'd75, "str");
    $display("scope: %m");
    $write("no newline, ");
    $write("then newline\n");
    $display(x, " ", sx);
    #1 x = 8'd6;
    #1 sx = 8'sd7;
    x <= 8'd9;
    $strobe("strobe sees x=%0d", x);
    $display("display sees x=%0d", x);
    #1 x = 8'd9;
    #1 $finish;
  end
endmodule
