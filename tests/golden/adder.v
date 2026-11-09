// Parameterized ripple-carry adder from full adders; positional and named ports.
module full_adder (input a, input b, input cin, output s, output cout);
  assign s    = a ^ b ^ cin;
  assign cout = (a & b) | (cin & (a ^ b));
endmodule

module add4 (input [3:0] a, input [3:0] b, input cin, output [3:0] s, output cout);
  wire c1, c2, c3;
  full_adder fa0 (a[0], b[0], cin, s[0], c1);
  full_adder fa1 (a[1], b[1], c1,  s[1], c2);
  full_adder fa2 (a[2], b[2], c2,  s[2], c3);
  full_adder fa3 (.a(a[3]), .b(b[3]), .cin(c3), .s(s[3]), .cout(cout));
endmodule

module tb;
  reg  [8:0] stim = 0;
  wire [3:0] s;
  wire       cout;
  add4 dut (.a(stim[3:0]), .b(stim[7:4]), .cin(stim[8]), .s(s), .cout(cout));

  // Walk through a spread of input combinations; check against the + operator.
  always #1 begin
    if ({cout, s} !== stim[3:0] + stim[7:4] + stim[8])
      $display("MISMATCH a=%0d b=%0d cin=%b got %0d", stim[3:0], stim[7:4], stim[8], {cout, s});
    if (stim[2:0] == 0)
      $display("a=%d b=%d cin=%b sum=%d", stim[3:0], stim[7:4], stim[8], {cout, s});
    stim = stim + 9'd37;
  end

  initial #100 $finish;
endmodule
