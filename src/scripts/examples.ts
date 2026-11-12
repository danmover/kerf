// Scripts to start from: each does one common job and shows a part of the API. They work on any design; the ones that
// try values pick the design's own parameters.

export interface ScriptExample {
  id: string;
  name: string;
  about: string;
  /** run after each change, as checks */
  onChange?: boolean;
  code: string;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    id: "sweep",
    name: "Mass and size by a parameter",
    about: "Tries the first number parameter at five values around its own, without changing the design, and tables the mass, size and failing checks.",
    code: `// Try a parameter at a few values without changing the design.
const params = await kerf.params();
const name = Object.keys(params).find((k) => typeof params[k] === "number" && params[k] > 0);
if (!name) return "This design has no number parameters to try.";
const now = params[name];
const rows = [];
for (const f of [0.8, 0.9, 1, 1.1, 1.2]) {
  const value = Math.round(now * f * 100) / 100;
  kerf.progress(rows.length, 5, name + " = " + value);
  const d = await kerf.variant({ [name]: value });
  rows.push({ [name]: value, "mass (g)": d.mass, "size (mm)": d.size ? d.size.join(" × ") : "", "checks failing": d.checks.fail });
}
kerf.table(rows, "Mass and size by " + name);
`,
  },
  {
    id: "stl-each",
    name: "Export every part to make",
    about: "One STL per part to make (named with how many), the parts list and the design itself, ready to download as one zip.",
    code: `// One STL for each part to make, with the parts list and the source.
const files = [
  ...(await kerf.export("stl", { each: true })),
  ...(await kerf.export("csv")),
  ...(await kerf.export("kerf")),
];
console.log("Made " + files.length + " files.");
`,
  },
  {
    id: "configs",
    name: "Every configuration: STEP, STL and mass",
    about: "For each configuration of the design: a STEP file, an STL a part and a row of mass and checks.",
    code: `// Each configuration (a configs block) as files, and how they compare.
const d = await kerf.design();
if (!d.configs.length) return "This design has no configurations. Save some in the Parameters tab first.";
const rows = [];
for (const config of d.configs) {
  kerf.progress(rows.length, d.configs.length, config);
  const v = await kerf.variant({}, { config });
  await kerf.export("step", { config, name: d.name + " " + config });
  await kerf.export("stl", { config, name: d.name + " " + config });
  rows.push({ config, "mass (g)": v.mass, "size (mm)": v.size ? v.size.join(" × ") : "", errors: v.errors.length, "checks failing": v.checks.fail });
}
kerf.table(rows, "Configurations");
`,
  },
  {
    id: "parts",
    name: "Parts report",
    about: "A table of every part with what it is made of, how heavy and how big, also saved as a CSV file.",
    code: `// Every part: material, process, mass and size.
const d = await kerf.design();
const rows = d.parts.map((p) => ({
  part: p.name,
  made: p.made ? "make" : "buy",
  material: p.material,
  process: p.process || "",
  "mass (g)": p.mass,
  "size (mm)": p.size ? p.size.join(" × ") : "",
}));
kerf.table(rows, d.name + ": " + rows.length + " parts, " + d.mass.toFixed(0) + " g");
const csv = ["part,made,material,process,mass g,size mm", ...rows.map((r) => [r.part, r.made, r.material, r.process, r["mass (g)"], r["size (mm)"]].join(","))].join("\\n");
await kerf.file(d.name + " parts.csv", csv);
`,
  },
  {
    id: "checks",
    name: "My own checks",
    about: "Checks of your own, on mass and size. Turn on Run after each change and they join the design's checks.",
    onChange: true,
    code: `// Your own rules for this design. With "Run after each change" on,
// each kerf.check shows in the Checks tab and the status ring.
const d = await kerf.design();
await kerf.check("Lighter than 500 g", d.mass < 500, d.mass.toFixed(0) + " g");
const [x, y, z] = d.size || [0, 0, 0];
const fits = x <= 256 && y <= 256 && z <= 256;
await kerf.check("Fits a 256 mm printer bed", fits ? true : "warn", x + " × " + y + " × " + z + " mm");
`,
  },
  {
    id: "strength",
    name: "Strength against a parameter",
    about: "Solves the design's first strength analysis at four values of a parameter and tables the safety factor and how far it moves.",
    code: `// Solve a strength analysis at a few values of a parameter.
const params = await kerf.params();
const name = Object.keys(params).find((k) => typeof params[k] === "number" && params[k] > 0);
if (!name) return "This design has no number parameters to try.";
const rows = [];
for (const f of [0.75, 1, 1.25, 1.5]) {
  const value = Math.round(params[name] * f * 100) / 100;
  kerf.progress(rows.length, 4, name + " = " + value);
  const a = await kerf.analyse(null, { [name]: value });
  rows.push({ [name]: value, verdict: a.verdict, safety: a.safety, "moves (mm)": a.deflection, "stress (MPa)": a.stress });
}
kerf.table(rows, "Strength by " + name);
`,
  },
  {
    id: "tidy",
    name: "Round the parameters",
    about: "Changes the design: every number parameter with a fraction goes to the nearest whole number, as one version you can undo.",
    code: `// Changes the design, as one version you can undo.
const params = await kerf.params();
const tidy = {};
for (const [name, value] of Object.entries(params)) {
  if (typeof value === "number" && !Number.isInteger(value)) tidy[name] = Math.round(value);
}
if (!Object.keys(tidy).length) return "Every number is whole already.";
await kerf.set(tidy);
return "Rounded " + Object.keys(tidy).join(", ");
`,
  },
];
