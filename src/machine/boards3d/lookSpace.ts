// How the CubeSat flight boards look (catalog/space.ts): black or navy solder mask with gold (ENIG) plating, the
// makers' names, the stack-through connectors drawn as the tall female rows they are, and the chips' markings.
// Their features start with the two stack connectors on top (and their tails underneath, drawn with the board).

import type { BoardStyle } from "./look";

const SILK = "#f1f1ea";
const STACK_LOOKS = ["header_f", "header_f", null, null] as const;

export const SPACE_STYLES: Record<string, BoardStyle> = {
  gomspace_p31u: {
    mask: "#101214",
    silk: SILK,
    finish: "enig",
    title: ["GOMSPACE", "NanoPower P31u"],
    marks: ["MSP430\nF2618", "LTC\n3119", "LTC\n3119", "LTC\n3119"],
    looks: [...STACK_LOOKS, "qfp", "qfn", "qfn", "qfn", "inductor", "inductor", "inductor", "box_header", "box_header", "box_header", "box_header", "box_header", "box_header"],
    smd: 1.4,
    labels: [
      { text: "PV1", x: -38, y: 18, size: 1.4 },
      { text: "PV2", x: 38, y: 18, size: 1.4 },
      { text: "OUT 1-6", x: 0, y: -40, size: 1.4 },
      { text: "BAT", x: -24, y: -36, size: 1.4 },
      { text: "KILL / RBF", x: 24, y: -36, size: 1.4 },
      { text: "H1", x: -36, y: 41.7, size: 1.4 },
      { text: "H2", x: -36, y: 35.6, size: 1.4 },
    ],
  },
  endurosat_obc: {
    mask: "#0e1726",
    silk: SILK,
    finish: "enig",
    title: ["EnduroSat", "OBC Type I"],
    marks: ["STM32F4\nARM", "S25FL\n512S", "MRAM"],
    looks: [...STACK_LOOKS, "qfp", "qfn", "soic", "sdcard", "sdcard", "crystal"],
    smd: 1.5,
    labels: [
      { text: "SD1", x: -26, y: -42.5, size: 1.4 },
      { text: "SD2", x: 2, y: -42.5, size: 1.4 },
      { text: "H1", x: -36, y: 41.7, size: 1.4 },
      { text: "H2", x: -36, y: 35.6, size: 1.4 },
    ],
  },
  endurosat_uhf_ii: {
    mask: "#0e1726",
    silk: SILK,
    finish: "enig",
    title: ["EnduroSat", "UHF Transceiver II"],
    marks: ["", "CC1125"],
    looks: [...STACK_LOOKS, "wroom", "qfn", "jst_sh"],
    smd: 1.3,
    labels: [
      { text: "ANT", x: 34, y: -38.5, size: 1.4 },
      { text: "H1", x: -36, y: 41.7, size: 1.4 },
    ],
  },
  endurosat_sband_tx: {
    mask: "#0e1726",
    silk: SILK,
    finish: "enig",
    title: ["EnduroSat", "S-Band Transmitter"],
    looks: [...STACK_LOOKS, "heatsink", "jst_sh"],
    heatsink: "#b9bec6",
    smd: 1.1,
    labels: [{ text: "RF OUT", x: 30, y: -42, size: 1.4 }],
  },
  cubespace_css: { mask: "#18191c", silk: SILK, finish: "enig", marks: ["PD"], looks: ["qfn"], smd: 0.2, labels: [{ text: "CSS", x: 0, y: -3.6, size: 1 }] },
};
