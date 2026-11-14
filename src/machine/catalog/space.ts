// Flight hardware for CubeSats: the boards, battery, radios, attitude control, star tracker, imager, solar panels
// and antennas a 3U Earth-imaging CubeSat is built from, each a real product drawn to its maker's published size.
// Specs are from the makers' datasheets and catalogue pages (each part's source), read on 14 Nov 2026. Most of
// this hardware is sold on quotation: a price is given only where the maker or its distributor publishes one, and
// each part's notes say so. Pin ids are the signals the design wires; labels give the PC/104 header pins
// (H1/H2, CubeSat Kit numbering) or the connector they are on.
//
// specs.space_dev tells the simulator which spacecraft model runs a part (src/sim/engine/spacecraft.ts).

import type { BoardFeature, CatalogPart, PinDef } from "../types";
import { gnd, pwrIn, pwrOut } from "./pins";
import { PC104 } from "../geometrySpace";

// the stack-through connectors every PC/104 board carries: H1 and H2, 2 x 26 each, near the +y edge
const STACK: BoardFeature[] = [
  { kind: "header", x: 0, y: PC104.d / 2 - 6.2, w: 66.04, d: 5.08, h: 8.5 },
  { kind: "header", x: 0, y: PC104.d / 2 - 12.3, w: 66.04, d: 5.08, h: 8.5 },
  // the stack-through pins under the board stop just short of the next board's sockets 15 mm down (in the stack they go in)
  { kind: "header", x: 0, y: PC104.d / 2 - 6.2, w: 66.04, d: 5.08, h: 6.4, side: "bottom", color: "#c9a14a" },
  { kind: "header", x: 0, y: PC104.d / 2 - 12.3, w: 66.04, d: 5.08, h: 6.4, side: "bottom", color: "#c9a14a" },
];

/** the top board of a stack: the non-stack-through version of the connectors, pins under the board only */
const STACK_TOP: BoardFeature[] = STACK.filter((f) => f.side === "bottom");

const i2c = (id: "SDA" | "SCL", h1: number): PinDef => ({ id, label: `H1-${h1}`, type: "in", vmax: 3.6, vih: 2.3, bus: id === "SDA" ? "i2c_sda" : "i2c_scl", required: true, stack: "pc104" });

/** a board's supply pins from the stack: 3.3 V, 5 V or the battery bus */
const v3 = (draw: number, note?: string) => pwrIn("V3V3", 3.1, 3.5, { label: "H2-27", vabs: 3.6, draw, note, stack: "pc104" });
const v5 = (draw: number, note?: string) => pwrIn("V5", 4.75, 5.25, { label: "H2-25", vabs: 5.5, draw, note, stack: "pc104" });
/** ground on the stack connector (H2-29 to H2-32) */
const sgnd = (): PinDef => ({ ...gnd(), label: "H2-29", stack: "pc104" });
/** a ground contact in one of a board's harness connectors */
const cgnd = (id: string, note: string): PinDef => ({ ...gnd(id, "GND"), required: false, note });

/** the PC/104 stack connector: the pin joins the pin in the same place on the boards above and below */
const stacked = (p: PinDef): PinDef => ({ ...p, stack: "pc104" });

const QUOTE = "Sold on quotation: the maker publishes no price, so none is given here.";

// ---------------- power ----------------

