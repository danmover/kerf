// Runs before the rest of the server: import this first, then load the rest
// with a dynamic import. Node prints a warning when its built-in SQLite driver
// loads. Kerf knows it uses it, so that one warning is dropped; every other
// warning still prints.

const emit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;

// node:sqlite works without a flag from Node 22.13. Say so plainly instead of
// failing with a module-not-found error.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`The Kerf server needs Node.js 22.13 or newer; this is ${process.versions.node}.`);
  process.exit(1);
}
