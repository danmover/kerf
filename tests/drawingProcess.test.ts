// A part's drawing states the general tolerance of the process that makes it.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { autoDrawings, withProcessTolerance } from "../src/drawing/views";
import { generalDeviation } from "../src/drawing/spec";

const SRC = `
part milled {
  material: "Aluminum 6061"
  process: mfg.cnc_mill(tool_d: 3)
  body box(40, 30, 6)
}
part printed {
  process: mfg.fdm()
  body box(20, 20, 10, at: (60, 0, 0))
}
part plain {
  body box(10, 10, 10, at: (-40, 0, 0))
}
drawing printed_drawing {
  title: "Printed"
  of: printed
}
drawing milled_drawing {
  title: "Milled"
  of: milled
  tolerance: "ISO 2768-f"
}
`;

describe("general tolerance from the process", () => {
  const model = evaluate(SRC);

  it("evaluates", () => {
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("automatic drawings follow each part's process", () => {
    const auto = autoDrawings(model);
    expect(auto.find((s) => s.name === "auto:plain")?.tolerance).toBe("ISO 2768-m");
    // milled and printed have their own drawing blocks, so no automatic ones
    expect(auto.find((s) => s.name === "auto:printed")).toBeUndefined();
    const solo = evaluate(SRC.replace(/drawing [\s\S]*$/, ""));
    const specs = autoDrawings(solo);
    expect(specs.find((s) => s.name === "auto:milled")?.tolerance).toBe("ISO 2768-m");
    expect(specs.find((s) => s.name === "auto:printed")?.tolerance).toBe("±0.3 UNLESS STATED");
  });

  it("drawing blocks follow the process unless they set tolerance", () => {
    const specs = withProcessTolerance(model, model.drawings);
    expect(specs.find((s) => s.name === "printed_drawing")?.tolerance).toBe("±0.3 UNLESS STATED");
    expect(specs.find((s) => s.name === "milled_drawing")?.tolerance).toBe("ISO 2768-f");
  });

  it("a flat ± note gives every size the same general deviation", () => {
    expect(generalDeviation("±0.3 UNLESS STATED", 12)).toBe(0.3);
    expect(generalDeviation("ISO 2768-m", 12)).toBe(0.2);
    expect(generalDeviation("AS NOTED", 12)).toBeNull();
  });
});