export const P31U: CatalogPart = {
  id: "gomspace_p31u",
  kind: "regulator",
  name: "GomSpace NanoPower P31u electrical power system",
  maker: "GomSpace",
  mpn: "NanoPower P31u",
  summary:
    "CubeSat EPS on a PC/104 board: three MPPT solar inputs (two connectors each, up to 2 A per input), a battery charger, a 3.3 V bus (5 A) and a 5 V bus (4 A), six switchable latch-up-protected outputs (three at 5 V, three at 3.3 V), kill-switch and remove-before-flight inputs, an I2C housekeeping and command interface at 0x02. 30 W converter, 100 g.",
  specs: { space_dev: "eps", i2c_addr: "0x02", converters: 3, i_in_max: 2, v3_imax: 5, v5_imax: 4, p_max_w: 30, own_mw: 160, efficiency: 0.93, out_v: "5,5,5,3.3,3.3,3.3", out_limit_a: "2,2,2,1.5,1.5,1.5", mass_g: 100, outgassing_tml: 0.5 },
  pins: [
    pwrIn("VBAT", 12, 16.8, { label: "BAT", vabs: 18, draw: 0.012, note: "The battery's positive, through the kill and RBF switches: the charger feeds the battery back through it" }),
    sgnd(),
    ...(["1A", "1B", "2A", "2B", "3A", "3B"] as const).map((k) => pwrIn(`SOLAR${k}`, 0, 20, { label: `PV${k}`, vabs: 22, draw: 0, required: false, note: `Solar input ${k[0]} (connector ${k[1]}): a panel string up to 20 V; the two connectors of one input share its MPPT converter` })),
    stacked(pwrOut("V3V3", 3.3, 5, { label: "H2-27", note: "The 3.3 V bus, always on while the satellite is powered" })),
    stacked(pwrOut("V5", 5, 4, { label: "H2-25", note: "The 5 V bus, always on while the satellite is powered" })),
    ...[1, 2, 3].map((n) => pwrOut(`OUT${n}`, 5, 2, { label: `OUT${n}`, note: `Switchable 5 V output ${n}, latch-up limited at 2 A; off until commanded on over I2C` })),
    ...[4, 5, 6].map((n) => pwrOut(`OUT${n}`, 3.3, 1.5, { label: `OUT${n}`, note: `Switchable 3.3 V output ${n}, latch-up limited at 1.5 A; off until commanded on over I2C` })),
    i2c("SDA", 41),
    i2c("SCL", 43),
    cgnd("GND_OUT", "Ground in the switched-output connector"),
    ...(["1A", "1B", "2A", "2B", "3A", "3B"] as const).map((k) => cgnd(`GND_${k}`, `Ground in solar connector ${k}`)),
  ],
  geom: { g: "board", route: "exact", dims: { w: 89.3, d: 92.9, t: 1.6 }, holes: PC104.holes, hole_d: 3.2, features: [...STACK, { kind: "chip", x: -18, y: 4, w: 10, d: 10, h: 1.2 }, { kind: "chip", x: 14, y: -14, w: 7, d: 7, h: 1 }, { kind: "chip", x: 28, y: 6, w: 7, d: 7, h: 1 }, { kind: "chip", x: -30, y: -20, w: 7, d: 7, h: 1 }, { kind: "cap", x: 0, y: -30, w: 12, d: 12, h: 4.5 }, { kind: "cap", x: -14, y: -30, w: 12, d: 12, h: 4.5 }, { kind: "cap", x: 14, y: -30, w: 12, d: 12, h: 4.5 }, ...[[-38, 10], [-38, -6], [38, 10], [38, -6], [-38, 26], [38, 26], [-38, -24], [38, -24]].map(([x, y]) => ({ kind: "socket" as const, x, y, w: 5, d: 12, h: 4.2 }))], color: "#101214" },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-p31u.aspx" }],
  source: "GomSpace NanoPower P31u datasheet (gs-ds-nanopower-p31u); CubeSatShop product page",
  notes: [QUOTE, "The 16.8 V battery variant is used here, for the 4-cell BP4 pack.", "Its kill-switch inputs open its battery switch while the deployment switches are pressed; this design also puts them in series in the battery line, as the CubeSat Design Specification asks for."],
};

export const BP4: CatalogPart = {
  id: "gomspace_bp4_1p4s",
  kind: "battery",
  name: "GomSpace NanoPower BP4 battery pack, 1P-4S",
  maker: "GomSpace",
  mpn: "NanoPower BP4 (1P-4S)",
  summary: "Four 18650 lithium-ion cells in series on a PC/104 board (14.4 V nominal, 12.0 to 16.8 V, 3.0 Ah, 43 Wh) in machined aluminium clamps, Kapton wrapped, with heater films and temperature sensors on every cell. 94 x 84 x 23 mm.",
  specs: { protection: "over-current, short-circuit and cell-balance protection on the pack's own board", cells: 4, chemistry: "Li-ion", v_nom: 14.4, v_max: 16.8, v_min: 12.0, capacity_mah: 3000, i_cont: 3, energy_wh: 43.2, heater_w: 6, mass_g: 270, outgassing_tml: 0.4 },
  pins: [pwrOut("POS", 14.4, 3, { label: "BAT+", vmin: 12, vmax: 16.8, note: "Nominal 14.4 V, 12.0 to 16.8 V over the charge" } as Partial<PinDef>), gnd("NEG", "BAT-")],
  geom: { g: "space_bp4", route: "exact", dims: { w: PC104.w, d: PC104.d, h: 23, n: 4, cell_d: 18.4, cell_l: 65.2 }, holes: PC104.holes, color: "#101214" },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-bp4.aspx" }],
  source: "GomSpace NanoPower BP4 datasheet (gs-ds-nanopower-bp4)",
  notes: [QUOTE, "Ships charged to storage voltage: keep it at 30 to 50 % until integration."],
};

// ---------------- command, data and radios ----------------

const OBC_IO = (id: string, mcu: string, label: string, opts: Partial<PinDef> = {}): PinDef => ({ id, label, type: "io", v: 3.3, imax: 0.008, pwm: false, irq: true, mcu, ...opts });

