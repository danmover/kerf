// Robot-arm parts: serial bus servos, the adapter board that puts them on a
// UART, a USB camera module and the supply that feeds them.

import type { CatalogPart } from "../types";
import { gnd, port, pwrIn, pwrOut } from "./pins";

const CORE = "Core Electronics (AU)";

export const ROBOTICS: CatalogPart[] = [
  // Waveshare ST3215: the Feetech STS3215 case and electronics in the 12 V, 30 kg·cm winding. Electrical
  // figures are Waveshare's (wiki page ST3215_Servo); the case, horns and holes are measured from the
  // maker's STEP file of the STS3215 (published with SO-ARM100), which is the same moulding.
  {
    id: "waveshare_st3215",
    kind: "servo",
    name: "Waveshare ST3215 serial bus servo, 30 kg·cm, 12 V",
    maker: "Waveshare",
    mpn: "ST3215",
    summary:
      "Smart servo on a one-wire serial bus: 2.9 N·m stall at 12 V, 45 rpm, 360° magnetic encoder (4096 counts) with position, speed, load, voltage, temperature and current read back, torque limit and continuous-turn mode set over the bus. Up to 253 daisy-chain on one UART through a bus servo adapter. Output horn and idler horn on one axis.",
    specs: {
      t_stall: 2942,
      v_min: 6,
      v_max: 12.6,
      v_rated: 12,
      speed_s_per_60: 0.222,
      rpm_free: 45,
      i_stall: 2.7,
      i_run: 0.2,
      i_idle: 0.05,
      range_deg: 360,
      encoder_counts: 4096,
      bus: "feetech_sts",
      baud: 1000000,
      id_default: 1,
      continuous: true,
      mass_g: 55,
      gears: "steel",
    },
    pins: [
      pwrIn("V_PLUS", 6, 12.6, { label: "VCC (middle pin)", draw: 0.5, vabs: 13, note: "6 to 12.6 V from the bus servo adapter's port, passed on through the servo's second socket to the next one in the chain" }),
      gnd("GND", "GND"),
      { id: "SIG", type: "in", vmax: 5.5, vih: 2.0, label: "Signal (half-duplex TTL)", required: true, note: "One-wire serial bus at 1 Mbps, shared by every servo in the chain. It goes to a bus servo adapter's servo port, not to a controller pin." },
    ],
    geom: {
      g: "bus_servo",
      dims: { l: 45.4, w: 24.8, h: 28.8, axis_x: 10.2, cover_x: 15.5, top_cover: 1.4, bottom_cover: 1.3, horn_d: 20, horn_t: 2.5, horn_top: 4.3, idler_t: 2.1, idler_top: 3.3, horn_pcd: 14, horn_hole: 2.5, hole_depth: 5, bottom_x1: -8.3, bottom_x2: -32.8, conn_x: 14.05 },
      holes: [[-29, 10.25], [-29, -10.25], [-8.3, 10.25], [-8.3, -10.25]],
      hole_d: 1.5,
      color: "#17191d",
      servo: { label: "#1c4fa3", text: "#eef1f5", spline: "#c4c9d0", spline_material: "Aluminum 6061" },
    },
    price_usd: 25,
    buy: [
      { vendor: CORE, url: "https://core-electronics.com.au/30kg-serial-bus-servo-high-precision-torque-360-degree-magnetic-encoder.html" },
      { vendor: "Waveshare", url: "https://www.waveshare.com/st3215-servo.htm" },
    ],
    source: "https://www.waveshare.com/wiki/ST3215_Servo",
    notes: [
      "Every servo ships as ID 1: give each its own ID, one at a time on the bus, before wiring the chain.",
      "Bolt a yoke to both horns (four M3 into each, 2.5 mm of thread) and the case to its cradle with M2 self-tapping screws into the cover holes: two on the top face and two on the bottom at the motor end is what the maker's own arms use.",
      "The two 3-pin sockets are in a recess in the bottom face, about 14 mm behind the axis: leave an opening under the servo for the plugs and leads. They are the same three wires, so either takes the lead in and the other passes it on.",
      "Stalled it draws 2.7 A: set its torque limit over the bus for what the joint needs, and size the supply for the joints that work together, not for all of them stalled at once.",
      "Hole depth in the covers is assumed 5 mm (not in the maker's drawing): use M2 × 6 self-tappers through a wall of 2 to 2.5 mm.",
    ],
    tests: ["Set each servo's ID and centre it (position 2048) before bolting its horn to a link, so every joint's zero is where the firmware expects."],
  },
  // Waveshare Bus Servo Adapter (A): 42 × 33 mm, 2.5 mm holes. Board outline, input range and the jumper are
  // Waveshare's; connector places are read off the product photos and are approximate (within a couple of mm).
  {
    id: "waveshare_bus_servo_adapter_a",
    kind: "motor_driver",
    name: "Waveshare Bus Servo Adapter (A)",
    maker: "Waveshare",
    mpn: "Bus Servo Adapter (A)",
    summary:
      "Puts a chain of ST/SC serial bus servos on a controller's UART (or a PC's USB): it turns TX and RX into the servos' one-wire half-duplex bus and passes the 9 to 12.6 V servo supply from its screw terminal or DC jack to the servo port.",
    specs: { channels: 1, i_cont: 6, v_min: 9, v_max: 12.6, control: "UART 1 Mbps (jumper A) or USB (jumper B)", bus: "feetech_sts", servos_max: 253 },
    pins: [
      { id: "VIN", type: "passive", through: "SERVO_V", label: "VIN + (screw terminal)", required: true, note: "9 to 12.6 V for the servos (the same net as the DC jack's centre pin). It goes straight through to the servo port." },
      gnd("GND", "VIN − (screw terminal)"),
      { id: "TX", type: "in", vmax: 5.5, vih: 2.0, label: "TX", required: true, note: "Wire it to the controller's TX: Waveshare labels this header TX to TX and RX to RX. Jumper on A for UART control." },
      { id: "RX", type: "out", v: 3.3, label: "RX", required: true, note: "Wire it to the controller's RX. The header's logic level is not in Waveshare's documents (they list 3.3 V boards as hosts): measure RX idle with a meter before connecting a 3.3 V controller." },
      gnd("UART_G", "GND (UART header)"),
      { id: "SERVO_V", type: "passive", through: "VIN", label: "Servo port VCC", required: true },
      gnd("SERVO_G", "Servo port GND"),
      { id: "SERVO_S", type: "out", v: 5, label: "Servo port signal", required: true, note: "The half-duplex bus to the first servo in the chain" },
    ],
    geom: {
      g: "board",
      dims: { w: 42, d: 33, t: 1.6 },
      // 2.5 mm holes in the corners
      holes: [[-18.5, -14], [18.5, -14], [-18.5, 14], [18.5, 14]],
      hole_d: 2.5,
      color: "#1d4f9c",
      features: [
        { kind: "jack", x: -14, y: 7.5, w: 14, d: 9, h: 11 },
        { kind: "terminal", x: -16.5, y: -6.5, w: 7.6, d: 10, h: 10 },
        { kind: "usb", x: 17, y: -5.5, w: 7.4, d: 9, h: 3.2 },
        { kind: "header", x: 6, y: 13.5, w: 7.62, d: 2.54, h: 8.5 },
        { kind: "socket", x: 16, y: 6, w: 5.8, d: 9.9, h: 7 },
        { kind: "chip", x: 3, y: -4, w: 5, d: 6.2, h: 1.6 },
        { kind: "header", x: 5, y: 3.5, w: 7.62, d: 2.54, h: 8.5 },
      ],
    },
    price_usd: 5,
    buy: [
      { vendor: CORE, url: "https://core-electronics.com.au/serial-bus-servo-driver-board.html" },
      { vendor: "Waveshare", url: "https://www.waveshare.com/bus-servo-adapter-a.htm" },
    ],
    source: "https://www.waveshare.com/wiki/Bus_Servo_Adapter_(A)",
    notes: [
      "Set the yellow jumper to A for a controller's UART, B for USB from a PC. In A, wire TX to TX and RX to RX (Waveshare's labels are the controller's, not the board's).",
      "The servo supply goes in at the screw terminal or the DC jack, never both, and must suit the servos: 12 V for ST3215.",
      "Connector positions on the board are approximate: fit the board before drilling anything around its plugs.",
    ],
  },
  // Arducam B0196: IMX219 on a 38 × 38 mm UVC board. Resolution, field of view, focus range and the lead
  // are Arducam's listing; the hole pattern is the 34 mm one of their 38 mm boards (the 28 mm one also fits).
  {
    id: "arducam_b0196",
    kind: "sensor",
    name: "Arducam 8 MP IMX219 USB camera module (B0196)",
    maker: "Arducam",
    mpn: "B0196",
    summary: "Driverless (UVC) USB 2.0 camera on a 38 × 38 mm board: 3264 × 2448 stills, 1080p at 30 fps, 62° × 49° field of view, focus from 200 mm. A robot's eye, read by the computer that runs it.",
    specs: { sensor: "IMX219", iface: "usb_uvc", w_px: 3264, h_px: 2448, fov_h: 62.2, fov_v: 48.8, focus_min: 200, fps_1080p: 30, lead_m: 1, mass_g: 12 },
    pins: [port("USB", "usb", "sink", { label: "USB 2.0 (4-pin lead, 1 m)", note: "Plugs into the computer that runs the robot, not into the controller" })],
    geom: {
      g: "board",
      dims: { w: 38, d: 38, t: 1.6 },
      holes: [[-17, -17], [17, -17], [-17, 17], [17, 17]],
      hole_d: 2.2,
      color: "#16181b",
      features: [
        { kind: "module", x: 0, y: 0, w: 8.5, d: 8.5, h: 5.2 },
        { kind: "socket", x: 0, y: -15.5, w: 7.5, d: 4.5, h: 3.6 },
        { kind: "chip", x: 10, y: 6, w: 6, d: 6, h: 0.9 },
      ],
    },
    price_usd: 33,
    buy: [
      { vendor: CORE, url: "https://core-electronics.com.au/8mp-1080p-usb-camera-module-14-cmos-imx219-mini-uvc-usb20-webcam.html" },
      { vendor: "Arducam", url: "https://www.arducam.com/product/b0196arducam-8mp-1080p-usb-camera-module-1-4-cmos-imx219-mini-uvc-usb2-0-webcam-board-with-1-64ft-0-5m-usb-cable-for-windows-linux-android-and-mac-os/" },
    ],
    source: "https://core-electronics.com.au/8mp-1080p-usb-camera-module-14-cmos-imx219-mini-uvc-usb20-webcam.html",
    notes: ["Hole pattern assumed 34 × 34 mm, 2.2 mm (Arducam's 38 mm boards): check yours before printing its bracket.", "Its 62° view covers a 400 mm wide bench from about 330 mm away."],
  },
  {
    id: "psu_12v_10a",
    kind: "psu",
    name: "12 V 10 A desktop power supply (5.5 × 2.1 mm plug)",
    generic: true,
    summary: "Sealed desktop supply, 100 to 240 V AC in, 12 V 10 A out (120 W) on a 1.2 m lead. Feeds a dozen bus servos or a strip of motors with no mains wiring inside the design.",
    specs: { v_out: 12, i_out: 10, power_w: 120, plug: "5.5 × 2.1 mm centre positive", lead_m: 1.2 },
    pins: [pwrOut("VPOS", 12, 10, { label: "+12 V (centre)" }), gnd("VNEG", "0 V (sleeve)")],
    geom: { g: "brick", dims: { w: 170, d: 65, h: 40 }, color: "#1b1d21" },
    sim: { k: "supply", pos: "VPOS", neg: "VNEG", v: 12, r: 0.05 },
    external: true,
    price_usd: 30,
    buy: [{ vendor: "Jaycar (AU)", url: "https://www.jaycar.com.au/12v-dc-10a-desktop-power-supply-2-1mm-dc-plug/p/MP3241" }, { vendor: "Marketplace", search: "12V 10A 120W desktop power supply 5.5x2.1mm" }],
    notes: [
      "Buy one with a safety approval mark (RCM in Australia) from a known seller: it is the only mains part.",
      "A 5.5 × 2.1 mm barrel socket is usually rated 5 A: past that, cut the plug off and take the lead to a fuse and screw terminals, or use a socket rated for the current.",
      "Past about 12 A it cuts out and restarts by itself.",
    ],
  },
];
