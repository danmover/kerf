// The kerf API as a script sees it: plain JavaScript that runs in the script's worker before its own code. Each method
// posts a call to Kerf and waits for the answer; console output and progress go the same way. It is sent with every
// run (see sandbox.ts), so the sandbox page itself stays a few lines that only start the worker.

/** Lines the function wrapper adds before a script's first line, in error positions. */
export const WRAP_LINES = 2;

export const SCRIPT_PRELUDE = String.raw`(function () {
"use strict";
var post = self.postMessage.bind(self);
var waiting = new Map();
var next = 1;
var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// the sandbox has no origin, storage or network already; these go too, so a script cannot even try
["indexedDB", "caches", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "BroadcastChannel", "importScripts", "Worker", "SharedWorker"].forEach(function (k) {
  try { delete self[k]; } catch (e) {}
  try { if (k in self) Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
});
function text(v) {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
  if (v instanceof Error) return v.message;
  if (typeof v !== "object" || v === null) return String(v);
  try {
    var s = JSON.stringify(v, function (k, x) { return typeof x === "number" && !Number.isInteger(x) ? Math.round(x * 1e6) / 1e6 : x; }, 2);
    return s === undefined ? String(v) : s.length > 20000 ? s.slice(0, 20000) + " …" : s;
  } catch (e) { return String(v); }
}
function call(method, args) {
  // where the script made the call, so a call that fails points at the script's own line
  var at = new Error();
  return new Promise(function (resolve, reject) {
    var id = next++;
    waiting.set(id, { resolve: resolve, reject: reject, at: at });
    post({ kind: "call", id: id, method: method, args: args });
  });
}
self.onmessage = function (e) {
  var m = e.data;
  if (!m || m.kind !== "reply") return;
  var w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.value);
  else {
    var err = new Error(m.error);
    try { Object.defineProperty(err, "kerfAt", { value: w.at.stack }); } catch (x) {}
    w.reject(err);
  }
};
function say(level) {
  return function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(text(arguments[i]));
    post({ kind: "log", level: level, text: parts.join(" ") });
  };
}
var out = { log: say("log"), info: say("log"), debug: say("log"), warn: say("warn"), error: say("error") };
var kerf = {
  design: function () { return call("design", []); },
  params: function () { return call("params", []); },
  variant: function (values, options) { return call("variant", [values || {}, options || {}]); },
  set: function (values) { return call("set", [values || {}]); },
  source: function () { return call("source", []); },
  setSource: function (source, note) { return call("setSource", [source, note]); },
  checks: function () { return call("checks", []); },
  analyse: function (name, values) { return call("analyse", [name === undefined ? null : name, values || {}]); },
  "export": function (format, options) { return call("export", [format, options || {}]); },
  file: function (name, content) { return call("file", [name, typeof content === "string" ? content : text(content)]); },
  table: function (rows, title) { return call("table", [rows, title === undefined ? null : title]); },
  check: function (name, ok, detail) { return call("check", [name, ok === "warn" ? "warn" : !!ok, detail === undefined ? null : text(detail)]); },
  projects: function () { return call("projects", []); },
  progress: function (done, total, label) { post({ kind: "progress", done: +done || 0, total: +total || 0, label: label === undefined ? undefined : String(label) }); },
  sleep: function (ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, Math.min(60000, +ms || 0))); }); },
  log: out.log
};
kerf.analyze = kerf.analyse;
out.table = function (rows, title) { return kerf.table(rows, title); };
Object.freeze(kerf);
Object.freeze(out);
// the first frame in the script's own code: V8 shows it as eval at __kerfRun ... <anonymous>:line:col, Firefox as
// ... > AsyncFunction:line:col; lines count from the function the code was wrapped in
function lineOf(e) {
  var rows = (String(e && e.stack || "") + "\n" + String(e && e.kerfAt || "")).split("\n");
  for (var i = 0; i < rows.length; i++) {
    var m = /eval at [^\n]*__kerfRun[^\n]*<anonymous>:(\d+):\d+\)?\s*$/.exec(rows[i]) || /> AsyncFunction:(\d+):\d+\s*$/.exec(rows[i]);
    if (m) return Math.max(1, +m[1] - ${WRAP_LINES});
  }
  return undefined;
}
self.__kerfRun = async function (code) {
  var fn;
  try { fn = new AsyncFunction("kerf", "console", code); }
  catch (e) { post({ kind: "done", ok: false, error: (e && e.name === "SyntaxError" ? "The script does not read as JavaScript: " : "") + String(e && e.message || e) }); return; }
  try {
    var value = await fn(kerf, out);
    post({ kind: "done", ok: true, value: value === undefined ? undefined : text(value) });
  } catch (e) {
    post({ kind: "done", ok: false, error: String(e && e.message || e), line: lineOf(e) });
  }
};
})();`;