export const ES_OBC: CatalogPart = {
  id: "endurosat_obc",
  kind: "controller",
  name: "EnduroSat Onboard Computer (OBC) Type I",
  maker: "EnduroSat",
  mpn: "OBC Type I",
  summary: "CubeSat flight computer on a PC/104 board: an STM32F4 Cortex-M4F with 2 MB flash and 256 KB RAM, two microSD slots, two I2C buses, SPI, UARTs and RS-485, a real-time clock and a three-axis magnetometer and gyro. 58 g.",
  specs: { space_dev: "obc", mcu: "STM32F4", logic_v: 3.3, clock_mhz: 180, flash_kb: 2048, ram_kb: 256, platform: "stm32duino", sd_cs: "PB12", mass_g: 58, outgassing_tml: 0.5 },
  pins: [
    v3(0.12, "Its own draw: about 0.4 W with the radios' interface idle"),
    sgnd(),
    { ...OBC_IO("SDA", "PB7", "H1-41"), bus: "i2c_sda", stack: "pc104", note: "I2C1, the satellite's command bus (with the other boards' pull-ups); also on the I/O connector for boards off the stack" },
    { ...OBC_IO("SCL", "PB6", "H1-43"), bus: "i2c_scl", stack: "pc104" },
    { ...OBC_IO("TX", "PA9", "H1-17"), bus: "uart_tx", note: "USART1 to the payload's command port" },
    { ...OBC_IO("RX", "PA10", "H1-18"), bus: "uart_rx" },
    OBC_IO("DEP1", "PC0", "H1-27", { note: "A hinge switch's input, pulled up on the board: low while the panel is stowed" }),
    OBC_IO("DEP2", "PC1", "H1-28"),
    OBC_IO("DEP3", "PC2", "H1-29"),
    OBC_IO("DEP4", "PC3", "H1-30"),
    OBC_IO("LED", "PE2", "LED", { note: "The status LED on the board" }),
    cgnd("GND_IO", "Ground in the I/O connector"),
  ],
  geom: { g: "board", route: "exact", dims: { w: PC104.w, d: PC104.d, t: 1.6 }, holes: PC104.holes, hole_d: 3.2, features: [...STACK, { kind: "chip", x: -6, y: -2, w: 20, d: 20, h: 1.4 }, { kind: "chip", x: 22, y: -8, w: 10, d: 10, h: 1.2 }, { kind: "chip", x: -30, y: -18, w: 6, d: 8, h: 1 }, { kind: "socket", x: -26, y: -34, w: 15, d: 14.5, h: 1.8 }, { kind: "socket", x: 2, y: -34, w: 15, d: 14.5, h: 1.8 }, { kind: "chip", x: 26, y: -30, w: 5, d: 3.2, h: 1.1 }, { kind: "socket", x: 40, y: 0, w: 5, d: 22, h: 4.2 }], color: "#0e1726" },
  buy: [{ vendor: "EnduroSat", url: "https://www.endurosat.com/cubesat-store/cubesat-obc/onboard-computer-obc/" }],
  source: "EnduroSat Onboard Computer datasheet; CubeSatShop product page",
  notes: [QUOTE, "Runs your own firmware: the simulator runs it as an STM32F4 at 180 MHz with 2 MB of flash and 256 KB of RAM, the figures EnduroSat publishes (the exact part number is EnduroSat's)."],
};

export const ES_UHF: CatalogPart = {
  id: "endurosat_uhf_ii",
  kind: "sensor",
  name: "EnduroSat UHF Transceiver II",
  maker: "EnduroSat",
  mpn: "UHF Transceiver II",
  summary: "Half-duplex UHF radio for telemetry and commands, 400 to 403 MHz or 430 to 440 MHz, up to 1 W out, GMSK/2GFSK up to 19.2 kbit/s, I2C and UART, on a PC/104 board. 94 g, 3.3 V: 0.3 W listening, up to 4 W transmitting.",
  specs: { space_dev: "uhf", iface: "i2c", i2c_addr: "0x22", f_mhz: 437.5, p_tx_w: 1, baud: 9600, p_rx_w: 0.3, p_txin_w: 4, mass_g: 94, outgassing_tml: 0.5 },
  pins: [v3(0.09, "Receiving: 0.3 W; transmitting draws about 1.2 A at 3.3 V"), sgnd(), i2c("SDA", 41), i2c("SCL", 43), { id: "RF", label: "RF (U.FL)", type: "passive", note: "To the antenna system's RF input, on a 50 Ω coax" }],
  geom: { g: "board", route: "exact", dims: { w: PC104.w, d: PC104.d, t: 1.6 }, holes: PC104.holes, hole_d: 3.2, features: [...STACK, { kind: "module", x: -10, y: -10, w: 46, d: 36, h: 4.2 }, { kind: "chip", x: 26, y: -12, w: 9, d: 9, h: 1.2 }, { kind: "socket", x: 34, y: -34, w: 3, d: 3, h: 1.4 }], color: "#0e1726" },
  buy: [{ vendor: "EnduroSat", url: "https://www.endurosat.com/cubesat-store/cubesat-communication-modules/uhf-transceiver-ii/" }],
  source: "EnduroSat UHF Transceiver II datasheet",
  notes: [QUOTE, "Needs a frequency coordinated through the IARU (amateur) or your national regulator before launch."],
};

