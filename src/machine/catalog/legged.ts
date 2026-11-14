// Legged-robot parts: the quasi-direct-drive actuators a quadruped walks on,
// the CAN bus that commands them, the controller and computer that run the
// gait, the depth camera it sees with, and the power parts between its pack
// and its legs. Shapes come from the makers' drawings where they publish
// them; where a figure is read off photos instead, the entry's notes say so.

import type { CatalogPart, PinDef } from "../types";
import { gnd, pwrIn, pwrOut, port } from "./pins";

const CORE = "Core Electronics (AU)";

/** A Teensy 4.x pin: 3.3 V only, every pin PWM-capable or not as PJRC's card says. */
const tPin = (n: number, extra: Partial<PinDef> = {}): PinDef => ({
  id: `D${n}`,
  label: String(n),
  type: "io",
  v: 3.3,
  imax: 0.004,
  pwm: TEENSY_PWM.has(n),
  irq: true,
  adc: TEENSY_ADC.has(n) || undefined,
  mcu: String(n),
  ...extra,
});
const TEENSY_PWM = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 36, 37]);
const TEENSY_ADC = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 38, 39, 40, 41]);
const TEENSY_NOTE: Record<number, Partial<PinDef>> = {
  0: { note: "CRX2 (CAN2 receive) or RX1" },
  1: { note: "CTX2 (CAN2 transmit) or TX1" },
  13: { note: "The orange LED" },
  18: { bus: "i2c_sda", note: "SDA (Wire)" },
  19: { bus: "i2c_scl", note: "SCL (Wire)" },
  22: { note: "CTX1 (CAN1 transmit)" },
  23: { note: "CRX1 (CAN1 receive)" },
  30: { note: "CRX3 (CAN3, CAN FD receive)" },
  31: { note: "CTX3 (CAN3, CAN FD transmit)" },
};
const tp = (n: number) => tPin(n, TEENSY_NOTE[n]);

