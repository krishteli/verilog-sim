// $finish semantics and postponed-region ordering, pinned to Icarus behaviour.
module t;
  reg [3:0] x = 0; reg c = 0;
  always @(posedge c) $display("posedge woke at %0d, x=%0d", $time, x);
  initial $monitor("monitor x=%0d", x);
  initial begin
    #5;
    x <= 4'd7;
    $strobe("strobe x=%0d", x);
    $finish;
    $display("after finish (same process)");
  end
  initial #5 c = 1;
endmodule