export const ES_SBAND: CatalogPart = {
  id: "endurosat_sband_tx",
  kind: "sensor",
  name: "EnduroSat S-Band Transmitter",
  maker: "EnduroSat",
  mpn: "S-Band Transmitter",
  summary: "Downlink transmitter for payload data, 2200 to 2290 MHz, up to 2 W out, OQPSK up to 20 Mbit/s, on a PC/104 board under a shield. 5 V: 11 W while transmitting.",
  specs: { space_dev: "sband", iface: "i2c", i2c_addr: "0x26", f_mhz: 2245, p_tx_w: 2, mbps: 20, p_txin_w: 11, p_idle_w: 0.5, mass_g: 250, outgassing_tml: 0.5 },
  pins: [v5(0.1, "Idle 0.5 W; transmitting draws about 2.2 A at 5 V"), sgnd(), i2c("SDA", 41), i2c("SCL", 43), { id: "RF", label: "RF (SMP)", type: "passive", note: "To the S-band patch antenna on a 50 Ω coax" }],
  geom: { g: "board", route: "exact", dims: { w: PC104.w, d: PC104.d, t: 1.6 }, holes: PC104.holes, hole_d: 3.2, features: [...STACK_TOP, { kind: "heatsink", x: -20, y: -8, w: 40, d: 52, h: 5 }, { kind: "socket", x: 36, y: -36, w: 4, d: 4, h: 3 }], color: "#0e1726" },
  buy: [{ vendor: "EnduroSat", url: "https://www.endurosat.com/cubesat-store/cubesat-communication-modules/s-band-transmitter/" }],
  source: "EnduroSat S-Band Transmitter datasheet",
  notes: [QUOTE, "The shield over the RF stages doubles as its heat spreader: it is bolted to the stack standoffs here."],
};

export const ES_PATCH: CatalogPart = {
  id: "endurosat_sband_patch",
  kind: "connector",
  name: "EnduroSat S-Band Patch Antenna",
  maker: "EnduroSat",
  mpn: "S-Band Patch Antenna",
  summary: "Right-hand circularly polarised ceramic patch for 2200 to 2290 MHz, 7 dBi, on a small board with an MMCX socket underneath.",
  specs: { f_mhz: 2245, gain_dbi: 7, mass_g: 45 },
  pins: [{ id: "RF", label: "MMCX", type: "passive", note: "From the S-band transmitter" }],
  geom: { g: "space_patch", dims: { w: 54, t: 1.6, sub: 40, sub_h: 3.2, patch: 26, trunc: 4 }, holes: [[23, 23], [-23, 23], [-23, -23], [23, -23]], hole_d: 2.2, color: "#e4d9c0" },
  buy: [{ vendor: "EnduroSat", url: "https://www.endurosat.com/cubesat-store/cubesat-antennas/s-band-patch-antenna/" }],
  source: "EnduroSat S-Band Patch Antenna datasheet",
  notes: [QUOTE, "The board's outline is drawn from EnduroSat's published size; its mounting holes are assumed."],
};

export const ISIS_ANTS: CatalogPart = {
  id: "isis_ants_uhf",
  kind: "sensor",
  name: "ISISPACE Deployable Antenna System (AntS), UHF",
  maker: "ISISPACE",
  mpn: "ISIS.ANTS.UHF",
  summary: "Four tape-spring monopole elements stowed in a 98 x 98 mm frame for a CubeSat's end face, each held by a burn wire and released on command over I2C (two redundant controllers, at 0x31 and 0x32), with a deployment switch per element. Turnstile or dipole feed, 3.3 V.",
  specs: { space_dev: "ants", iface: "i2c", i2c_addr: "0x31", elements: 4, burn_s: 4, mass_g: 85, outgassing_tml: 0.6 },
  pins: [{ ...v3(0.002, "Standby 2 mA; each burn draws about 0.3 A for a few seconds"), label: "3V3", stack: undefined }, gnd(), { ...i2c("SDA", 41), label: "SDA", stack: undefined }, { ...i2c("SCL", 43), label: "SCL", stack: undefined }, { id: "RF", label: "RF (MMCX)", type: "passive", note: "From the UHF transceiver" }],
  geom: { g: "space_ants", dims: { w: 98, h: 6, win: 58, t: 1.6, notch: 8 }, holes: [[37, 37], [-37, 37], [-37, -37], [37, -37]], hole_d: 3.2, color: "#121417", color2: "#2a2d33" },
  buy: [{ vendor: "ISISPACE", url: "https://www.isispace.nl/product/cubesat-antenna-system-1u-3u/" }],
  source: "ISISPACE AntS datasheet (ISIS.ANTS.DS.001)",
  notes: [QUOTE, "Release the elements no sooner than 30 minutes after deployment, and transmit no sooner than 45 minutes (CubeSat Design Specification 2.4.4 and 2.4.5)."],
};

