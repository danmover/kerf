// Groups in the 3D view (show one on its own, put parts in one), the assistant's
// view tools, where plywood's plies run, and the text printed on a LiPo pack.

import { beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { partGroups, soloHidden } from "../src/app/partGroups";
import { withGroup } from "../src/app/groups";
import { plyLayout } from "../src/ui/viewport/render/partShader";
import { packText } from "../src/ui/viewport/parts/decorate";
import { catalogPart } from "../src/machine/catalog";
import { useView } from "../src/app/view";
import { useDesign } from "../src/core/engine";
import { runViewTool, VIEW_TOOL_DEFS } from "../src/ai/viewTools";
import { QUICK_TOOLS } from "../src/ai/routing";

const SRC = `design "Rig"
part duct { group: "Fan unit"  body cylinder(d: 70, h: 60) }
part lip { group: "Fan unit"  body cylinder(d: 80, h: 6, at: (0, 0, 60)) }
part base { body box(300, 300, 9) }
part tray {
  body box(200, 50, 6, at: (0, 117, 9))
}
`;

describe("part groups", () => {
  it("lists the design's groups in order, and hides everything else when some are shown on their own", () => {
    const m = evaluate(SRC);
    const gs = partGroups(m.parts);
    expect(gs.map((g) => g.name)).toEqual(["Fan unit", "Parts"]);
    expect(gs[0].blocks).toEqual(["duct", "lip"]);
    expect(soloHidden(m.parts, ["fan unit"]).sort()).toEqual(["base", "tray"]);
    expect(soloHidden(m.parts, [])).toEqual([]);
    // a name that matches no group hides nothing, rather than everything
    expect(soloHidden(m.parts, ["Nozzle"])).toEqual([]);
  });

  it("puts parts in a group by writing group: on their blocks, one-line and multi-line alike", () => {
    const m = evaluate(SRC);
    const r = withGroup(SRC, m, ["base", "tray", "duct"], "  Base   and power ");
    expect(r.changed).toEqual(["base", "tray", "duct"]);
    const m2 = evaluate(r.src);
    expect(m2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const by = Object.fromEntries(m2.parts.map((p) => [p.name, p.group]));
    expect(by).toMatchObject({ base: "Base and power", tray: "Base and power", duct: "Base and power", lip: "Fan unit" });
    // already there: no change
    expect(withGroup(r.src, m2, ["base"], "Base and power").changed).toEqual([]);
  });

  it("set_view shows a group on its own and group_parts makes one; set_view only changes the view", async () => {
    useDesign.setState({ source: SRC, model: evaluate(SRC) });
    useView.setState({ soloGroups: [] });
    const shown = await runViewTool("set_view", { groups: ["fan unit"] });
    expect(shown?.isError).toBeFalsy();
    expect(useView.getState().soloGroups).toEqual(["Fan unit"]);
    const missing = await runViewTool("set_view", { groups: ["Nozzle"] });
    expect(missing?.isError).toBe(true);
    expect(String(missing?.content)).toContain("group_parts");
    expect(QUICK_TOOLS.has("set_view")).toBe(true);
    expect(QUICK_TOOLS.has("group_parts")).toBe(false);
    expect(VIEW_TOOL_DEFS.map((t) => t.name)).toEqual(["set_view", "group_parts"]);
  });

  beforeEach(() => useView.setState({ soloGroups: [] }));
});

describe("plywood", () => {
  it("runs the plies through the thinnest side, an odd number about 1.35 mm each, with the grain along the longest", () => {
    // 300 x 200 x 9 sheet lying flat: 7 plies through Z, grain along X
    const [thin, grain, lo, ply] = plyLayout([-150, -100, 0], [150, 100, 9]);
    expect([thin, grain, lo]).toEqual([2, 0, 0]);
    expect(ply).toBeCloseTo(9 / 7, 6);
    // a 3 mm panel standing on edge in Y: 3 plies, grain up Z
    const s = plyLayout([0, 0, 0], [100, 3, 400]);
    expect([s[0], s[1]]).toEqual([1, 2]);
    expect(s[3]).toBeCloseTo(1, 6);
    expect(plyLayout([0, 0, 0], [50, 50, 18])[3]).toBeCloseTo(18 / 13, 6);
  });
});

describe("printed LiPo labels", () => {
  it("reads the brand, model and ratings from the catalog", () => {
    const t = packText(catalogPart("lipo_4s_1800_xt60")!);
    expect(t).toMatchObject({ brand: "CNHL", model: "Ministar", mah: 1800, volts: 14.8, cells: 4, c: 120 });
    // a generic pack has no brand to print
    expect(packText(catalogPart("lipo_3s_2200")!).brand).toBe("");
  });
});
