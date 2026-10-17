// What the recorded series are, for plots: a readable name, the unit, and
// the group a plot picker puts them in. Series names are `<thing>.<field>`.

export interface ChannelInfo {
  label: string;
  unit: string;
  group: string;
}

const FIELD: Record<string, { label: string; unit: string }> = {
  rpm: { label: "speed", unit: "rpm" },
  amps: { label: "current", unit: "A" },
  volts: { label: "voltage", unit: "V" },
  temp: { label: "temperature", unit: "°C" },
  torque: { label: "torque", unit: "N·m" },
  turns: { label: "turns", unit: "turns" },
  pos: { label: "stroke", unit: "mm" },
  force: { label: "force", unit: "N" },
  angle: { label: "angle", unit: "°" },
  soc: { label: "charge", unit: "%" },
  thrust: { label: "thrust", unit: "N" },
  slip: { label: "slip", unit: "%" },
  buried: { label: "in the sand", unit: "%" },
  sand_torque: { label: "sand torque", unit: "N·m" },
  px: { label: "x", unit: "mm" },
  py: { label: "y", unit: "mm" },
  pz: { label: "z", unit: "mm" },
  yaw: { label: "heading", unit: "°" },
  pitch: { label: "pitch", unit: "°" },
  roll: { label: "roll", unit: "°" },
};

const PIT: Record<string, { label: string; unit: string }> = {
  progress: { label: "progress", unit: "mm" },
  remaining: { label: "to the far wall", unit: "mm" },
  offset: { label: "off the line (+ left)", unit: "mm" },
  height: { label: "height off the line", unit: "mm" },
  speed: { label: "speed", unit: "mm/s" },
  heading: { label: "heading (+ left)", unit: "°" },
  pitch: { label: "pitch (+ up)", unit: "°" },
  roll: { label: "roll", unit: "°" },
  hinge: { label: "hinge angle (+ left)", unit: "°" },
  resist: { label: "sand resistance", unit: "N" },
  thrust: { label: "net screw thrust", unit: "N" },
  roll_rate: { label: "roll rate", unit: "°/s" },
  wall_push: { label: "pressing on a wall", unit: "N" },
  stress: { label: "sand stress at the robot", unit: "kPa" },
  push: { label: "helper's push on the tail", unit: "N" },
};

/** A printer run's series. */
const PRINTER: Record<string, { label: string; unit: string; group: string }> = {
  "nozzle.x": { label: "nozzle x", unit: "mm", group: "Toolhead" },
  "nozzle.y": { label: "nozzle y", unit: "mm", group: "Toolhead" },
  "nozzle.z": { label: "nozzle z", unit: "mm", group: "Toolhead" },
  "print.speed": { label: "move speed", unit: "mm/s", group: "Toolhead" },
  "print.flow": { label: "plastic flow", unit: "mm³/s", group: "Extrusion" },
  "print.under": { label: "under-extrusion", unit: "%", group: "Extrusion" },
  "hotend.temp": { label: "hotend temperature", unit: "°C", group: "Heaters" },
  "hotend.target": { label: "hotend target", unit: "°C", group: "Heaters" },
  "hotend.power": { label: "hotend heater", unit: "%", group: "Heaters" },
  "bed.temp": { label: "bed temperature", unit: "°C", group: "Heaters" },
  "bed.target": { label: "bed target", unit: "°C", group: "Heaters" },
  "bed.power": { label: "bed heater", unit: "%", group: "Heaters" },
  "fan.part": { label: "part fan", unit: "%", group: "Heaters" },
  "psu.watts": { label: "power drawn", unit: "W", group: "Power" },
};

export function channelInfo(name: string): ChannelInfo {
  if (PRINTER[name]) return PRINTER[name];
  if (/^(x|y|z|extruder)\.load$/.test(name)) return { label: `${name.split(".")[0]} motor torque used`, unit: "%", group: "Motors" };
  const dot = name.indexOf(".");
  const thing = dot < 0 ? name : name.slice(0, dot);
  const field = dot < 0 ? "" : name.slice(dot + 1);
  if (thing === "pit" && PIT[field]) return { ...PIT[field], group: "Sand pit" };
  if (thing === "fw") return { label: field, unit: "", group: "Firmware variables" };
  if (thing === "nose") return { label: `nose ${field}`, unit: "mm", group: "Pose" };
  if (thing === "logic") return { label: "logic supply", unit: "V", group: "Power" };
  if (thing === "front" || thing === "rear") return { label: `${thing} body ${FIELD[field]?.label ?? field}`, unit: FIELD[field]?.unit ?? "", group: "Pose" };
  const f = FIELD[field];
  return { label: `${thing} ${f?.label ?? field}`, unit: f?.unit ?? "", group: thing };
}

/** The series a scenario's plots open with, by world. */
export const DEFAULT_PLOTS: Record<string, string[][]> = {
  sand_pit: [["pit.progress"], ["pit.offset"], ["pit.heading", "pit.hinge"], ["*.amps"], ["*.temp"]],
  bench: [["*.rpm"], ["*.amps"], ["*.temp"]],
  printer: [["hotend.temp", "hotend.target"], ["bed.temp", "bed.target"], ["print.flow"], ["*.load"], ["psu.watts"]],
};
