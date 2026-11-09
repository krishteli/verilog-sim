// Basys 3 demo: switches drive the LEDs, and the 4-digit 7-segment display
// shows a hex counter that ticks once per second.
//   btnC  - reset the counter to 0000
//   btnU  - hold to pause counting
//
// Synthesizable as-is in Vivado (pair it with basys3.xdc). The parameters
// default to real-board timing; the testbench overrides them with tiny values
// so a simulation shows several ticks in a few hundred time units.
module basys3_top #(
  parameter TICK         = 100_000_000, // clock cycles per count (100 MHz -> 1 Hz)
  parameter REFRESH_BITS = 18           // digit scan: 100 MHz / 2^18 = ~381 Hz per digit
) (
  input  wire        clk,   // 100 MHz oscillator
  input  wire        btnC,
  input  wire        btnU,
  input  wire [15:0] sw,
  output wire [15:0] led,
  output reg  [6:0]  seg,   // segments CA..CG, active low
  output wire        dp,    // decimal point, active low
  output reg  [3:0]  an     // digit enables, active low
);
  assign led = sw;
  assign dp  = 1'b1; // decimal point off

  // ---- 1 Hz tick ------------------------------------------------------------
  reg [26:0] div   = 0;
  reg [15:0] count = 0;

  always @(posedge clk) begin
    if (btnC) begin
      div   <= 0;
      count <= 0;
    end else if (!btnU) begin
      if (div == TICK - 1) begin
        div   <= 0;
        count <= count + 1'b1;
      end else begin
        div <= div + 1'b1;
      end
    end
  end

  // ---- display multiplexing ---------------------------------------------------
  // Only one digit is lit at a time; scanning faster than the eye can follow
  // makes all four look lit. The top two bits of a free-running counter pick
  // the digit.
  reg [REFRESH_BITS-1:0] refresh = 0;
  always @(posedge clk) refresh <= refresh + 1'b1;

  wire [1:0] digit = refresh[REFRESH_BITS-1 -: 2];
  reg  [3:0] nibble;

  always @(*) begin
    case (digit)
      2'd0: begin an = 4'b1110; nibble = count[3:0];   end
      2'd1: begin an = 4'b1101; nibble = count[7:4];   end
      2'd2: begin an = 4'b1011; nibble = count[11:8];  end
      default: begin an = 4'b0111; nibble = count[15:12]; end
    endcase
  end

  // ---- hex to 7-segment (active low, bit order {g,f,e,d,c,b,a}) ----------------
  always @(*) begin
    case (nibble)
      4'h0: seg = 7'b1000000;
      4'h1: seg = 7'b1111001;
      4'h2: seg = 7'b0100100;
      4'h3: seg = 7'b0110000;
      4'h4: seg = 7'b0011001;
      4'h5: seg = 7'b0010010;
      4'h6: seg = 7'b0000010;
      4'h7: seg = 7'b1111000;
      4'h8: seg = 7'b0000000;
      4'h9: seg = 7'b0010000;
      4'hA: seg = 7'b0001000;
      4'hB: seg = 7'b0000011;
      4'hC: seg = 7'b1000110;
      4'hD: seg = 7'b0100001;
      4'hE: seg = 7'b0000110;
      default: seg = 7'b0001110; // F
    endcase
  end
endmodule
