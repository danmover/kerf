// The Apps section of the language reference: how to write an app block, so
// the assistant can build a control program for a machine.

import { APP_FNS, APP_PROPS } from "./lang";
import { EXPR_FUNCTIONS } from "./expr";
import { PANEL_KINDS } from "./spec";

export function appReference(): string {
  const fns = Object.values(APP_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const kinds = PANEL_KINDS.map((k) => `${k.kind} (${k.label.toLowerCase()}, ${k.w}×${k.h})`).join(", ");
  return `## Apps (app blocks: live control programs for the machine)
An app block is the user's own program for the machine: panels of live numbers, gauges, charts, an XY scope, bars, lamps, buttons, sliders, a serial console, the design in 3D and a USB camera. It runs inside Kerf (the App view beside 3D and Drawings) on the machine's simulated twin (its firmware on a virtual board in a scenario's world, in real time), on the real machine over USB serial (Web Serial in Chrome, Edge and the desktop app), or on a finished scenario run; the user can save it as a program of its own (one HTML file, or an Electron desktop project). Build one when the user asks for a control program, dashboard, GUI, ground station, monitor or live view of a machine.

app "Maglev control room" {
  about: "Fly the model in the tunnel and read its drag live"
  twin: "Hold the model in the full wind"           // the scenario whose world the twin runs in; "none" for no twin; default the first scenario with firmware
  baud: 500000                                        // the real machine's serial speed (default 115200)
  hello: ["log on"]                                   // sent on connect, to start the data stream
  telemetry: [csv("T", "ms mode x:µm y:µm z:µm iLift:mA"), keys("D")]
  derive: [derive("air", "speed / 100", unit: "m/s")]
  commands: ["launch", "land", "fan 60"]              // the console suggests these
  columns: 6                                          // grid columns on a wide screen (default 6; rows are 88 px)
  window: 30s                                         // a chart's default window
  panels: [
    state(w: 2, h: 1),
    readout("Wind", [signal("air", max: 15), signal("drag / 100", label: "drag", unit: "mN", warn: "drag > 2000")], big: true),
    scope("Top view", "x", "y", range: 600, trail: 3s, unit: "µm"),
    chart("Height", ["z", "zref"], unit: "µm", w: 4),
    bars("Coils", ["iLift", "i1", "i2", "i3", "i4"], min: -2000, max: 2000, unit: "mA"),
    lamps("Status", [lamp("Floating", "mode == 2", color: "green", off: "landed"), lamp("Fault", "fault != \\"\\"", color: "red")]),
    controls("Run", [button("Launch", "launch", tone: "accent", key: "l"), button("Land", "land", key: " "), slider("Fan", "fan {}", max: 100, unit: "%", state: "fan"), toggle("Logging", "log on", "log off")]),
    model("Live", moves: [slide(model_body, Z, "z / 1000")]),
    console(commands: ["status", "help"]),
  ]
}

Properties: ${APP_PROPS.join(", ")}. Every panel takes w: and h: (grid columns and rows) and a title first; kinds: ${kinds}.
Functions (only inside an app block):
${fns}

Signals: a panel's signals are expressions over names, written as text: "z / 1000", "abs(x) > 300", "hypot(x, y)", "mode == 2 ? 1 : 0", "contains(state, \\"hold\\")". Operators + - * / % ^, comparisons, && || !, cond ? a : b. Functions: ${EXPR_FUNCTIONS.join(", ")}; the windowed ones take a name and seconds (avg(z, 2), rms(iLift, 1), wander(x, 5), rate(z, 0.5)). A name with no data yet reads NaN and shows as "no data".
Where names come from:
- the firmware's lines, read by the telemetry formats (default: name=value pairs anywhere in a line). csv names its columns in order after a first word; keys reads name=value or name: value pairs; json reads JSON objects. Every line also gives line (the text), state (from lines like "state: hovering") and fault (lines with FAULT or ERROR).
- derive() values, usable by name in any panel.
- on the simulated twin only, the simulation's own channels: <motor>.rpm, .amps, .temp, .turns; <actuator>.pos; <battery or supply>.volts, .soc; sensors; world channels (pit.progress, tunnel.drag, …); and fw.<variable> for the firmware's own globals. They are blank on the real machine, so a panel the user will use on the hardware must read what the firmware prints: make the firmware print a telemetry line (for example "T,ms,mode,x,y,z" every 20 ms after "log on") and give the app the matching csv() format.
Commands: buttons, sliders, toggles, fields and choices send text lines to the firmware's serial console ({} is replaced by the value; without {} the value follows a space). The firmware must understand them: Kerf's generated firmware has a console (help lists its commands).

Before saying an app works, call try_app: it runs the app on the twin headless, types its hello and the commands you give, and returns what the firmware printed, what the telemetry read and what every panel would show, flagging panels with no data. With app: "none" it shows a firmware's lines and channels before an app exists. Panels and the twin re-run as the design changes; the user can also build and change the app themselves (Build in the App view writes the same block).
`;
}
