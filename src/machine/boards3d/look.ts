// How each bought circuit board looks, for drawing it in detail: the solder
// mask and silkscreen colours, the plating, what is printed on it and on its
// chips, what each coarse feature box of its catalog geometry really is, and
// the parts the catalog geometry leaves out (a Pi Zero's ports, an Arduino's
// reset button). Boards not listed here get a look from their features' sizes.

/** What a board feature is drawn as. */
export type Look =
  // chips
  | "qfp"
  | "qfn"
  | "soic"
  | "dip"
  | "power"
  | "can"
  | "drivers"
  | "mosfets"
  // pin rows
  | "header_m"
  | "header_f"
  | "header_down"
  /** a right-angle pin header at the board's edge, its pins pointing out past the edge */
  | "header_ra"
  | "box_header"
  | "fpc"
  // connectors
  | "terminal"
  /** a screw terminal block with 3.5 mm between terminals */
  | "terminal35"
  /** a STEMMA QT (JST SH 4-way) socket lying on the board, open toward the nearer edge */
  | "qt"
  | "usb_c"
  | "usb_micro"
  | "usb_mini"
  | "usb_b"
  | "usb_a"
  | "hdmi_mini"
  | "barrel"
  | "jack35"
  | "sdcard"
  // a side-entry JST SH socket (STEMMA QT, Qwiic)
  | "jst_sh"
  // a wide current-sense resistor
  | "shunt"
  // everything else
  | "heatsink"
  | "elcap"
  | "inductor"
  | "drum"
  | "trimpot"
  | "button"
  | "crystal"
  | "wroom"
  | "transducer"
  | "microswitch"
  | "oled"
  // a camera's lens: its square holder on the board, the barrel and the glass
  | "lens";

/** A part drawn on a board that its catalog geometry has no feature for. */
export interface Extra {
  look: Look;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  mark?: string;
  /** a header's plastic, when it is not black (servo boards colour their rows) */
  color?: string;
}

export interface BoardStyle {
  /** solder mask colour */
  mask: string;
  /** silkscreen colour */
  silk: string;
  /** pad plating: hot-air levelled solder, or gold */
  finish: "hasl" | "enig";
  /** printed on the board, largest first */
  title?: string[];
  /** laser marking on the chips, in feature order (lines split with \n) */
  marks?: string[];
  /** what each feature of the catalog geometry is, in order; null leaves it out */
  looks?: (Look | null)[];
  extras?: Extra[];
  /** screw terminal body colour */
  terminal?: string;
  /** heatsink colour */
  heatsink?: string;
  /** JST SH socket housing colour */
  socket?: string;
  /** female headers on top (Arduino Uno and Mega) */
  female?: boolean;
  /** draw the headers and terminals of the board's plug table (harness/plugs.ts); false when an extra already draws them */
  sockets?: boolean;
  /** how many small surface-mount parts, relative to the usual for its size */
  smd?: number;
  /** the board's pins are where its plug table has them (harness/plugs.ts): print their names there, not in header order */
  pinsFromPlugs?: boolean;
  /** more silkscreen, where the board prints it: channel numbers, row names */
  labels?: { text: string; x: number; y: number; size?: number; rot?: number }[];
}

const GREEN = "#1f5e3a";
const BLUE = "#1d4f9c";
const RED = "#a8251d";
const BLACK = "#16181b";
const WHITE_SILK = "#f1f1ea";

export const DEFAULT_STYLE: BoardStyle = { mask: GREEN, silk: WHITE_SILK, finish: "hasl" };

