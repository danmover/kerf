// How each kind of cable end is made and how it goes on its part: the
// housing and crimp contacts to buy, how much insulation to strip, the tool,
// which way the plug goes in, what holds it there and how it comes off. The
// cable card shows this beside each end, and the harness cut list prints it,
// so a cable can be made and fitted on the bench from Kerf alone.

import type { PlugKind } from "./plugs";

export interface PlugGuide {
  /** what to put on the wire's end: housing and contacts, terminal, or nothing (a part's own lead) */
  make: string;
  /** insulation to strip, mm */
  strip?: number;
  /** the tool that makes the end */
  tool?: string;
  /** how it goes on */
  mate: string;
  /** what holds it there */
  hold: string;
  /** how it comes off */
  unplug: string;
  /** it only goes in one way round */
  keyed: boolean;
}

/** Insulated crimp terminals are colour coded by the wire they take. */
function crimpRange(awg: number | undefined): string {
  if (awg === undefined) return "red (22–16 AWG) or blue (16–14 AWG)";
  if (awg >= 16) return "red, for 22–16 AWG";
  if (awg >= 14) return "blue, for 16–14 AWG";
  return "yellow, for 12–10 AWG";
}

/** The smallest bootlace ferrule a wire fits (its copper area in mm², rounded up to a ferrule size). */
export function ferruleSize(awg: number | undefined): string {
  if (awg === undefined) return "0.5 mm²";
  if (awg >= 24) return "0.25 mm²";
  if (awg >= 22) return "0.34 mm²";
  if (awg >= 20) return "0.5 mm²";
  if (awg >= 18) return "1.0 mm²";
  if (awg >= 16) return "1.5 mm²";
  if (awg >= 14) return "2.5 mm²";
  if (awg >= 12) return "4 mm²";
  return "6 mm²";
}

/** JST XH takes two contact sizes: the thinner for 28–26 AWG, the thicker for 26–22 AWG. */
const xhContact = (awg?: number) => (awg !== undefined && awg >= 27 ? "SXH-001T-P0.6 contacts (28–26 AWG)" : "SXH-002T-P0.6 contacts (26–22 AWG)");