// ---------------- attitude determination and control ----------------

export const CUBEADCS: CatalogPart = {
  id: "cubespace_cubeadcs_3axis_small",
  kind: "sensor",
  name: "CubeSpace CubeADCS Gen 1 3-Axis, Small",
  maker: "CubeSpace",
  mpn: "CubeADCS 3-Axis (Small)",
  summary: "Three-axis attitude determination and control in a 90 x 96 x 57 mm PC/104 module: CubeComputer, CubeControl, three CubeWheel Small reaction wheels, two torquer rods and an air-core coil, a magnetometer, and inputs for a fine sun and nadir sensor, coarse sun sensors and a star tracker. Under 500 g; 3.3 V, the wheels on 5 V.",
  specs: { space_dev: "adcs", iface: "i2c", i2c_addr: "0x57", wheels: 3, wheel_mnms: 1.77, wheel_rpm: 8000, torquer_am2: 0.24, p_idle_w: 0.4, p_detumble_w: 1.1, p_point_w: 1.9, mass_g: 470, outgassing_tml: 0.6 },
  pins: [v3(0.06, "CubeComputer and sensors: about 0.2 W"), v5(0.02, "The wheels: about 0.6 W holding, up to 3 W spinning up"), sgnd(), i2c("SDA", 41), i2c("SCL", 43), pwrOut("SENS_3V3", 3.3, 0.3, { label: "SENS", note: "Supply to its star tracker and sun sensors, switched by the CubeComputer" }), { id: "SENS_SDA", label: "SENS SDA", type: "io", v: 3.3, imax: 0.004, bus: "i2c_sda", note: "Its own sensor bus, to the star tracker and the fine sun sensor" }, { id: "SENS_SCL", label: "SENS SCL", type: "io", v: 3.3, imax: 0.004, bus: "i2c_scl" }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `CSS${n}`, label: `CSS${n}`, type: "io" as const, v: 3.3, imax: 0.001, adc: true, note: "A coarse sun sensor's photodiode current, read through a transimpedance amplifier" }))],
  geom: { g: "space_adcs", route: "exact", dims: { w: PC104.w, d: PC104.d, h: 57, top_z: 38, wheel: 28, wheel_h: 26.2, wheel_x: 23.5, wall_x: 5, rod_w: 10.5 }, holes: PC104.holes, color: "#1c5a38" },
  price_usd: 43500,
  buy: [{ vendor: "CubeSatShop (CubeSpace's distributor)", url: "https://cubesatshop.com/?p=20801" }],
  source: "CubeSpace CubeADCS Gen 1 datasheet; CubeSatShop, \"from US$43,500\" read 14 Nov 2026",
  notes: ["CubeSatShop lists it from US$43,500: the published starting price.", "Its coarse sun sensors and the CubeStar star tracker are separate parts here, where they mount; the module's inside (where the wheels, rods and coil sit, and the bracket the star tracker is screwed to) is drawn the way this design arranges it, not from CubeSpace's drawing."],
};

export const CUBESTAR: CatalogPart = {
  id: "cubespace_cubestar",
  kind: "sensor",
  name: "CubeSpace CubeStar Gen 1 star tracker",
  maker: "CubeSpace",
  mpn: "CubeStar Gen 1",
  summary: "Nanosatellite star tracker: 0.02° (3σ) cross-boresight accuracy, 42° field of view, 1 Hz updates, I2C or UART to its ADCS. 50 x 35 x 55 mm with its baffle, 55 g, 142 mW.",
  specs: { space_dev: "star_tracker", fov_deg: 42, acc_deg: 0.02, p_w: 0.142, mass_g: 55, outgassing_tml: 0.5 },
  pins: [pwrIn("VIN", 3.1, 3.5, { label: "3V3", vabs: 3.6, draw: 0.043 }), gnd(), { id: "SDA", label: "SDA", type: "in", vmax: 3.6, vih: 2.3, bus: "i2c_sda", required: true }, { id: "SCL", label: "SCL", type: "in", vmax: 3.6, vih: 2.3, bus: "i2c_scl", required: true }],
  geom: { g: "space_tracker", dims: { w: 50, d: 35, h: 30, baffle_d: 32, baffle_h: 25, fov: 42 }, holes: [[21, 13.5], [-21, 13.5], [-21, -13.5], [21, -13.5]], color: "#18191c" },
  price_usd: 15390,
  buy: [{ vendor: "CubeSatShop (CubeSpace's distributor)", url: "https://cubesatshop.com/?p=20803" }],
  source: "CubeSpace CubeStar Gen 1 datasheet; CubeSatShop, US$15,390 read 14 Nov 2026",
  notes: ["CubeSatShop lists it at US$15,390.", "Keep the Sun and the Earth's limb out of its baffle's exclusion angle: here it looks out of the -X face, away from the Sun while the satellite points its panels at it."],
};