/** Looks by catalog id. */
export const BOARD_STYLES: Record<string, BoardStyle> = {
  skr_mini_e3_v3: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["BIGTREETECH", "SKR MINI E3 V3.0"],
    marks: ["STM32G0B1\nRET6"],
    // the header and terminal rows are the plug table's sockets; the "heatsink" is the row of on-board drivers
    looks: [null, null, "qfp", "drivers", "usb_c"],
    extras: [
      { look: "sdcard", x: 45.5, y: -14, w: 14, d: 14.5, h: 1.9 },
      { look: "button", x: 40, y: 2, w: 6, d: 3.5, h: 2.5 },
      { look: "crystal", x: 14, y: 4, w: 3.2, d: 2.5, h: 0.8 },
    ],
    smd: 1.2,
  },
  rpi_zero_2w: {
    mask: GREEN,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["Raspberry Pi Zero 2 W", "(C) Raspberry Pi 2021"],
    marks: ["RP3A0-AU\nRASPBERRY PI"],
    looks: ["can", "sdcard"],
    extras: [
      // the 40-pin header, pin 1 at the -X end; its pins line up with the plug table
      { look: "header_m", x: 0, y: 11.5, w: 50.8, d: 5.08, h: 8.5 },
      { look: "hdmi_mini", x: -20.1, y: -11.6, w: 11.2, d: 7.5, h: 3.2 },
      { look: "usb_micro", x: 8.9, y: -12.4, w: 8, d: 5.6, h: 2.8 },
      { look: "usb_micro", x: 21.5, y: -12.4, w: 8, d: 5.6, h: 2.8 },
      { look: "fpc", x: 30, y: 0, w: 4, d: 17, h: 1.4 },
    ],
    sockets: false,
    smd: 1.3,
  },
  buck_24v_5v_3a: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["DC-DC 24V-5V 3A"],
    marks: ["220"],
    looks: ["inductor", "usb_a"],
    extras: [
      { look: "soic", x: -8, y: -6.5, w: 5, d: 6, h: 1.5, mark: "MP1584\nEN" },
      { look: "elcap", x: -9.5, y: 6.5, w: 6.3, d: 6.3, h: 7 },
    ],
  },
  endstop_mech: {
    mask: RED,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["Mech Endstop v1.2"],
    looks: ["microswitch"],
    smd: 0.6,
  },
  arduino_nano: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["NANO V3.0"],
    marks: ["ATMEGA328P\nAU 2214"],
    looks: ["usb_mini", "qfp", "header_down", "header_down"],
    extras: [
      { look: "button", x: -2, y: 0, w: 3, d: 6, h: 2.5 },
      { look: "crystal", x: 12, y: 3.5, w: 3.2, d: 2.5, h: 0.8 },
    ],
  },
  arduino_nano_clone: {
    mask: "#1b4f9c",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["NANO V3.0"],
    marks: ["ATMEGA328P\nAU 2231", "CH340C"],
    looks: ["usb_mini", "qfp", "soic"],
    extras: [
      { look: "header_down", x: 0, y: 7.62, w: 38.1, d: 2.54, h: 2.5 },
      { look: "header_down", x: 0, y: -7.62, w: 38.1, d: 2.54, h: 2.5 },
      { look: "button", x: -2.5, y: 4, w: 3, d: 6, h: 2.5 },
      { look: "crystal", x: 12, y: 3.5, w: 3.2, d: 2.5, h: 0.8 },
    ],
  },
  arduino_uno: {
    mask: "#00787c",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["UNO"],
    marks: ["ATMEGA328P-PU"],
    looks: ["usb_b", "barrel", "header_f", "header_f", "dip"],
    female: true,
    extras: [
      { look: "button", x: -28, y: 22, w: 6, d: 6, h: 4 },
      { look: "box_header", x: 31, y: -9.7, w: 7.6, d: 5.1, h: 8.5 },
      { look: "qfn", x: -20, y: 8, w: 5, d: 5, h: 1, mark: "ATMEGA\n16U2" },
      { look: "crystal", x: 0, y: -2, w: 11.4, d: 4.7, h: 3.5 },
    ],
  },
  arduino_mega: {
    mask: "#00787c",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["MEGA 2560"],
    marks: ["ATMEGA2560\n16AU"],
    looks: ["usb_b", "barrel", "header_f", "header_f", "header_f", "qfp"],
    female: true,
  },
  esp32_devkitc: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["ESP32-DevKitC"],
    marks: ["ESP32-WROOM-32E"],
    looks: ["wroom", "usb_micro", "header_down", "header_down"],
    extras: [
      { look: "button", x: -21, y: 8, w: 3.5, d: 3, h: 1.6 },
      { look: "button", x: -21, y: -8, w: 3.5, d: 3, h: 1.6 },
      { look: "qfn", x: -13, y: 0, w: 5, d: 5, h: 0.9, mark: "CP2102N" },
    ],
  },
  rpi_pico: {
    mask: GREEN,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["Raspberry Pi Pico", "(C) 2020"],
    marks: ["RP2-B2\n21/24"],
    looks: ["usb_micro", "qfn"],
    extras: [
      { look: "soic", x: 12, y: 0, w: 5.3, d: 5.3, h: 1.6, mark: "W25Q16JV" },
      { look: "button", x: -13, y: 4, w: 3.5, d: 6, h: 3.5 },
      { look: "crystal", x: 6, y: -6, w: 3.2, d: 2.5, h: 0.8 },
      // the castellated edge pins, with pin headers soldered under them
      { look: "header_down", x: 0, y: 8.89, w: 50.8, d: 2.54, h: 2.5 },
      { look: "header_down", x: 0, y: -8.89, w: 50.8, d: 2.54, h: 2.5 },
    ],
  },
  l298n: {
    mask: RED,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["L298N"],
    looks: ["heatsink", "terminal"],
    terminal: "#2a62c9",
    extras: [
      { look: "elcap", x: -15, y: -10, w: 8, d: 8, h: 11 },
      { look: "header_m", x: 13, y: -18, w: 15.2, d: 2.54, h: 8.5 },
    ],
  },
  tb6612fng: {
    mask: RED,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["TB6612FNG"],
    marks: ["TB6612\nFNG"],
    looks: ["soic", "header_down", "header_down"],
  },
  bts7960: { mask: "#1f3a7a", silk: WHITE_SILK, finish: "hasl", title: ["BTS7960"], looks: ["heatsink", "terminal", "header_m"], terminal: "#2a62c9" },
  cytron_mdd10a: { mask: BLACK, silk: WHITE_SILK, finish: "hasl", title: ["CYTRON", "MDD10A"], looks: ["terminal", "mosfets", "mosfets"] },
  cytron_md10c: { mask: BLACK, silk: WHITE_SILK, finish: "hasl", title: ["CYTRON", "MD10C"], looks: ["terminal", "mosfets"] },
  pololu_g2_18v17: {
    mask: "#1f3f99",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["G2 18v17"],
    looks: ["mosfets", "terminal"],
    terminal: "#2c6e49",
    extras: [
      { look: "qfn", x: 11.5, y: 2, w: 4, d: 4, h: 0.9, mark: "MP6530" },
      // the logic pins along the far end
      { look: "header_m", x: 15.2, y: 0, w: 2.54, d: 17.78, h: 8.5 },
    ],
  },
  drv8833: {
    mask: "#3d2a73",
    silk: WHITE_SILK,
    finish: "enig",
    title: ["DRV8833"],
    marks: ["DRV8833"],
    looks: ["qfn"],
    extras: [
      { look: "header_down", x: 0, y: 5.08, w: 17.78, d: 2.54, h: 2.5 },
      { look: "header_down", x: 0, y: -5.08, w: 17.78, d: 2.54, h: 2.5 },
    ],
  },
  a4988: { mask: GREEN, silk: WHITE_SILK, finish: "hasl", title: ["A4988"], marks: ["A4988\nSETT"], looks: ["qfn", "header_down", "header_down"], extras: [{ look: "trimpot", x: 3, y: -7, w: 3.8, d: 3.6, h: 1.8 }] },
  drv8825: { mask: "#3d2a73", silk: WHITE_SILK, finish: "enig", title: ["DRV8825"], marks: ["DRV8825"], looks: ["qfn", "header_down", "header_down"], extras: [{ look: "trimpot", x: 3, y: -7, w: 3.8, d: 3.6, h: 1.8 }] },
  tmc2209: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["TMC2209 V1.3"],
    looks: ["heatsink"],
    heatsink: "#5b2a86",
    // a StepStick: two rows of eight pins pointing down into the carrier board
    extras: [
      { look: "header_down", x: -6.35, y: 0, w: 2.54, d: 20.32, h: 2.5 },
      { look: "header_down", x: 6.35, y: 0, w: 2.54, d: 20.32, h: 2.5 },
    ],
  },
  lm2596: { mask: BLUE, silk: WHITE_SILK, finish: "hasl", title: ["LM2596 DC-DC"], marks: ["LM2596S\n-ADJ"], looks: ["elcap", "power", "drum"], extras: [{ look: "trimpot", x: 12, y: -7, w: 9.5, d: 4.8, h: 10 }] },
  d24v50f5: { mask: "#1d4f9c", silk: WHITE_SILK, finish: "enig", title: ["D24V50F5"], marks: ["4R7"], looks: ["inductor"], extras: [{ look: "header_m", x: 1, y: -8.8, w: 12.7, d: 2.54, h: 8.5 }] },
  feather_esp32_v2: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["ESP32 Feather V2", "Adafruit"],
    marks: ["ESP32-PICO\nMINI-02"],
    looks: ["wroom", "usb_c", "box_header", "box_header", "header_down", "header_down"],
    extras: [
      { look: "button", x: -13, y: 7.5, w: 3.5, d: 3, h: 1.6 },
      { look: "button", x: -13, y: -7.5, w: 3.5, d: 3, h: 1.6 },
      { look: "soic", x: -2, y: 4.5, w: 3, d: 3, h: 1, mark: "MCP\n73831" },
      { look: "crystal", x: 1.5, y: -5, w: 2, d: 2, h: 0.6 },
    ],
    smd: 1.1,
  },
  // Adafruit's field and current sensors and coil drivers (catalog/fields.ts), as sold: the newer ones black with
  // gold pads, the two older motor drivers blue; green screw terminals, cream STEMMA QT sockets
  tmag5273_breakout: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["TMAG5273A1", "3D Magnetometer"],
    marks: ["3A1"],
    looks: ["soic", "jst_sh", "jst_sh"],
    socket: "#efece2",
    smd: 0.8,
  },
  usb_cam_fit0701: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    looks: ["lens"],
    smd: 0.8,
  },
  ina3221_breakout: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["INA3221", "Triple Power Monitor"],
    marks: ["INA\n3221", "R050", "R050", "R050"],
    looks: ["qfn", "terminal", "terminal", "terminal", "shunt", "shunt", "shunt", "jst_sh", "jst_sh"],
    terminal: "#2f9a57",
    socket: "#d9cba8",
    smd: 0.8,
  },
  ina3221_breakout_41: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["INA3221", "Triple Power Monitor"],
    marks: ["INA\n3221", "R050", "R050", "R050"],
    looks: ["qfn", "terminal", "terminal", "terminal", "shunt", "shunt", "shunt", "jst_sh", "jst_sh"],
    terminal: "#2f9a57",
    socket: "#d9cba8",
    smd: 0.8,
  },
  drv8871_breakout: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["DRV8871", "Motor Driver"],
    marks: ["DRV\n8871"],
    looks: ["soic", "terminal", "terminal", "header_down"],
    terminal: "#2f9a57",
    smd: 0.7,
  },
  tb6612_breakout: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["TB6612", "Motor Driver"],
    marks: ["TB6612\nFNG"],
    looks: ["soic", "header_down", "header_down"],
    smd: 0.9,
  },
  lsm6dsox_breakout: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["LSM6DSOX", "6-DoF IMU"],
    marks: ["LSM6\nDSOX"],
    looks: ["qfn", "qt", "qt"],
    extras: [{ look: "soic", x: -4.5, y: 4.5, w: 3, d: 1.6, h: 1, mark: "3V3" }],
    smd: 0.9,
  },
  nau7802_breakout: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["NAU7802", "24-bit ADC"],
    marks: ["NAU\n7802"],
    looks: ["soic", "qt", "qt", "terminal35"],
    terminal: "#2a62c9",
    pinsFromPlugs: true,
    smd: 0.9,
  },
  // the assembled 16-channel servo board: blue, with each channel's three pins in a black (GND), red (V+) and
  // yellow (pulse) row, the control header's pins pointing out of one end and the power terminal in the middle
  pca9685_servo_16: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["16-Channel 12-bit", "PWM/Servo Driver"],
    marks: ["PCA9685"],
    looks: ["soic", "terminal", null, null, null, null, null],
    terminal: "#2a62c9",
    extras: [
      ...[-19.05, -6.35, 6.35, 19.05].flatMap((x): Extra[] => [
        { look: "header_m", x, y: -10.16, w: 10.16, d: 2.54, h: 8.5, color: "#17181b" },
        { look: "header_m", x, y: -7.62, w: 10.16, d: 2.54, h: 8.5, color: "#c8322b" },
        { look: "header_m", x, y: -5.08, w: 10.16, d: 2.54, h: 8.5, color: "#e3c020" },
      ]),
      { look: "header_ra", x: -30, y: 0, w: 2.5, d: 15.24, h: 2.5 },
      { look: "power", x: 12, y: 8, w: 6.5, d: 6, h: 2.3 },
    ],
    pinsFromPlugs: true,
    labels: [
      ...Array.from({ length: 16 }, (_, k) => ({ text: String(k), x: -22.86 + 2.54 * (k + Math.floor(k / 4)), y: -2.6, size: 0.9 })),
      { text: "V+", x: -5.2, y: 3.4, size: 1 },
      { text: "GND", x: 5.6, y: 3.4, size: 1 },
    ],
    smd: 1.3,
  },
  hx711_breakout: {
    mask: RED,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["Load Cell Amp", "HX711"],
    marks: ["HX711"],
    looks: ["soic", "header_m", "header_m"],
    smd: 0.9,
  },
  mpu6050: { mask: BLUE, silk: WHITE_SILK, finish: "hasl", title: ["GY-521"], marks: ["MPU-6050"], looks: ["qfn", "header_m"] },
  bno055: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["BNO055", "9-DOF"],
    marks: ["BNO055"],
    looks: ["qfn"],
    extras: [{ look: "header_m", x: 0, y: -8.5, w: 17.8, d: 2.54, h: 8.5 }],
  },
  voltage_sensor_25v: {
    mask: RED,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["Voltage Sensor"],
    looks: ["terminal"],
    terminal: "#2a62c9",
    extras: [{ look: "header_m", x: -11, y: 0, w: 2.54, d: 7.62, h: 8.5 }],
  },
  hc_sr04: {
    mask: BLUE,
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["HC-SR04"],
    looks: ["transducer", "transducer"],
    extras: [
      { look: "crystal", x: 0, y: 6, w: 11.4, d: 4.7, h: 3.5 },
      { look: "header_m", x: 0, y: -8, w: 10.2, d: 2.54, h: 8.5 },
    ],
  },
  ssd1306_oled_096: { mask: BLUE, silk: WHITE_SILK, finish: "hasl", looks: ["oled"], extras: [{ look: "header_m", x: 0, y: 12, w: 10.2, d: 2.54, h: 8.5 }] },
  // Waveshare Bus Servo Adapter (A): DC jack and green screw terminal at one end, USB-C at the other, the UART header
  // and the A/B jumper beside it, the buck converter's inductor and the supply switch; the two servo ports are drawn
  // from the plug table
  waveshare_bus_servo_adapter_a: {
    mask: "#1d4f9c",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["Bus Servo Adapter (A)", "Waveshare"],
    marks: ["CH343P", "4R7", "AO4407"],
    looks: ["barrel", "terminal", "usb_c", "header_m", null, "qfn", "header_m", null, "inductor", "soic"],
    terminal: "#2c8a4a",
    smd: 0.9,
  },
  // Arducam B0196: the lens in the middle and the UVC bridge chip beside it; the lead's socket is on the back
  arducam_b0196: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["ARDUCAM", "UC-626 Rev.B"],
    marks: ["", "SPCA\n2080A"],
    looks: ["lens", "qfn", null],
    smd: 1.2,
  },
  tpa3116_mono: {
    mask: "#1f4a8a",
    silk: WHITE_SILK,
    finish: "hasl",
    title: ["XH-M542", "TPA3116D2 MONO"],
    looks: ["heatsink", "terminal", "terminal", "terminal", "elcap", "elcap", "jack35"],
    terminal: "#2c6e49",
    heatsink: "#1d1f22",
    extras: [
      { look: "inductor", x: -20, y: -4.5, w: 8, d: 8, h: 5, mark: "220" },
      { look: "inductor", x: -20, y: 5.5, w: 8, d: 8, h: 5, mark: "220" },
    ],
  },
};
