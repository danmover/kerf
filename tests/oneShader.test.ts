// One shader for a part however it is drawn: solid or see-through, cut or whole. The graphics card takes seconds
// over each build of the parts' shader with Direct3D, so a part's material is kept to one way of being drawn
// wherever that draws the same picture (src/ui/viewport/render/partShader.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ALL_IN_ONE, applyAppearance, applyMake, cutsOf, NO_CUT, partUniforms, patchPartMaterial, setSeeThrough } from "../src/ui/viewport/render/partShader";
import { appearanceFor, Make } from "../src/ui/viewport/render/appearance";

/** whether the renderer takes its shader for a solid material, as three.js r169 decides it (see the last test) */
const solidShader = (m: THREE.Material) => m.transparent === false && m.blending === THREE.NormalBlending && m.alphaToCoverage === false;

describe("a part's material, solid or see-through", () => {
  it("is drawn with the see-through shader also while it is solid, and blends nothing then", () => {
    const m = new THREE.MeshPhysicalMaterial();
    setSeeThrough(m, false);
    expect(m.transparent).toBe(false);
    expect(solidShader(m)).toBe(false);
    // nothing is blended, and what is written is all of the part
    expect(m.blending).toBe(THREE.NoBlending);
    expect(m.opacity).toBe(1);
  });

  it("turns see-through and solid again with no other shader to build", () => {
    const m = new THREE.MeshPhysicalMaterial();
    setSeeThrough(m, false);
    const made = m.version;
    m.opacity = 0.2;
    setSeeThrough(m, true);
    expect(m.transparent).toBe(true);
    expect(m.blending).toBe(THREE.NormalBlending);
    expect(m.opacity).toBe(0.2);
    expect(solidShader(m)).toBe(false);
    m.opacity = 0.9995;
    setSeeThrough(m, false);
    expect(m.blending).toBe(THREE.NoBlending);
    expect(m.opacity).toBe(1);
    expect(solidShader(m)).toBe(false);
    // never marked as needing another shader
    expect(m.version).toBe(made);
  });

  it("marks a material drawn before it came here, once", () => {
    const m = new THREE.MeshPhysicalMaterial();
    const made = m.version;
    setSeeThrough(m, false);
    expect(m.version).toBe(made + 1);
    setSeeThrough(m, false);
    setSeeThrough(m, true);
    expect(m.version).toBe(made + 1);
  });

  it("leaves a material with a picture on it a shader for each, as before", () => {
    const m = new THREE.MeshPhysicalMaterial({ map: new THREE.Texture() });
    const made = m.version;
    setSeeThrough(m, false);
    // (a map may have see-through places of its own, which a solid material covers)
    expect(m.blending).toBe(THREE.NormalBlending);
    expect(solidShader(m)).toBe(true);
    expect(m.version).toBe(made);
    setSeeThrough(m, true);
    expect(solidShader(m)).toBe(false);
    expect(m.version).toBe(made + 1);
    setSeeThrough(m, false);
    expect(m.version).toBe(made + 2);
  });

  it("leaves a material that blends some other way to blend that way", () => {
    const m = new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true });
    setSeeThrough(m, true);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    setSeeThrough(m, false);
    expect(m.blending).toBe(THREE.AdditiveBlending);
  });
});

describe("a part's cutting planes", () => {
  const section = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);
  const reveal = new THREE.Plane(new THREE.Vector3(0, 0, -1), 12);

  it("are always two, with one that cuts nothing where there is none", () => {
    expect(cutsOf(null, null)).toEqual([NO_CUT, NO_CUT]);
    expect(cutsOf(section, null)).toEqual([section, NO_CUT]);
    expect(cutsOf(null, reveal)).toEqual([NO_CUT, reveal]);
    expect(cutsOf(section, reveal)).toEqual([section, reveal]);
  });

  it("are put into the list the material has, so the material is not made anew", () => {
    const planes = cutsOf(null, null);
    expect(cutsOf(section, null, planes)).toBe(planes);
    expect(planes).toEqual([section, NO_CUT]);
    expect(cutsOf(null, null, planes)).toBe(planes);
    expect(planes).toEqual([NO_CUT, NO_CUT]);
    // a list of another length is not used
    expect(cutsOf(section, null, [section])).not.toBe(planes);
    expect(cutsOf(section, null, null).length).toBe(2);
  });

  it("the plane that stands for none keeps everything a design can hold", () => {
    for (const p of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1e5, -1e5, -1e6), new THREE.Vector3(-3e4, 2e4, 1e6)]) expect(NO_CUT.distanceToPoint(p)).toBeGreaterThan(0);
  });
});