export const LEGGED: CatalogPart[] = [
  // CubeMars AK70-10 KV100: a 10:1 planetary gearbox inside an outrunner, with its driver, a 14-bit encoder and a
  // CAN port in the back cover. Figures are CubeMars' (AK70-10 product page and manual, V3 firmware, MIT mode).
  {
    id: "cubemars_ak70_10",
    kind: "servo",
    name: "CubeMars AK70-10 KV100 actuator, 24.8 N·m peak, CAN",
    maker: "CubeMars",
    mpn: "AK70-10 KV100",
    summary:
      "Quasi-direct-drive robot joint: a 10:1 planetary inside a brushless outrunner with its own FOC driver and 14-bit encoder, commanded over CAN at 1 Mbps. In MIT mode each frame sets position, speed, stiffness, damping and feed-forward torque; it answers with position, speed, current and temperature. 8.3 N·m rated, 24.8 N·m peak, back-drivable, 521 g.",
    specs: {
      t_stall: 24800,
      t_peak: 24800,
      t_rated: 8300,
      rpm_free: 240,
      speed_s_per_60: 0.042,
      v_min: 18,
      v_max: 52,
      v_rated: 24,
      kv: 100,
      ratio: 10,
      kt: 0.123,
      i_rated: 7.2,
      i_stall: 23.2,
      i_run: 1.2,
      i_idle: 0.12,
      r_phase: 0.272,
      range_deg: 1432,
      encoder_bits: 14,
      backlash_deg: 0.25,
      bus: "cubemars_mit",
      baud: 1000000,
      id_default: 1,
      p_max_rad: 12.5,
      v_max_rad_s: 50,
      t_max_nm: 25,
      kp_max: 500,
      kd_max: 5,
      rotor_inertia: 0.000121,
      mass_g: 521,
    },
    pins: [
      pwrIn("V_PLUS", 18, 52, { label: "+ (XT30)", draw: 1.2, vabs: 56, note: "24 to 48 V for the driver and motor, through the XT30 socket in the back cover" }),
      gnd("GND", "− (XT30)"),
      { id: "CAN_H", type: "passive", label: "CAN_H", required: true, note: "CAN high, 1 Mbps. Daisy-chain the actuators on one twisted pair, 120 Ω at each end of the bus" },
      { id: "CAN_L", type: "passive", label: "CAN_L", required: true, note: "CAN low" },
    ],
    conns: [
      { id: "POWER", name: "XT30 power socket", pins: ["V_PLUS", "GND"], how: "XT30PW-M socket in the back cover: an XT30 plug on 14 AWG silicone", keyed: true },
      { id: "CAN", name: "CAN socket", pins: ["CAN_H", "CAN_L"], how: "A1257WR-S 1.25 mm socket beside the XT30: CAN_H and CAN_L on a twisted pair", keyed: true },
    ],
    geom: {
      g: "qdd",
      dims: { d: 89, l: 44, cover_d: 64, cover_t: 2.5, flange_d: 44, flange_t: 1.5, front_d: 80, front_l: 4.5, out_pcd: 36, out_n: 8, mount_pcd: 76, mount_n: 6 },
      color: "#202226",
      color2: "#b9bdc3",
    },
    price_usd: 398.9,
    buy: [{ vendor: "CubeMars (maker's store, ships to AU)", url: "https://www.cubemars.com/goods-1031-AK70-10.html" }],
    source: "https://www.cubemars.com/goods-1031-AK70-10.html",
    notes: [
      "Specialist part: sold by CubeMars' own store, not by an Australian shop.",
      "Its outline (Ø89 × 44 mm body, Ø44 output flange) is CubeMars' drawing. The bolt circles (8 × M3 on 36 mm in the output, 6 × M3 on 76 mm in the back face) are read off the drawing image: check them against your actuator before machining the brackets.",
      "Every actuator ships as CAN ID 1: give each its own ID in CubeMars' upper-computer software, one at a time on the bus, before wiring the chain.",
      "Enter MIT mode (FF FF FF FF FF FF FF FC) before sending commands, and leave it (… FD) before cutting power, or it holds its last command.",
      "The driver regenerates into the supply when the leg is pushed back: the pack must accept the charge (a LiPo does; a bench supply may trip).",
    ],
    tests: ["With the leg off the ground, send kp 5 kd 0.5 and step the position 0.2 rad: the joint follows with no buzz or overshoot.", "Read back every ID on both buses before standing the robot up."],
  },

  // PJRC Teensy 4.1: NXP i.MX RT1062 at 600 MHz with three CAN controllers (CAN3 is CAN FD), 48 pins on two rows
  // of 24 at 0.6 in, micro USB at one end. Pinout is PJRC's card; size 2.4 × 0.7 in.
  {
    id: "teensy_41",
    kind: "controller",
    name: "PJRC Teensy 4.1 (i.MX RT1062, 600 MHz)",
    maker: "PJRC",
    mpn: "TEENSY41",
    summary:
      "Cortex-M7 at 600 MHz with an FPU, 8 MB flash and 1 MB RAM on a 61 × 18 mm board: three CAN controllers (CAN1 and CAN2 classic, CAN3 CAN FD), 8 serial ports, 3 I2C, 35 PWM, 18 analog. 3.3 V logic, not 5 V tolerant. Fast enough to run a 12-joint gait and both CAN buses at 500 Hz.",
    specs: { mcu: "IMXRT1062", logic_v: 3.3, clock_mhz: 600, flash_kb: 7936, ram_kb: 1024, digital: 42, pwm: 35, analog: 18, can: 3, platform: "teensy", fqbn: "teensy:avr:teensy41", pio_board: "teensy41", vin_min: 3.6, vin_max: 5.5, mass_g: 5 },
    pins: [
      // the row along -Y from the USB end: GND, 0 to 12, 3.3V, 24 to 32
      { id: "GND", type: "gnd", label: "GND", required: true },
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(tp),
      pwrOut("V3V3", 3.3, 0.25, { label: "3.3V", note: "The onboard regulator's output: 250 mA to spare for the CAN transceivers and the IMU" }),
      ...[24, 25, 26, 27, 28, 29, 30, 31, 32].map(tp),
      // the row along +Y from the USB end: VIN, GND, 3.3V, 23 to 13, GND, 41 to 33
      pwrIn("VIN", 3.6, 5.5, { label: "VIN", draw: 0.1, vabs: 6, note: "3.6 to 5.5 V. Cut the VIN-VUSB pads under the board if USB and VIN may be powered together" }),
      { id: "GND2", type: "gnd", label: "GND" },
      { id: "V3V3_B", type: "passive", label: "3.3V", note: "Joined to the other 3.3V pin on the board" },
      ...[23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13].map(tp),
      { id: "GND3", type: "gnd", label: "GND" },
      ...[41, 40, 39, 38, 37, 36, 35, 34, 33].map(tp),
      port("USB", "usb", "sink", { label: "Micro USB (to the computer: Serial, programming)", note: "A USB device: the host powers VUSB" }),
    ],
    geom: {
      g: "board",
      dims: { w: 60.96, d: 17.78, t: 1.6 },
      features: [
        { kind: "usb", x: -28.2, y: 0, w: 5.8, d: 7.6, h: 2.8 },
        { kind: "chip", x: -6, y: 0, w: 12, d: 12, h: 1.2 },
        { kind: "chip", x: 9, y: -3.2, w: 5.2, d: 4.1, h: 0.8 },
        { kind: "socket", x: 24.4, y: 0, w: 11.5, d: 12, h: 1.8 },
      ],
      color: "#1f7a3a",
    },
    price_usd: 46.0,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/teensy-4-1.html" }, { vendor: "PJRC", url: "https://www.pjrc.com/store/teensy41.html" }],
    source: "https://www.pjrc.com/store/teensy41.html",
    notes: [
      "3.3 V only: a 5 V signal on any pin damages it.",
      "CAN needs a transceiver per bus (SN65HVD230 at 3.3 V): CTX1/CRX1 are pins 22/23, CTX2/CRX2 pins 1/0.",
      "Program it with Teensyduino; FlexCAN_T4 comes with it.",
    ],
  },

  // SparkFun's TXB0104 translator: the Teensy's 3.3 V data line up to the 5 V the status LEDs need (WS2812B reads high above 3.5 V).
  {
    id: "sparkfun_txb0104",
    kind: "connector",
    name: "SparkFun Voltage-Level Translator Breakout, TXB0104 (BOB-11771)",
    maker: "SparkFun",
    mpn: "BOB-11771",
    summary: "Four-bit bidirectional level translator, TI TXB0104: 1.2 to 3.6 V on the A side, 1.65 to 5.5 V on the B side, up to 100 Mbps, so it carries a NeoPixel's 800 kHz data cleanly.",
    specs: { va_min: 1.2, va_max: 3.6, vb_min: 1.65, vb_max: 5.5, rate_mbps: 100, mass_g: 1 },
    // in header order: the low-voltage (A) row along one edge, the high-voltage (B) row along the other
    pins: [
      pwrIn("VA", 1.2, 3.6, { label: "VCCA", draw: 0.001, vabs: 4.6 }),
      { id: "A1", type: "in", vmax: 3.6, vih: 1.6, label: "A1", required: true, note: "Low side in, at VCCA" },
      { id: "A2", type: "in", vmax: 3.6, vih: 1.6, label: "A2" },
      { id: "OE", type: "in", vmax: 3.6, vih: 1.0, label: "OE", note: "Pulled up to VCCA on the board: leave it open to run" },
      pwrIn("VB", 1.65, 5.5, { label: "VCCB", draw: 0.001, vabs: 6.5 }),
      { id: "B1", type: "out", v: 5, vref: "VB", label: "B1", note: "High side out, at VCCB" },
      { id: "B2", type: "out", v: 5, vref: "VB", label: "B2" },
      gnd("GND", "GND"),
    ],
    geom: {
      g: "board",
      dims: { w: 15.2, d: 15.2, t: 1.6 },
      holes: [],
      features: [
        { kind: "chip", x: 0, y: 0, w: 4, d: 3.5, h: 1 },
        { kind: "header", x: 0, y: -6.35, w: 10.16, d: 2.54, h: 8.5 },
        { kind: "header", x: 0, y: 6.35, w: 10.16, d: 2.54, h: 8.5 },
      ],
      color: "#c0262d",
    },
    price_usd: 6.5,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/sparkfun-voltage-level-translator-breakout-txb0104.html" }],
    source: "https://www.sparkfun.com/products/11771",
    notes: ["Its 0.1 in pads take a header strip or wires soldered straight on; the board has no mounting holes."],
  },
  // Waveshare SN65HVD230 CAN Board: TI's 3.3 V CAN transceiver with a 120 Ω terminator fitted, a 4-pin header to the
  // controller and the bus on a 2-way screw terminal (Core Electronics' listing). Its size is read off photos.
  {
    id: "waveshare_sn65hvd230",
    kind: "connector",
    name: "Waveshare SN65HVD230 CAN board (3.3 V transceiver)",
    maker: "Waveshare",
    mpn: "SN65HVD230 CAN Board",
    summary: "Turns a controller's CAN TX and RX into a CAN bus pair: TI SN65HVD230 at 3.3 V with ESD protection and a 120 Ω terminator fitted, so it is one end of the bus. Up to 1 Mbps.",
    specs: { v_min: 3.0, v_max: 3.6, baud_max: 1000000, terminator_ohm: 120, mass_g: 4 },
    // in the order they meet their wires: the bus pair in the screw terminal, then the 4-pin header
    pins: [
      { id: "CAN_H", type: "passive", label: "CANH", required: true },
      { id: "CAN_L", type: "passive", label: "CANL", required: true },
      pwrIn("V3V3", 3.0, 3.6, { label: "3.3V", draw: 0.017, vabs: 4 }),
      gnd("GND", "GND"),
      { id: "CAN_TX", type: "in", vmax: 3.6, vih: 2.0, label: "CAN TX", required: true, note: "From the controller's CTX pin" },
      { id: "CAN_RX", type: "out", v: 3.3, label: "CAN RX", required: true, note: "To the controller's CRX pin" },
    ],
    geom: {
      g: "board",
      dims: { w: 36, d: 22, t: 1.6 },
      holes: [[-14.5, -7.5], [-14.5, 7.5]],
      hole_d: 3.0,
      features: [
        { kind: "chip", x: 1, y: 0, w: 5, d: 6.2, h: 1.6 },
        { kind: "terminal", x: 13.5, y: 0, w: 7.6, d: 10.2, h: 10 },
        { kind: "header", x: -9.5, y: 0, w: 2.54, d: 10.16, h: 8.5 },
      ],
      color: "#1d4fa0",
    },
    price_usd: 5.2,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/sn65hvd230-can-bus-transceiver-board-3-3v.html" }],
    source: "https://core-electronics.com.au/sn65hvd230-can-bus-transceiver-board-3-3v.html",
    notes: [
      "The board's 120 Ω terminator makes it one end of the bus: the far end needs another 120 Ω across CAN_H and CAN_L.",
      "Its size and the hole places are read off photos (Waveshare publishes no drawing): check yours.",
    ],
  },

  // NVIDIA Jetson Orin Nano Super Developer Kit: the 8 GB module on its reference carrier with the fan heat sink.
  // 100 × 79 × 21 mm (NVIDIA / Core Electronics); the DC jack takes 9 to 20 V (NVIDIA developer forum).
  {
    id: "jetson_orin_nano_super",
    kind: "host",
    name: "NVIDIA Jetson Orin Nano Super Developer Kit (8 GB)",
    maker: "NVIDIA",
    mpn: "945-13766-0005-000",
    summary:
      "Linux computer for robots: 6-core Arm Cortex-A78AE, a 1024-core Ampere GPU (67 TOPS in Super mode), 8 GB, on a 100 × 79 mm carrier with 4 × USB 3.2, gigabit Ethernet, DisplayPort, two camera ports and two M.2 slots. Runs the depth camera, mapping and the high-level planner; 7 to 25 W.",
    specs: { cpu: "6-core Cortex-A78AE", ram_gb: 8, tops: 67, v_in_min: 9, v_in_max: 20, power_w: 25, mass_g: 176, os: "JetPack 6 (Ubuntu 22.04)" },
    pins: [
      pwrIn("DC_IN", 9, 20, { label: "DC IN (5.5 × 2.5 mm jack)", draw: 1.25, vabs: 21, note: "9 to 20 V; 25 W in Super mode is about 2.1 A at 12 V" }),
      gnd("GND", "DC IN −"),
      port("USB1", "usb", "source", { label: "USB 3.2 type A (top left)" }),
      port("USB2", "usb", "source", { label: "USB 3.2 type A (bottom left)" }),
      port("USB3", "usb", "source", { label: "USB 3.2 type A (top right)" }),
      port("USB4", "usb", "source", { label: "USB 3.2 type A (bottom right)" }),
    ],
    geom: { g: "jetson_devkit", dims: { w: 100, d: 79, t: 1.6, h: 21, hole_x: 86, hole_y: 58, hole_d: 2.7 }, color: "#1a1c20" },
    price_usd: 500,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/nvidia-jetson-orin-nano-developer-kit.html" }],
    source: "https://developer.nvidia.com/embedded/learn/jetson-orin-nano-devkit-user-guide/index.html",
    notes: [
      "Comes with a 19 V supply for the bench; on the robot feed the jack 12 V from a step-down regulator.",
      "Its four carrier holes (Ø2.7 for M2.5) are drawn 86 × 58 mm apart, the reference carrier's spacing: check yours.",
    ],
  },

  // Intel RealSense D435i: stereo depth with an IR projector, an RGB camera and a BMI055 IMU in a 90 × 25 × 25 mm
  // aluminium case; USB-C 3.1, one 1/4-20 thread under it and two M3 threads 45 mm apart in the back (Intel's datasheet).
  {
    id: "realsense_d435i",
    kind: "sensor",
    name: "Intel RealSense D435i depth camera",
    maker: "Intel",
    mpn: "82635DSD435IMP",
    summary: "Stereo depth camera with an infrared pattern projector, a 1080p colour camera and a 6-axis IMU: depth to 10 m at up to 90 fps over USB-C 3.1. 87° × 58° depth field of view. 72 g.",
    specs: { iface: "usb", depth_fov_h: 87, depth_fov_v: 58, range_m: 10, baseline_mm: 50, fps: 90, power_w: 3.5, mass_g: 72 },
    pins: [port("USB", "usb", "sink", { label: "USB-C 3.1 (on the right end)", note: "Plugs into the computer (a USB 3 port, or it falls back to USB 2 at lower rates)" })],
    geom: { g: "depth_camera", dims: { w: 90, d: 25, h: 25, baseline: 50, m3_pitch: 45 }, color: "#8b9097", color2: "#0d0e10" },
    price_usd: 499,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/intel-realsense-depth-camera-d435i.html" }, { vendor: "Intel RealSense store", url: "https://store.intelrealsense.com/buy-intel-realsense-depth-camera-d435i.html" }],
    source: "https://www.intelrealsense.com/depth-camera-d435i/",
    notes: ["Use a short, good USB 3 cable: a long or USB 2 lead drops it to low frame rates."],
  },

  // Tattu 10000 mAh 6S 30C with an XT90-S anti-spark plug: 175 × 65 × 58 mm, 1357 g (Gens Ace / Tattu store).
  {
    id: "tattu_6s_10000_xt90",
    kind: "battery",
    name: "Tattu 10000 mAh 6S 30C LiPo (XT90-S)",
    maker: "Tattu (Gens Ace)",
    mpn: "TAA10K6S30X9",
    summary: "22.2 V nominal (19.8 to 25.2 V), 10 Ah, 222 Wh LiPo with an XT90-S anti-spark plug on 10 AWG leads: an hour or more of walking for a 12 kg quadruped. 1357 g.",
    specs: { cells: 6, chemistry: "LiPo", v_nom: 22.2, v_max: 25.2, v_min: 19.8, capacity_mah: 10000, c_rating: 30, i_cont: 100, energy_wh: 222, connector: "XT90-S", mass_g: 1357 },
    pins: [pwrOut("POS", 22.2, 100, { label: "+", vmin: 19.8, vmax: 25.2, note: "Nominal 22.2 V, 19.8 to 25.2 V over the charge" } as Partial<PinDef>), gnd("NEG", "−")],
    conns: [{ id: "LEAD", name: "XT90-S lead", pins: ["POS", "NEG"], lead: { mm: 120, gauge: 10, colors: ["red", "black"], end: "XT90-S plug" } }],
    geom: { g: "box", style: "lipo", dims: { w: 175, d: 65, h: 58, r: 3, band: 30 }, color: "#16181c", color2: "#e2a52a", material: "PVC" },
    price_usd: 190,
    buy: [{ vendor: "Gens Ace / Tattu store", url: "https://www.gensace.de/tattu-10000mah-22-2v-30c-6s1p-lipo-battery-pack-with-xt90-anti-spark-plug.html" }],
    source: "https://www.gensace.de/tattu-10000mah-22-2v-30c-6s1p-lipo-battery-pack-with-xt90-anti-spark-plug.html",
    notes: ["Charge it out of the robot, on a LiPo balance charger, in a LiPo bag.", "Store it at 3.85 V a cell; never run a cell under 3.3 V under load."],
  },

  // Pololu D36V50F12: 12 V 4.5 A synchronous buck, 13 to 50 V in, on a 1 × 1 in board (Pololu 4095).
  {
    id: "pololu_d36v50f12",
    kind: "regulator",
    name: "Pololu 12 V 4.5 A step-down regulator D36V50F12",
    maker: "Pololu",
    mpn: "4095",
    summary: "Fixed 12 V at up to 4.5 A from 13 to 50 V input, reverse-voltage protected. Powers a Jetson or a 12 V computer from a 6S pack.",
    specs: { v_in_min: 13, v_in_max: 50, v_out: 12, i_out: 4.5, efficiency: 0.94, mass_g: 7 },
    pins: [
      pwrIn("VIN", 13, 50, { vabs: 50, draw: 0.004 }),
      gnd(),
      pwrOut("VOUT", 12, 4.5),
      { id: "EN", type: "in", vmax: 50, vih: 1.2, note: "Leave unconnected to run; pull low to turn the output off" },
      { id: "PG", type: "out", v: 12, label: "PG", note: "Power good: open drain, low while the output is out of regulation" },
    ],
    geom: { g: "board", dims: { w: 25.4, d: 25.4, t: 1.6 }, holes: [[-10.16, -10.16], [10.16, -10.16], [-10.16, 10.16]], hole_d: 2.2, features: [{ kind: "module", x: 2, y: 2, w: 12, d: 12, h: 7.9 }] },
    price_usd: 36,
    buy: [{ vendor: CORE, url: "https://core-electronics.com.au/pololu-12v-4-5a-step-down-voltage-regulator-d36v50f12.html" }, { vendor: "Pololu", url: "https://www.pololu.com/product/4095" }],
    source: "https://www.pololu.com/product/4095",
    notes: ["Hole places as on the D36V50F6 drill guide (assumed): check yours."],
  },

  // Narva 68040BL: 24 V 30 A normally-open 5-pin automotive relay with a suppression diode and a mounting tab.
  // The ISO mini-relay case is 28 × 28 × 25 mm with 6.3 mm blades (ISO 7588).
  {
    id: "narva_68040bl",
    kind: "switch",
    name: "Narva 68040BL 24 V 30 A relay, normally open, with diode",
    maker: "Narva",
    mpn: "68040BL",
    summary: "Automotive relay that switches the legs' supply: 30 A through 30 and 87 when 24 V is on the coil (86 + , 85 −), about 80 mA. A built-in diode takes the coil's spike. Wire the e-stop in its coil, so pressing it cuts all twelve actuators in hardware.",
    specs: { rating_a: 30, v_max: 32, coil_v: 24, coil_a: 0.08, pull_in_v: 16.8, mass_g: 30, cycles: 500000 },
    pins: [
      pwrIn("COIL_86", 16.8, 32, { label: "86 (coil +)", draw: 0.08, vabs: 36, note: "Coil +: the side of the diode's cathode" }),
      gnd("COIL_85", "85 (coil −)"),
      { id: "COM_30", type: "passive", label: "30", through: "NO_87", required: true, note: "Common: from the supply" },
      { id: "NO_87", type: "passive", label: "87", through: "COM_30", required: true, note: "Normally open: to the load, closed while the coil is powered" },
    ],
    geom: { g: "auto_relay", dims: { w: 28, d: 28, h: 25, blade_l: 9 }, color: "#16181b" },
    price_usd: 20,
    buy: [{ vendor: "Narva (AU)", url: "https://narva.com.au/products/narva-24v-30a-normally-open-contacts-5-pin-relay-1-pack-1" }],
    source: "https://narva.com.au/products/narva-24v-30a-normally-open-contacts-5-pin-relay-1-pack-1",
    notes: ["Fit 6.3 mm insulated female spades on 14 AWG for 30 and 87 and 18 AWG for the coil, and screw the tab to the frame.", "Its case size is the ISO mini-relay standard; Narva's page gives no drawing."],
  },

  // Wago 221-615: the five-way 6 mm² lever connector (41 A), the power and ground junctions of the legs' supply.
  {
    id: "wago_221_615",
    kind: "connector",
    name: "Wago 221-615 lever connector, 5 wires up to 6 mm²",
    maker: "Wago",
    mpn: "221-615",
    summary: "Five-way lever connector for 0.5 to 6 mm² (20 to 10 AWG) wire, 41 A: one supply wire in, four out, with no soldering or crimping. Lift a lever, push in a wire stripped 12 mm, close the lever.",
    specs: { rating_a: 41, v_max: 450, ways: 5, wire_mm2_min: 0.5, wire_mm2_max: 6, strip_mm: 12, mass_g: 9 },
    pins: [
      { id: "A", type: "passive", through: "B", required: true },
      { id: "B", type: "passive", through: "A", required: true },
      { id: "C", type: "passive", through: "A" },
      { id: "D", type: "passive", through: "A" },
      { id: "E", type: "passive", through: "A" },
    ],
    geom: { g: "box", style: "wago", dims: { w: 33.3, d: 21.1, h: 10.1, r: 1.4 }, color: "#dfe4ea", color2: "#f08a1c", material: "PC" },
    price_usd: 3.5,
    buy: [{ vendor: "element14 (AU)", url: "https://au.element14.com/wago/221-615/splicing-connector-5-way-6mm2/dp/2856919" }],
    source: "https://www.wago.com/global/installation-terminal-blocks-and-connectors/splicing-connector-with-levers/p/221-615",
    notes: ["Its width is drawn 33.3 mm, five of the 221-612's 6.66 mm lever pitch: check yours before machining a holder."],
  },

  // ---- the knee drive: an HTD 8M belt from the knee actuator on the thigh down to the knee ----
  // A 5M belt cannot take an AK70-10's 24.8 N·m on a pulley this size (about 1 kN of pull), so the knee runs on 8M, 20 mm wide.
  {
    id: "htd8m_20_loop",
    kind: "belt",
    name: "HTD 8M closed-loop timing belt, 20 mm wide (Misumi HTBN, made to tooth count)",
    maker: "Misumi",
    mpn: "HTBN…S8M200",
    summary: "8 mm pitch round-tooth (HTD/S8M) neoprene belt with glass fibre cords, 20 mm wide, made as an endless loop to any whole number of teeth. Carries the knee actuator's torque down the thigh to the knee.",
    specs: {
      pitch: 8,
      width: 20,
      thickness: 5.6,
      tooth_h: 3.4,
      pld: 0.686,
      mass_g_m: 104,
      ea_n: 400000,
      te_max_n: 1060,
      t_min_n: 300,
      t_max_n: 800,
      t_nominal_n: 560,
      min_teeth: 22,
      core: "glass fibre",
      closed: true,
      stock: Array.from({ length: 76 }, (_, i) => 400 + 8 * i).join(","),
    },
    pins: [],
    geom: { g: "belt", dims: {}, color: "#1b1d21", material: "Neoprene" },
    price_usd: 24,
    buy: [{ vendor: "Misumi Australia", url: "https://au.misumi-ec.com/vona2/detail/110300099520/" }],
    source: "https://au.misumi-ec.com/vona2/detail/110300099520/",
    notes: [
      "Misumi makes HTBN loops to any tooth count, so the length is 8 mm steps.",
      "Allowable effective tension 1060 N for 20 mm is Misumi's S8M table figure at low speed; check it against the current catalogue before ordering.",
      "Fixed-centre drive: the centres are set so the loop is stretched to its installation tension; the knee cup's screw holes are 0.5 mm oversize to set it.",
    ],
  },
  {
    id: "htd8m_22t_20_flanged",
    kind: "pulley",
    name: "HTD 8M 22-tooth pulley for a 20 mm belt, flanged, bolt-circle hub",
    maker: "Misumi",
    mpn: "HTPA22S8M200-A-N12 (with additional machining)",
    summary: "Aluminium HTD 8M pulley, 22 teeth (56.02 mm pitch diameter, 176 mm of belt a turn) for a 20 mm belt, flanged both sides, 12 mm bore, 9.5 mm hub. Drilled with 8 × M3 clearance holes on a 36 mm circle to bolt to an AK-series actuator's output.",
    specs: { teeth: 22, pitch: 8, pd: 56.02, bore: 12, belt_w: 20, mm_per_rev: 176, mass_g: 118 },
    pins: [],
    geom: { g: "htd_pulley", dims: { pd: 56.02, od: 54.65, w: 22, flange_d: 62, flange_t: 1.5, hub_d: 40, hub_l: 9.5, bore: 12, pcd: 36, holes: 8, hole_d: 3.4, gap_d: 4.9 }, color: "#c8ccd2" },
    price_usd: 46,
    buy: [{ vendor: "Misumi Australia", url: "https://au.misumi-ec.com/vona2/detail/110300100830/" }],
    notes: ["The bolt circle is extra machining on Misumi's A-type pulley (or drill it yourself on a rotary table): 8 × Ø3.4 on 36 mm, 22.5° apart."],
  },
  {
    id: "htd8m_22t_20_flanged_tapped",
    kind: "pulley",
    name: "HTD 8M 22-tooth pulley for a 20 mm belt, flanged, long tapped hub",
    maker: "Misumi",
    mpn: "HTPA22S8M200-A-P12 (with additional machining)",
    summary: "The same aluminium HTD 8M 22-tooth flanged pulley with a 12 mm hub that runs in a 6808 bearing, and 8 × M3 threads 10 deep in its hub face on a 36 mm circle for the knee crank.",
    specs: { teeth: 22, pitch: 8, pd: 56.02, bore: 12, belt_w: 20, mm_per_rev: 176, mass_g: 128 },
    pins: [],
    geom: { g: "htd_pulley", dims: { pd: 56.02, od: 54.65, w: 22, flange_d: 62, flange_t: 1.5, hub_d: 40, hub_l: 12, bore: 12, pcd: 36, holes: 8, hole_d: 2.5, hole_depth: 10, gap_d: 4.9 }, color: "#c8ccd2" },
    price_usd: 48,
    buy: [{ vendor: "Misumi Australia", url: "https://au.misumi-ec.com/vona2/detail/110300100830/" }],
    notes: ["Ordered with the long hub (12 mm, 40 mm across) so it runs in a 6808 bearing; the threads are extra machining (8 × M3, 10 deep, on 36 mm)."],
  },
];
