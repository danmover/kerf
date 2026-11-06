// Settings → AI → Bench: runs the Kerf bench with the user's key, shows how
// far it has got, and saves the report as a file the user can send.

import { useBench, runBench, cancelBench, COMPARE } from "../bench/run";
import { useSettings } from "../app/settings";
import { BENCH, CORE } from "../bench/cases";
import { benchFileName, benchMarkdown, benchTotals } from "../bench/report";
import { confirmDialog, errorText, toast } from "../app/ui";
import { download } from "../persist/files";
import { Icon } from "./icons";

/** about what a run costs on Opus 5.5 at today's prompt size: an estimate, shown before anything is spent */
const ESTIMATE = { core: 15, all: 40, compare: 35 };

async function start(kind: "core" | "all" | "compare") {
  const cases = kind === "all" ? BENCH : CORE;
  const ok = await confirmDialog(
    kind === "compare"
      ? {
          title: `Compare ${COMPARE.length} set-ups on ${cases.length} asks?`,
          body: `Claude works through the ${cases.length} core asks ${COMPARE.length} times on your key: ${COMPARE.map((w) => w.label).join("; ")}. Each runs in a project of its own that is deleted afterwards, and your settings are put back at the end. It costs about $${ESTIMATE.compare} and takes a long while; you can stop it at any time.`,
          confirm: "Compare them",
        }
      : {
          title: `Run ${cases.length} bench asks?`,
          body: `Claude works through ${cases.length} real asks on your key, as it would for you (without your saved lessons), each in a project of its own that is deleted afterwards. Your designs are not touched. It costs about $${kind === "all" ? ESTIMATE.all : ESTIMATE.core} on Opus and takes a while; you can stop it at any time.`,
          confirm: "Run the bench",
        },
  );
  if (!ok) return;
  try {
    const run = await runBench(cases, kind === "compare" ? COMPARE : []);
    download(benchMarkdown(run), benchFileName(run), "text/markdown");
    const t = benchTotals(run);
    const title = run.setups ? `Bench: ${run.setups.map((w) => `${w.label} ${benchTotals(run, w.id).passed} of ${cases.length}`).join(", ")}` : `Bench: ${t.passed} of ${t.cases} asks passed`;
    toast({ kind: t.passed === t.cases ? "success" : "info", title, detail: "The report was saved to your downloads." }, 8000);
  } catch (e) {
    toast({ kind: "error", title: "The bench could not run", detail: errorText(e) });
  }
}

export function BenchSection() {
  const b = useBench();
  const t = b.run ? benchTotals(b.run) : null;
  const claude = !useSettings((s) => s.model).startsWith("gpt-");
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="section-label" style={{ marginTop: 0 }}>
        Bench
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Measure how well Claude does</div>
          <div className="d">
            Runs real asks one by one (walls to 3 mm, a hook for a broom, an Arduino enclosure, a question about a part) and marks every result: it builds, no check newly fails, and each thing asked for is measured, with the time and cost. About ${ESTIMATE.core} for the {CORE.length} core asks or ${ESTIMATE.all} for all {BENCH.length}, on your key.
            {claude && ` Compare runs the core asks under ${COMPARE.length} set-ups side by side (${COMPARE.map((w) => w.label).join("; ")}), for about $${ESTIMATE.compare}.`} The report saves as a file you can send.
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {b.running ? (
            <button className="btn sm danger" onClick={cancelBench}>
              <Icon.Stop size={12} /> Stop
            </button>
          ) : (
            <>
              <button className="btn sm" onClick={() => void start("core")}>
                Run {CORE.length}
              </button>
              <button className="btn sm ghost" onClick={() => void start("all")}>
                All {BENCH.length}
              </button>
              {claude && (
                <button className="btn sm ghost" onClick={() => void start("compare")}>
                  Compare
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {b.running && (
        <div className="help" role="status">
          Ask {b.at} of {b.total}: {b.current}
          {t && t.cases > 0 ? ` · ${t.passed} of ${t.cases} passed so far · $${t.cost.toFixed(2)}` : ""}
        </div>
      )}
      {!b.running && b.run && t && (
        <div className="help" role="status">
          Last run: {b.run.setups ? b.run.setups.map((w) => `${w.label} ${benchTotals(b.run!, w.id).passed} of ${benchTotals(b.run!, w.id).cases}`).join(" · ") : `${t.passed} of ${t.cases} asks passed (${t.marksOk} of ${t.marks} marks)`}, ${t.cost.toFixed(2)}, {Math.round(t.seconds / 60)} min.{" "}
          <button type="button" className="link" onClick={() => download(benchMarkdown(b.run!), benchFileName(b.run!), "text/markdown")}>
            Save the report again
          </button>
        </div>
      )}
    </section>
  );
}