export const CUBESENSE: CatalogPart = {
  id: "cubespace_cubesense_sun",
  kind: "sensor",
  name: "CubeSpace CubeSense Sun fine sun sensor",
  maker: "CubeSpace",
  mpn: "CubeSense Sun",
  summary: "Fine sun sensor with a wide-angle camera and its own processor: better than 0.2° (1σ) over a 170° field, I2C to its ADCS. 41.7 x 17.7 x 22.9 mm, 30 g, 0.2 W.",
  specs: { space_dev: "sun_sensor", fov_deg: 170, acc_deg: 0.2, mass_g: 30, outgassing_tml: 0.5 },
  pins: [pwrIn("VIN", 3.1, 3.5, { label: "3V3", vabs: 3.6, draw: 0.06 }), gnd(), { id: "SDA", label: "SDA", type: "in", vmax: 3.6, vih: 2.3, bus: "i2c_sda", required: true }, { id: "SCL", label: "SCL", type: "in", vmax: 3.6, vih: 2.3, bus: "i2c_scl", required: true }],
  geom: { g: "space_sun", dims: { w: 41.7, d: 17.7, h: 22.9, win: 7 }, holes: [[17, 6], [-17, 6], [-17, -6], [17, -6]], color: "#18191c" },
  buy: [{ vendor: "CubeSatShop (CubeSpace's distributor)", url: "https://cubesatshop.com/product/cubesense/" }],
  source: "CubeSpace CubeSense datasheet",
  notes: ["Included in the CubeADCS 3-Axis bundle's price; sold alone on quotation."],
};

export const CSS: CatalogPart = {
  id: "cubespace_css",
  kind: "sensor",
  name: "CubeSpace coarse sun sensor (CSS)",
  maker: "CubeSpace",
  mpn: "CubeADCS CSS",
  summary: "A photodiode behind a cosine window on a small board with a two-wire lead, one per face: together they give the Sun's direction to about 10° whenever it is in view. Part of the CubeADCS bundle.",
  specs: { space_dev: "css", mass_g: 2 },
  pins: [{ id: "OUT", label: "A", type: "analog_out", v: 3.3, note: "Photodiode current to the ADCS's CSS input" } as PinDef, gnd()],
  geom: { g: "board", dims: { w: 12, d: 10, t: 1.6 }, holes: [[-4.5, 0], [4.5, 0]], hole_d: 1.6, features: [{ kind: "chip", x: 0, y: 0, w: 3.2, d: 3.2, h: 1.1 }], color: "#18191c" },
  buy: [{ vendor: "CubeSatShop (CubeSpace's distributor)", url: "https://cubesatshop.com/?p=20801" }],
  source: "CubeSpace CubeADCS Gen 1 datasheet",
  notes: ["Ten come with the CubeADCS 3-Axis bundle; four are used here, on the ±X faces and the ±Z ends."],
};

// ---------------- payload ----------------

export const MULTISCAPE: CatalogPart = {
  id: "simera_multiscape100",
  kind: "sensor",
  name: "Simera Sense MultiScape100 CIS multispectral imager",
  maker: "Simera Sense",
  mpn: "MultiScape100 CIS",
  summary: "Seven-band push-broom imager on a 95 mm Cassegrain telescope (580 mm focal length): 4.75 m ground sampling and a 19.4 km swath from 500 km, 2.96° field of view, 1.2 kg, 5.8 W imaging. Commanded over its serial port, data out over LVDS.",
  specs: { space_dev: "camera", iface: "uart", baud: 115200, aperture_mm: 94.8, focal_mm: 580, gsd_m: 4.75, swath_km: 19.4, bands: 7, p_img_w: 5.8, p_idle_w: 1.5, mass_g: 1200, outgassing_tml: 0.6 },
  pins: [{ ...v5(0.3, "Idle 1.5 W; imaging 5.8 W (1.2 A at 5 V)"), label: "+5V", stack: undefined }, gnd(), { id: "RX", label: "CMD RX", type: "in", vmax: 3.6, vih: 2.0, bus: "uart_tx", note: "Commands in: to the flight computer's TX" }, { id: "TX", label: "CMD TX", type: "out", v: 3.3, bus: "uart_rx", note: "Replies and image data out: to the flight computer's RX" } as PinDef],
  geom: { g: "space_telescope", route: "exact", dims: { len: 175.5, od: 96, bore: 92, front_l: 22, flange_z: 0, flange_t: 4, flange_w: 96, hole_sq: 76, body_w: 90, chamfer: 16, rear_l: 26, rear_w: 82, rear_sq: 60, sec_d: 47.2, prim_d: 94.8 }, color: "#16171a", color2: "#25282d" },
  buy: [{ vendor: "Simera Sense", url: "https://simera-sense.com/products/multiscape100/" }],
  source: "Simera Sense MultiScape100 CIS datasheet",
  notes: [QUOTE, "Simera publishes the envelope and optics; the housing's machining, its flanges and its connectors are drawn here the way such an instrument is built, not from Simera's drawing.", "Its LVDS data link to the flight computer is not simulated: the command port is."],
};

