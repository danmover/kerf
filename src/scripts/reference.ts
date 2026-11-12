// The kerf API in words: shown beside the script editor, and given to Claude with its scripts tool.

/** One method a line, for the editor's completions and the help. */
export const SCRIPT_API: { name: string; sig: string; doc: string }[] = [
  { name: "design", sig: "kerf.design()", doc: "The open design: name, params, parts (name, made, material, process, mass g, size mm), mass, size, configs, errors, warnings, checks { pass, fail, warn, failing }, requirements." },
  { name: "params", sig: "kerf.params()", doc: "The parameters and their values: lengths in mm, angles in degrees, masses in g, forces in N." },
  { name: "variant", sig: "kerf.variant(values, { config })", doc: "The design with other values (and configuration), built and checked apart without changing it; the same summary as design()." },
  { name: "set", sig: "kerf.set(values)", doc: "Write values into the design. All of a run's changes become one version you can undo." },
  { name: "source", sig: "kerf.source()", doc: "The design's source text." },
  { name: "setSource", sig: "kerf.setSource(text, note)", doc: "Replace the design's source (one version at the end of the run, with the note)." },
  { name: "checks", sig: "kerf.checks()", doc: "Every check of the open design: status, title, detail, category, parts." },
  { name: "analyse", sig: "kerf.analyse(name, values)", doc: "Solve a strength analysis (the first one when name is null), on the design or with other values: verdict, safety, stress MPa, deflection mm, frequency Hz." },
  { name: "export", sig: 'kerf.export("stl" | "step" | "csv" | "kerf", { parts, each, name, values, config })', doc: "Files from the design or another reading of it: STL (each: one per part to make), STEP, the parts list, the source. Returns the file names." },
  { name: "file", sig: "kerf.file(name, text)", doc: "A file of your own (CSV, JSON, text, SVG...) in the run's files." },
  { name: "table", sig: "kerf.table(rows, title)", doc: "Show rows (objects or lists) as a table, which downloads as CSV." },
  { name: "check", sig: 'kerf.check(name, ok | "warn", detail)', doc: "A check of your own. Scripts set to run after each change show them in the Checks tab." },
  { name: "progress", sig: "kerf.progress(done, total, label)", doc: "Show how far the run has got." },
  { name: "projects", sig: "kerf.projects()", doc: "Your designs: name and when each last changed." },
  { name: "sleep", sig: "kerf.sleep(ms)", doc: "Wait a while (60 s at most)." },
  { name: "log", sig: "console.log(...)", doc: "A line of output (console.warn and console.error too)." },
];

export function scriptReference(): string {
  return `Scripts are JavaScript (await works at the top level; return a value to show it). Every kerf call returns a promise, so await it.
${SCRIPT_API.map((m) => `- ${m.sig}: ${m.doc}`).join("\n")}
A script runs in a sandbox with no network, files or storage of its own: it reaches the design only through kerf. Calls that fail throw an Error with the reason. A run builds up to 300 other readings of the design, makes up to 200 files and stops after 30 minutes. Scripts that run after each change may only look (no set or setSource).`;
}