/** How a kind of end is made and fitted, for a housing of `ways` contacts on wire of `awg`. */
export function plugGuide(kind: PlugKind, ways: number, awg?: number): PlugGuide {
  const w = Math.max(1, ways);
  switch (kind) {
    case "xh":
      return {
        make: `JST XHP-${w} housing with ${xhContact(awg)}`,
        strip: 2,
        tool: "open-barrel ratchet crimper (JST WC-110 or an Engineer PA-09)",
        mate: "Line the ramp on the housing up with the slots in the header wall and push it straight down until it seats.",
        hold: "Friction lock: the housing's ramp catches the header wall.",
        unplug: "Hold the housing, not the wires, and pull it straight off.",
        keyed: true,
      };
    case "ph":
      return {
        make: `JST PHR-${w} housing with SPH-002T-P0.5S contacts (30–24 AWG)`,
        strip: 1.5,
        tool: "fine open-barrel crimper (JST WC-240 or an Engineer PA-09)",
        mate: "The housing's two ribs go to the open side of the header. Push it straight in until it stops.",
        hold: "Friction lock in the header's walls.",
        unplug: "Pull by the housing, rocking it gently. Never by the wires.",
        keyed: true,
      };
    case "sh":
      return {
        make: `JST SHR-0${w}V-S-B housing with SSH-003T-P0.2 contacts (32–28 AWG). Usually bought made up as a STEMMA QT or Qwiic cable`,
        strip: 1,
        tool: "bought made up: the contacts are too small to crimp well by hand",
        mate: "The flat face of the plug goes to the socket's latch side. Push it straight in until it clicks.",
        hold: "A small latch bump on the housing.",
        unplug: "Pull straight out by the housing with your fingernails. The contacts are tiny, so never pull the wires.",
        keyed: true,
      };
    case "dupont":
      return {
        make: `1×${w} Dupont 2.54 mm housing with female crimp contacts (28–22 AWG)`,
        strip: 2,
        tool: "Dupont ratchet crimper (an Engineer PA-09 or an SN-28B)",
        mate: "Push it onto the header pins until it bottoms. It is not keyed: put the housing's triangle (pin 1) on the board's pin 1.",
        hold: "Friction only. Add a dab of hot glue or a housing latch if the machine vibrates.",
        unplug: "Pull it straight off the pins by the housing.",
        keyed: false,
      };
    case "ferrule":
      return {
        make: `bootlace ferrule, ${ferruleSize(awg)}`,
        strip: 8,
        tool: "ferrule crimper (square or hexagonal die)",
        mate: "Back the terminal's screw out, push the ferrule in until its collar meets the terminal.",
        hold: "Tighten the screw (about 0.4 N·m on a 5 mm terminal), then give the wire a firm tug.",
        unplug: "Loosen the screw and pull the ferrule out.",
        keyed: false,
      };
    case "fork":
      return {
        make: `insulated fork terminal, ${crimpRange(awg)}, for an M3.5 screw`,
        strip: 5,
        tool: "ratchet crimper for insulated terminals",
        mate: "Loosen the barrier screw a few turns and slide the fork under its washer.",
        hold: "The barrier screw, done up firmly.",
        unplug: "Loosen the screw and slide the fork out. The screw stays in.",
        keyed: false,
      };
    case "ring":
      return {
        make: `insulated ring terminal, ${crimpRange(awg)}`,
        strip: 5,
        tool: "ratchet crimper for insulated terminals",
        mate: "Take the nut or screw off, put the ring over the stud and refit it.",
        hold: "The nut or screw: a ring cannot slip out even if it loosens.",
        unplug: "Take the nut or screw off.",
        keyed: false,
      };
    case "usb_c":
      return { make: "USB-C cable (bought)", tool: "none", mate: "It goes in either way up. Push it straight in.", hold: "Friction latch inside the socket.", unplug: "Pull it straight out by the plug.", keyed: false };
    case "usb_micro":
      return { make: "micro-USB cable (bought)", tool: "none", mate: "The plug's wider face goes to the socket's wider side. It only goes in one way, so never force it.", hold: "Two small latches on the plug.", unplug: "Pull it straight out by the plug.", keyed: true };
    case "usb_a":
      return { make: "USB-A cable (bought)", tool: "none", mate: "The plug's hollow side goes over the socket's tongue. It only goes in one way.", hold: "Friction springs in the socket.", unplug: "Pull it straight out by the plug.", keyed: true };
    case "xt60":
      return {
        make: "XT60 connector with solder cups (12–14 AWG), heat-shrink over each joint",
        strip: 5,
        tool: "60–80 W soldering iron, heat-shrink and a heat gun",
        mate: "The bevelled corners line up: push the two halves firmly together.",
        hold: "Tight spring contacts.",
        unplug: "Grip both bodies, not the wires, and pull straight apart.",
        keyed: true,
      };
    case "lead":
      return { make: "nothing: it is the part's own lead", tool: "none", mate: "The lead leaves the part here.", hold: "Fixed to the part.", unplug: "It stays with the part.", keyed: false };
    case "solder":
      return {
        make: "tinned wire end",
        strip: 3,
        tool: "soldering iron and flux",
        mate: "Tin the pad and the wire, lay the wire on the pad and reflow it.",
        hold: "The solder joint. Tie the wire down close by so it does not flex at the pad.",
        unplug: "Desolder it.",
        keyed: false,
      };
    case "lug":
      return {
        make: "wire hooked through the solder lug, heat-shrink over it",
        strip: 5,
        tool: "soldering iron, heat-shrink and a heat gun",
        mate: "Slide heat-shrink on first, hook the wire through the lug, pinch it and solder it.",
        hold: "The solder joint, sleeved.",
        unplug: "Desolder it.",
        keyed: false,
      };
    case "barrel":
      return { make: "the power brick's own cord (5.5 × 2.1 mm plug)", tool: "none", mate: "Push the plug fully into the jack. Check the brick's polarity mark matches (usually centre positive).", hold: "The jack's spring contact.", unplug: "Pull it out by the plug.", keyed: false };
    case "spade":
      return {
        make: `6.3 mm insulated female spade, ${crimpRange(awg)}`,
        strip: 5,
        tool: "ratchet crimper for insulated terminals",
        mate: "Push it all the way onto the 6.3 mm tab.",
        hold: "The spade's spring grip.",
        unplug: "Pull it off by the insulator, not the wire.",
        keyed: false,
      };
    case "lever":
      return { make: "stripped end", strip: 11, tool: "wire strippers", mate: "Lift the lever, push the wire in until it stops, close the lever.", hold: "The lever's spring clamp.", unplug: "Lift the lever and pull the wire out.", keyed: false };
    case "bare":
      return { make: "stripped and twisted end (a ferrule is better)", strip: 6, tool: "wire strippers", mate: "Back the screw out and push the twisted strands in.", hold: "Tighten the screw, then tug the wire.", unplug: "Loosen the screw.", keyed: false };
    case "ufl":
      return { make: "U.FL coax pigtail (bought)", tool: "U.FL pull tool", mate: "Hold it square over the socket and press straight down with a flat tool until it clicks.", hold: "Snap fit, good for about 30 matings.", unplug: "Lift it straight up with a U.FL pull tool, never by the coax.", keyed: false };
  }
}