// ---------------- solar panels ----------------

const cellNote = "Azur Space 3G30C triple-junction GaAs cells (29.5 % at the start of life, 30.18 cm², about 2.4 V and 0.5 A each at their maximum power point) under 100 µm ceria-doped cover glass";

const panelPins = (vmp: number, imp: number, extra: PinDef[] = []): PinDef[] => [
  pwrOut("POS", vmp, imp, { label: "+", note: `The string's maximum power point: ${vmp} V at ${imp} A in full sun at the start of life` }),
  gnd("NEG", "-"),
  ...extra,
];

export const DSP_WING: CatalogPart = {
  id: "gomspace_dsp_wing",
  kind: "psu",
  name: "GomSpace NanoPower DSP deployable panel (wing)",
  maker: "GomSpace",
  mpn: "NanoPower DSP",
  external: true,
  summary: `One hinged wing of a NanoPower DSP double-deployable 3U array: six cells in series on an aluminium panel, 300 x 82 x 1.6 mm with a hold-down tab. ${cellNote}. Its string is wired through the hinge's flex harness to the body panel, whose connector carries it.`,
  specs: { space_dev: "solar", deployable: true, blocking_diode: true, cells: 6, cell_cm2: 30.18, eff: 0.295, v_mp: 14.5, i_mp: 0.505, v_oc: 16.2, mass_g: 150, outgassing_tml: 0.3 },
  pins: [],
  geom: { g: "space_panel", route: "exact", dims: { l: 300, w: 82, t: 1.6, n: 6, cell_w: 40.15, cell_l: 80.15, gap: 1.2, crop: 10, x0: 0, cover: 0.1, tab_l: 20, tab_w: 16, tab_hole: 12.5 }, color: "#c3c8ce", material: "Aluminum 6061" },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-dsp.aspx" }],
  source: "GomSpace NanoPower DSP datasheet (gs-ds-nanopower-dsp); Azur Space 3G30C datasheet",
  notes: [QUOTE, "Sold as a set: one body panel and two wings, with hinges, a hold-down and a burn board.", "GomSpace publishes the outline; the cell layout and the hinge positions are drawn here the way the set is built."],
};

export const DSP_BODY: CatalogPart = {
  id: "gomspace_dsp_body",
  kind: "psu",
  name: "GomSpace NanoPower DSP body panel",
  maker: "GomSpace",
  mpn: "NanoPower DSP",
  external: true,
  summary: `The body-mounted panel of a NanoPower DSP set, which the two wings hinge beside and fold over: six cells in series on an aluminium panel, 300 x 82 x 1.6 mm. ${cellNote}.`,
  specs: { space_dev: "solar", blocking_diode: true, cells: 6, cell_cm2: 30.18, eff: 0.295, v_mp: 14.5, i_mp: 0.505, v_oc: 16.2, mass_g: 149, outgassing_tml: 0.3 },
  pins: panelPins(14.5, 0.505, [pwrOut("WING_POS", 14.5, 1.01, { label: "W+", note: "The two wings' strings in parallel, through their hinges' flex harness and blocking diodes: 14.5 V at 1.01 A in full sun" }), gnd("WING_NEG", "W-")]),
  geom: { g: "space_panel", dims: { l: 300, w: 82, t: 1.6, n: 6, cell_w: 40.15, cell_l: 80.15, gap: 1.2, crop: 10, x0: 0, cover: 0.1, conn_x: 104, conn_y: 33.4 }, color: "#c3c8ce", material: "Aluminum 6061", holes: [[-134, 34], [-134, -34], [143, 34], [143, -34]], hole_d: 2.2, csink: 4 },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-dsp.aspx" }],
  source: "GomSpace NanoPower DSP datasheet (gs-ds-nanopower-dsp)",
  notes: [QUOTE, "Part of the DSP set (with its two wings)."],
};

export const P110_3U: CatalogPart = {
  id: "gomspace_p110_3u",
  kind: "psu",
  name: "GomSpace NanoPower P110 solar panel, 3U side",
  maker: "GomSpace",
  mpn: "NanoPower P110 (3U)",
  external: true,
  summary: `A body-mounted 3U side panel: a row of cells in series on a 1.6 mm circuit board, with a sun sensor and temperature sensor cut-outs. ${cellNote}.`,
  specs: { space_dev: "solar", blocking_diode: true, cells: 6, cell_cm2: 30.18, eff: 0.295, v_mp: 14.5, i_mp: 0.505, v_oc: 16.2, mass_g: 120, outgassing_tml: 0.3 },
  pins: panelPins(14.5, 0.505),
  geom: { g: "space_panel", dims: { l: 326, w: 82, t: 1.6, n: 6, cell_w: 40.15, cell_l: 80.15, gap: 1.2, crop: 10, x0: 20, cover: 0.1, conn_x: 92, conn_y: 33.4 }, color: "#121417", material: "FR4", holes: [[-149, 34], [-149, -34], [150, 34], [150, -34]], hole_d: 2.2, csink: 4 },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-p110.aspx" }],
  source: "GomSpace NanoPower P110 datasheet (gs-ds-nanopower-p110)",
  notes: [QUOTE, "Drawn with six cells and a window at its -Z end for a sensor; GomSpace builds the 3U side panel to order."],
};

