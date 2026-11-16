// How the FPV quad's bought boards look (catalog/drone.ts): the Kakute H7 flight controller and the Tekko32 4-in-1
// ESC, both black with white silkscreen and gold pads. Feature looks follow each catalog entry's feature order.

import type { BoardStyle } from "./look";

const BLACK = "#121316";
const WHITE_SILK = "#f1f1ea";

export const DRONE_BOARD_STYLES: Record<string, BoardStyle> = {
  // MCU in the middle, the gyro and barometer beside it, the OSD chip, the two regulator inductors, USB-C on the
  // left edge; the microSD slot is underneath (its own solid)
  holybro_kakute_h7_v15: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["KAKUTE H7", "HOLYBRO"],
    marks: ["STM32H743\nVIT6", "42688", "SPA06", "AT7456E", "4R7", "2R2"],
    looks: ["qfp", "qfn", "qfn", "soic", "inductor", "inductor", "usb_c", null],
    extras: [
      { look: "button", x: 10.5, y: 9.5, w: 3, d: 2, h: 1.2 },
      { look: "crystal", x: -6.5, y: 10.5, w: 3.2, d: 2.5, h: 0.8 },
    ],
    pinsFromPlugs: true,
    smd: 1.3,
    labels: [
      { text: "V1.5", x: 9, y: -12, size: 1.4 },
      { text: "ESC", x: -12.5, y: -4.5, size: 1.1, rot: 90 },
      { text: "HD", x: 12.8, y: 0, size: 1.1, rot: 90 },
    ],
  },
  // the four motors' MOSFETs along the front and rear edges, an MCU per motor, the current shunt by the battery pads
  holybro_tekko32_f4_metal_65a: {
    mask: BLACK,
    silk: WHITE_SILK,
    finish: "enig",
    title: ["TEKKO32 F4 METAL", "4in1 65A"],
    marks: ["", "", "", "", "", "", "", "", "R0002"],
    looks: ["mosfets", "mosfets", "mosfets", "mosfets", "qfn", "qfn", "qfn", "qfn", "shunt", null],
    pinsFromPlugs: true,
    smd: 1.4,
    labels: [
      { text: "M1", x: -15, y: -18, size: 1.3 },
      { text: "M2", x: 15, y: -18, size: 1.3 },
      { text: "M3", x: -15, y: 18, size: 1.3 },
      { text: "M4", x: 15, y: 18, size: 1.3 },
      { text: "AM32", x: 0, y: 10, size: 1.4 },
    ],
  },
};
