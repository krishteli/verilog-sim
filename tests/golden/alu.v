// Arithmetic, sizing and signedness, printed in several radices.
module alu (
  input  wire [3:0] op,
  input  wire [7:0] a,
  input  wire [7:0] b,
  output reg  [7:0] y,
  output reg        carry
);
  always @(*) begin
    carry = 1'b0;
    case (op)
      4'd0: {carry, y} = a + b;
      4'd1: {carry, y} = a - b;
      4'd2: y = a & b;
      4'd3: y = a | b;
      4'd4: y = a ^ b;
      4'd5: y = ~a;
      4'd6: y = a << b[2:0];
      4'd7: y = a >> b[2:0];
      4'd8: y = $signed(a) >>> b[2:0];
      4'd9: y = (a < b) ? 8'd1 : 8'd0;
      4'd10: y = ($signed(a) < $signed(b)) ? 8'd1 : 8'd0;
      4'd11: y = a * b;
      4'd12: y = {a[3:0], b[7:4]};
      4'd13: y = {4{a[1:0]}};
      4'd14: y = {7'b0, ^a};
      default: y = 8'hEE;
    endcase
  end
endmodule

module tb;
  reg  [3:0] op = 0;
  reg  [7:0] a = 8'd200, b = 8'd100;
  wire [7:0] y;
  wire       c;
  alu dut (.op(op), .a(a), .b(b), .y(y), .carry(c));

  // Step through every opcode for two operand pairs.
  always #1 begin
    $display("op=%d a=%h b=%h -> y=%b c=%b (%0d, signed %0d)", op, a, b, y, c, y, $signed(y));
    op = op + 1;
    if (op == 0) begin
      a = 8'h93;
      b = 8'h05;
    end
  end

  initial #33 $finish;
endmodule