export const P110_3U_WINDOW: CatalogPart = {
  ...P110_3U,
  id: "gomspace_p110_3u_tracker",
  name: "GomSpace NanoPower P110 solar panel, 3U side, star tracker window",
  summary: `A body-mounted 3U side panel with a window for a star tracker's baffle: four cells in series on a 1.6 mm circuit board. ${cellNote}.`,
  specs: { ...P110_3U.specs, cells: 4, v_mp: 9.7, v_oc: 10.8, mass_g: 110 },
  pins: panelPins(9.7, 0.505),
  geom: { ...P110_3U.geom, dims: { ...P110_3U.geom.dims, n: 4, x0: -61, win_x: 46.1, win_y: 0, win_w: 38, win_d: 38 }, holes: [...(P110_3U.geom.holes ?? []), [73, -20]] },
};

export const DSP_HOLDDOWN: CatalogPart = {
  id: "gomspace_dsp_holddown",
  kind: "sensor",
  name: "GomSpace NanoPower DSP hold-down and burn board",
  maker: "GomSpace",
  mpn: "NanoPower DSP",
  summary: "The board a DSP set's hold-down line is tied off on: the line runs over two redundant burn resistors, and a few seconds of current through either melts it and frees the wings.",
  specs: { space_dev: "burn", burn_ohm: 10, burn_s: 5, line: "Berkley NanoFil 0.28 mm UHMWPE", mass_g: 4 },
  pins: [pwrIn("BURN", 3, 5.5, { label: "BURN+", vabs: 6, draw: 0, required: true, note: "5 V from a switched EPS output: about 0.5 A through the two 10 Ω resistors while burning" }), gnd()],
  geom: { g: "space_holddown", dims: { w: 44, d: 14, t: 1.6, post_x: 1, post_y: 0, res_x: -14, conn_x: 19.4, conn_y: 3 }, holes: [], color: "#16301f" },
  buy: [{ vendor: "GomSpace", url: "https://gomspace.com/shop/subsystems/power/nanopower-dsp.aspx" }],
  source: "GomSpace NanoPower DSP datasheet",
  notes: ["Part of the DSP set."],
};

// ---------------- switches ----------------

export const D2F: CatalogPart = {
  id: "omron_d2f_f",
  kind: "switch",
  name: "Omron D2F-F subminiature basic switch",
  maker: "Omron",
  mpn: "D2F-F",
  summary: "Subminiature pin-plunger microswitch, SPDT, 3 A at 125 V AC (2 A at 30 V DC), 1.47 N operating force, 0.5 mm pretravel. 12.8 x 5.8 x 6.5 mm with solder terminals. The usual CubeSat deployment, RBF and hinge switch.",
  specs: { rating_a: 2, v_max: 30, force_n: 1.47, travel_mm: 0.5, mass_g: 0.5 },
  pins: [
    { id: "COM", label: "COM", type: "passive", through: "NC", required: true },
    { id: "NC", label: "NC", type: "passive", through: "COM", required: false, note: "Closed while the plunger is out (released), open while it is pressed" },
    { id: "NO", label: "NO", type: "passive", required: false, note: "Closed while the plunger is pressed" },
  ],
  geom: { g: "space_switch", dims: { w: 12.8, d: 5.8, h: 6.5, pin_d: 2, pin_h: 1.2, hole: 6.5 }, hole_d: 1.2, color: "#141518", color2: "#e8e4da" },
  price_usd: 3.1,
  buy: [
    { vendor: "element14 (AU)", url: "https://au.element14.com/omron/d2f-f/microswitch-pin-plunger-spdt-3a/dp/1653656" },
    { vendor: "DigiKey", url: "https://www.digikey.com.au/en/products/detail/omron-electronics-inc-emc-div/D2F-F/83262" },
  ],
  source: "Omron D2F datasheet",
  notes: ["Wired on its normally-closed contact: pressed in the dispenser (or by the RBF pin, or by a stowed panel) it is open."],
};

export const SPACE: CatalogPart[] = [P31U, BP4, ES_OBC, ES_UHF, ES_SBAND, ES_PATCH, ISIS_ANTS, CUBEADCS, CUBESTAR, CUBESENSE, CSS, MULTISCAPE, DSP_WING, DSP_BODY, P110_3U, P110_3U_WINDOW, DSP_HOLDDOWN, D2F];
