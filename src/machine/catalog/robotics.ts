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
      hole_d: 1.6,
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
      "The cover holes are drawn at 1.6 mm, the pilot of an M2 thread-forming screw (the maker's CAD has them at 1.5), and their depth is assumed 5 mm (not in the maker's drawing): use M2 × 8 screws through a wall of 3 to 3.5 mm, or M2 × 6 through 2.4 mm.",
    ],
    tests: ["Set each servo's ID and centre it (position 2048) before bolting its horn to a link, so every joint's zero is where the firmware expects."],
  },
  // Waveshare Bus Servo Adapter (A): 42 × 33 mm with 2.5 mm holes on 37 × 28 mm (Waveshare's wiki and listing). What is
  // on it is from Waveshare's schematic: a DC005 5.5 × 2.1 mm jack, a green KF350 two-way screw terminal, USB-C on a
  // CH343P, two 3-pin servo ports on one bus, the UART header and the three-pin A/B jumper. Where each sits on the
  // board is not in any text Waveshare publishes, so the places here are approximate (within a few mm).
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
        { kind: "jack", x: -13.9, y: 7.5, w: 14.2, d: 9, h: 11 },
        { kind: "terminal", x: -17, y: -6.5, w: 7, d: 7, h: 8.5 },
        { kind: "usb", x: 17, y: -5.5, w: 7.4, d: 9, h: 3.2 },
        { kind: "header", x: 6, y: 13.5, w: 7.62, d: 2.54, h: 8.5 },
        { kind: "socket", x: 16, y: 6, w: 5.8, d: 9.9, h: 7 },
        { kind: "chip", x: 3, y: -4, w: 3, d: 3, h: 0.8 },
        { kind: "header", x: 0.5, y: 3.5, w: 7.62, d: 2.54, h: 8.5 },
        { kind: "socket", x: 9.6, y: 6, w: 5.8, d: 9.9, h: 7 },
        { kind: "module", x: -4, y: -9.5, w: 6, d: 6, h: 2 },
        { kind: "chip", x: 9, y: -11, w: 5, d: 6.2, h: 1.6 },
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
      "It has two servo ports on the same bus: use either, or start a second chain from the other.",
      "Connector positions on the board are approximate: fit the board before drilling anything around its plugs.",
    ],
  },
  // Arducam B0196: IMX219 with its stock lens on a 38 × 38 mm UVC board. Size, both hole patterns (34 and 28 mm), the
  // lens, field of view and the lead socket (a JST ZH top-entry B4B-ZR, on the back) are Arducam's; where the socket
  // sits on the back and the hole diameter are not published, so those are approximate.
  {
    id: "arducam_b0196",
    kind: "sensor",
    name: "Arducam 8 MP IMX219 USB camera module (B0196)",
    maker: "Arducam",
    mpn: "B0196",
    summary: "Driverless (UVC) USB 2.0 camera on a 38 × 38 mm board: 3264 × 2448 stills, 1080p at 30 fps, 62° × 49° field of view, fixed focus from 40 mm (F2.0, 3.04 mm). Its 1 m lead plugs into a small socket on the back. A robot's eye, read by the computer that runs it.",
    specs: { sensor: "IMX219", iface: "usb_uvc", w_px: 3264, h_px: 2448, fov_h: 62.2, fov_v: 48.8, focus_min: 40, fps_1080p: 30, lead_m: 1, mass_g: 12 },
    pins: [port("USB", "usb", "sink", { label: "USB 2.0 (4-pin JST ZH lead, 1 m, on the back)", note: "Plugs into the computer that runs the robot, not into the controller" })],
    geom: {
      g: "board",
      dims: { w: 38, d: 38, t: 1.6 },
      // the 34 mm pattern first (the corners), then the 28 mm one
      holes: [[-17, -17], [17, -17], [-17, 17], [17, 17], [-14, -14], [14, -14], [-14, 14], [14, 14]],
      hole_d: 2.2,
      color: "#16181b",
      features: [
        { kind: "module", x: 0, y: 0, w: 8.5, d: 8.5, h: 5.2 },
        { kind: "chip", x: 10, y: 6, w: 6, d: 6, h: 0.9 },
        { kind: "socket", x: 0, y: -8.5, w: 7.5, d: 3.5, h: 4.5, side: "bottom", color: "#e9e5d8" },
      ],
    },
    price_usd: 33,
    buy: [
      { vendor: CORE, url: "https://core-electronics.com.au/8mp-1080p-usb-camera-module-14-cmos-imx219-mini-uvc-usb20-webcam.html" },
      { vendor: "Arducam", url: "https://www.arducam.com/product/b0196arducam-8mp-1080p-usb-camera-module-1-4-cmos-imx219-mini-uvc-usb2-0-webcam-board-with-1-64ft-0-5m-usb-cable-for-windows-linux-android-and-mac-os/" },
    ],
    source: "https://core-electronics.com.au/8mp-1080p-usb-camera-module-14-cmos-imx219-mini-uvc-usb20-webcam.html",
    notes: [
      "The lead's plug stands straight out of the back of the board: mount it on standoffs at least 9 mm tall, or leave an opening behind the socket.",
      "Holes are drawn 2.2 mm for M2 screws (the diameter is not published): check yours before printing its bracket.",
      "Its 62° view covers a 400 mm wide bench from about 330 mm away.",
    ],
  },
  // A wrist camera: the 8 mm head of a USB endoscope, the cheapest driverless camera that focuses up close. `at` is
  // the lead end of the head and its axis points out of the lens.
  {
    id: "usb_endoscope_8mm",
    kind: "sensor",
    name: "USB endoscope camera, 8 mm head, 2 m lead",
    generic: true,
    summary: "Driverless (UVC) USB camera in a sealed 8 mm tube 40 mm long, with six dimmable LEDs round the lens: 1280 × 720, about 70° field of view, sharp from 30 to 100 mm. Small and light enough to ride on a robot's wrist for a close view of what the gripper holds.",
    specs: { iface: "usb_uvc", w_px: 1280, h_px: 720, fov_h: 70, focus_min: 30, focus_max: 100, d: 8, h: 40, lead_m: 2, mass_g: 12 },
    pins: [port("USB", "usb", "sink", { label: "USB 2.0 (2 m lead with the LED dimmer in line)", note: "Plugs into the computer that runs the robot, not into the controller" })],
    geom: { g: "endoscope", dims: { d: 8, h: 40, cable_d: 4, cable_l: 30 }, color: "#22252a", material: "Aluminum 6061" },
    price_usd: 14,
    buy: [{ vendor: "Marketplace", search: "USB endoscope camera 8mm 720p UVC 2m" }],
    notes: ["Heads are sold as 5.5, 7 and 8 mm: measure yours and size its cradle to it.", "The lead is the stiffest thing on the wrist: tie it along the arm with a loose loop at every joint."],
  },
  // DFRobot FIT0819: the endoscope Australian shops stock. Head diameter, resolution, field of view, lead length and
  // the three plugs are DFRobot's; the head's length is not published (40 mm is usual for an 8 mm head).
  {
    id: "dfrobot_fit0819",
    kind: "sensor",
    name: "DFRobot 3-in-1 waterproof USB endoscope camera, 8 mm head, 5 m lead (FIT0819)",
    maker: "DFRobot",
    mpn: "FIT0819",
    summary: "Driverless (UVC) USB camera in a sealed black 8 mm head on a 5 m semi-rigid lead that ends in a micro USB plug with USB-A and USB-C adapters: 1600 × 1200, 70° field of view, lights round the lens, IP67. Shows up on a computer as a webcam with no driver.",
    specs: { iface: "usb_uvc", w_px: 1600, h_px: 1200, fov_h: 70, d: 8, h: 40, lead_m: 5, ip: 67, mass_g: 12 },
    pins: [port("USB", "usb", "sink", { label: "USB 2.0 (5 m lead: micro USB, with USB-A and USB-C adapters)", note: "Plugs into the computer that runs the robot, not into the controller" })],
    geom: { g: "endoscope", dims: { d: 8, h: 40, cable_d: 5, cable_l: 34, boot_l: 9 }, color: "#1b1c1f", material: "Aluminum 6061" },
    price_usd: 19.9,
    buy: [
      { vendor: CORE, url: "https://core-electronics.com.au/3-in-1-waterproof-usb-endoscope-inspection-camera.html" },
      { vendor: "DFRobot", url: "https://www.dfrobot.com/product-2328.html" },
    ],
    source: "https://www.dfrobot.com/product-2328.html",
    notes: [
      "The head's length is not in DFRobot's listing: measure it before printing a cradle (40 mm drawn).",
      "The weight given is an estimate of the head and the first of its lead, which is what a moving arm carries; the rest of the 5 m lead weighs several times that and should be tied off so the arm does not carry it.",
      "The lead is semi-rigid and holds the shape it is bent to: on a moving arm, tie it down just behind the head, leave a wide loop at every joint, and coil the spare length away from the arm.",
    ],
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
    buy: [{ vendor: "Marketplace", search: "12V 10A 120W desktop power supply 5.5x2.1mm" }],
    notes: [
      "Buy one with a safety approval mark (RCM in Australia) from a known seller: it is the only mains part.",
      "A 5.5 × 2.1 mm barrel socket is usually rated 5 A: past that, cut the plug off and take the lead to a fuse and screw terminals, or use a socket rated for the current.",
      "Past about 12 A it cuts out and restarts by itself.",
    ],
  },
  // Jaycar MP3241: a 120 W desktop brick, 174 × 72 × 44 mm, with a mains lead (IEC inlet) and a 1.2 m DC lead ending
  // in a 5.5 × 2.1 mm plug. Size and leads are from the listing; the inlet is drawn as the usual three-pin C14.
  {
    id: "psu_jaycar_mp3241",
    kind: "psu",
    name: "Jaycar MP3241 12 V 10 A desktop power supply (5.5 × 2.1 mm plug)",
    maker: "Jaycar",
    mpn: "MP3241",
    summary: "Sealed 120 W desktop supply, 100 to 240 V AC in on a 1.2 m mains lead, 12 V 10 A out on a 1.2 m lead with a 5.5 × 2.1 mm plug. Feeds a dozen bus servos with no mains wiring inside the design.",
    specs: { v_out: 12, i_out: 10, power_w: 120, plug: "5.5 × 2.1 mm, 10 mm long", lead_m: 1.2 },
    pins: [pwrOut("VPOS", 12, 10, { label: "+12 V (centre)" }), gnd("VNEG", "0 V (sleeve)")],
    // drawn with its plug cut off: past 5 A the lead is wired in, not plugged in
    geom: { g: "desk_supply", dims: { w: 174, d: 72, h: 44, inlet: 14, cord_d: 5.5, cord_l: 60, foot_h: 1 }, color: "#16181c" },
    sim: { k: "supply", pos: "VPOS", neg: "VNEG", v: 12, r: 0.05 },
    external: true,
    price_usd: 58,
    buy: [{ vendor: "Jaycar (AU)", url: "https://www.jaycar.com.au/12v-dc-10a-desktop-power-supply-2-1mm-dc-plug/p/MP3241" }],
    source: "https://www.jaycar.com.au/12v-dc-10a-desktop-power-supply-2-1mm-dc-plug/p/MP3241",
    notes: [
      "It is the only mains part: leave it sealed and outside the machine.",
      "A 5.5 × 2.1 mm barrel socket is usually rated 5 A. To draw more, cut the plug off and take the lead to the fuses through ferrules or lever connectors (check which core is positive with a meter first: the centre of the plug).",
      "Check the mains inlet on yours (drawn as a three-pin IEC C14): the listing says a mains lead is supplied but not which.",
    ],
  },
];