describe("one shader for parts of every finish", () => {
  // the finishes of bench/designs/finishes.kerf: every mix of clear coat, sheen and grain there is among them
  const finishes: [string, string | undefined][] = [
    ["PLA", undefined],
    ["ABS", "matte"],
    ["ABS", "textured"],
    ["ABS", "gloss"],
    ["Aluminum 6061", "machined"],
    ["Aluminum 6061", "brushed"],
    ["Aluminum 6061", "anodized"],
    ["Aluminum 6061", "bead-blasted"],
    ["Stainless 304", "machined"],
    ["Steel", "black-oxide"],
    ["Carbon fiber", "gloss"],
    ["Wood", "varnished"],
    ["Wood", "raw"],
    ["Polyurethane", undefined],
    ["Silicone", undefined],
  ];
  /** what of a material the renderer picks its shader by, as three.js r169 does (see the last tests) */
  const layers = (m: THREE.MeshPhysicalMaterial) => [m.clearcoat > 0, m.sheen > 0, m.anisotropy > 0, m.iridescence > 0, m.transmission > 0].join();
  const made = (material: string, finish: string | undefined, make = Make.None) => {
    const look = appearanceFor(material, finish, "#8090a0");
    const mat = new THREE.MeshPhysicalMaterial();
    const u = partUniforms();
    applyAppearance(mat, u, look);
    applyMake(mat, u, look, make, 0, null);
    return { mat, look };
  };

  it("is on unless turned off", () => {
    expect(ALL_IN_ONE).toBe(true);
  });

  it("gives every finish a clear coat, a sheen and a grain, so the renderer picks one shader for all of them", () => {
    const mixes = new Set(finishes.map(([m, f]) => layers(made(m, f).mat)));
    expect([...mixes]).toEqual(["true,true,true,false,false"]);
    // without it these finishes are of several mixes: that many builds of the parts' shader
    expect(new Set(finishes.map(([m, f]) => `${appearanceFor(m, f, "#8090a0").clearcoat > 0},${appearanceFor(m, f, "#8090a0").sheen > 0},${appearanceFor(m, f, "#8090a0").aniso > 0}`)).size).toBeGreaterThan(2);
  });

  it("keeps a layer a finish has as it is, and gives one it has not the least there is, as rough as it goes", () => {
    for (const [m, f] of finishes) {
      const { mat, look } = made(m, f);
      if (look.clearcoat > 0) expect([mat.clearcoat, mat.clearcoatRoughness]).toEqual([look.clearcoat, look.clearcoatRoughness]);
      else expect([mat.clearcoat, mat.clearcoatRoughness]).toEqual([1e-6, 1]);
      if (look.sheen > 0) expect([mat.sheen, mat.sheenRoughness]).toEqual([look.sheen, look.sheenRoughness]);
      else expect([mat.sheen, mat.sheenRoughness]).toEqual([1e-6, 1]);
      expect(mat.anisotropy).toBe(look.aniso > 0 ? look.aniso : 1e-6);
    }
  });

  it("a turned part's grain is the turning's, whatever its finish", () => {
    expect(made("ABS", "matte", Make.Turned).mat.anisotropy).toBe(0.55);
    expect(made("ABS", "matte").mat.anisotropy).toBe(1e-6);
  });
});

describe("a finish with a grain in its shader and none to show", () => {
  const fragment = () => {
    const mat = new THREE.MeshPhysicalMaterial();
    patchPartMaterial(mat, partUniforms());
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    return shader.fragmentShader.replace(/\s+/g, " ");
  };

  it("has its highlights worked out as a plain finish's are", () => {
    const f = fragment();
    expect(f).not.toContain("#include <lights_physical_pars_fragment>");
    expect(f).toMatch(/float V = material\.anisotropy > 1e-5 \? V_GGX_SmithCorrelated_Anisotropic\( [^;]* \) : V_GGX_SmithCorrelated\( alpha, dotNL, dotNV \);/);
    expect(f).toMatch(/float D = material\.anisotropy > 1e-5 \? D_GGX_Anisotropic\( [^;]* \) : D_GGX\( alpha, dotNH \);/);
    // the plain finish's own lines are as three.js has them
    expect(f).toContain("#else float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV ); float D = D_GGX( alpha, dotNH ); #endif");
  });

  it("for the reason that three.js keeps a grained highlight's visibility to 1 at most, and a plain one's not", () => {
    const pars = THREE.ShaderChunk.lights_physical_pars_fragment.replace(/\s+/g, " ");
    expect(pars).toMatch(/float V_GGX_SmithCorrelated_Anisotropic\([^{]*\) \{[^}]*return saturate\(v\); \}/);
    expect(pars).toMatch(/float V_GGX_SmithCorrelated\([^{]*\) \{[^}]*return 0\.5 \/ max\( gv \+ gl, EPSILON \); \}/);
  });
});

describe("what this rests on in the renderer (three.js r169)", () => {
  const programs = readFileSync(new URL("../node_modules/three/src/renderers/webgl/WebGLPrograms.js", import.meta.url), "utf8");
  const state = readFileSync(new URL("../node_modules/three/src/renderers/webgl/WebGLState.js", import.meta.url), "utf8");
  const opaque = readFileSync(new URL("../node_modules/three/src/renderers/shaders/ShaderChunk/opaque_fragment.glsl.js", import.meta.url), "utf8");

  it("takes the solid shader only for a material that is not see-through and blends the usual way", () => {
    expect(programs).toContain("opaque: material.transparent === false && material.blending === NormalBlending && material.alphaToCoverage === false");
  });

  it("the solid shader differs from the other by writing an alpha of 1", () => {
    expect(opaque.replace(/\s+/g, " ")).toContain("#ifdef OPAQUE diffuseColor.a = 1.0; #endif");
  });

  it("blends nothing for a material told not to blend", () => {
    expect(state.replace(/\s+/g, " ")).toContain("if ( blending === NoBlending ) { if ( currentBlendingEnabled === true ) { disable( gl.BLEND ); currentBlendingEnabled = false; } return; }");
  });

  it("builds a shader by how many planes cut a material, not by which", () => {
    expect(programs).toContain("numClippingPlanes: clipping.numPlanes");
  });

  it("picks a shader with a clear coat, a sheen or a grain by whether the material has any at all", () => {
    expect(programs).toContain("const HAS_ANISOTROPY = material.anisotropy > 0;");
    expect(programs).toContain("const HAS_CLEARCOAT = material.clearcoat > 0;");
    expect(programs).toContain("const HAS_SHEEN = material.sheen > 0;");
  });
});
