import { describe, expect, it } from "vitest";
import { applyBriefInput } from "../src/ai/tools";
import { briefData, protectedBriefChanges, serializeBrief } from "../src/core/brief";
import { evaluate } from "../src/lang/evaluator";

const base = briefData(
  evaluate(`design "x"
brief {
  purpose: "Hold a tube"
  material: "PETG" assumed
  use hold "Holds the tube" { load: 20N, dir: -Z }
  given tube_d = 25mm "Tube diameter"
}
`).brief,
)!;

describe("update_brief", () => {
  it("merges fields, uses and givens and marks what Claude assumed", () => {
    const { data, errors } = applyBriefInput(base, {
      summary: "s",
      fields: { setting: "Garage wall", temp: [-5, 35], process: "FDM print" },
      assumed_fields: ["temp"],
      uses: [
        { id: "hold", load_n: 30 },
        { id: "mount", text: "Screws to the wall", assumed: true },
      ],
      givens: [{ name: "wall_t", value: "18", description: "Plywood thickness", assumed: true }],
    });
    expect(errors).toEqual([]);
    expect(data.setting).toBe("Garage wall");
    expect([...data.assumed].sort()).toEqual(["material", "temp"]);
    expect(data.uses.find((u) => u.id === "hold")).toMatchObject({ text: "Holds the tube", load: 30, dir: [0, 0, -1], assumed: false });
    expect(data.uses.find((u) => u.id === "mount")?.assumed).toBe(true);
    expect(data.givens.map((g) => g.name)).toEqual(["tube_d", "wall_t"]);
    // the written brief reads back the same
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
    expect(plain(briefData(evaluate(`design "x"\n${serializeBrief(data)}\n`).brief))).toEqual(plain(data));
  });

  it("reports bad input instead of guessing", () => {
    const { errors } = applyBriefInput(base, {
      summary: "s",
      fields: { temp: [40, 0] },
      clear_fields: ["colour"],
      uses: [{ id: "2fast" }, { id: "fresh" }],
      givens: [{ name: "gap", value: "1 }" }],
      references: [{ id: "web", title: "Spec", url: "ftp://x" }],
    });
    expect(errors).toEqual([
      "fields.temp: give the lowest temperature first",
      'clear_fields: there is no field "colour"',
      'uses: "2fast" is not a valid id (letters, digits and _, starting with a letter)',
      'uses: new use "fresh" needs text',
      'givens: the value of "gap" should be one expression such as 25mm',
      'references: the url of "web" should start with https://',
    ]);
  });

  it("knows which edits change what the user stated", () => {
    const { data } = applyBriefInput(base, { summary: "s", fields: { material: "ASA", purpose: "Hold two tubes" }, uses: [{ id: "hold", remove: true }] });
    // the material was Claude's assumption, so only the purpose and the use are protected
    expect(protectedBriefChanges(base, data)).toEqual(["the purpose (“Hold a tube”)", "use hold (“Holds the tube”)"]);
  });
});
