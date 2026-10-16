// What shot blocks mean, for the editor's completions and for Claude: the
// language reference and the art direction that goes with it.

import { ASPECTS, BACKDROPS, KIND_DEFAULTS, MOTIONS, PROPS, SHOT_KINDS, SHOT_PROPS, SURFACES, fStopText } from "./spec";

export const SHOT_DOCS: Record<string, string> = {
  callout: 'callout(lid, "Tool-free twist lock") or callout((0, 12, 30), "M3 inserts") — a label with a leader line to a part or a point, drawn crisply on top of the render.',
  section: 'section("x") or section("y", at: 12mm) — cut the model across an axis (through the middle of the subject unless at: gives the plane\'s position). The half nearer the camera is removed.',
};

const kindLine = (k: (typeof SHOT_KINDS)[number]) => {
  const d = KIND_DEFAULTS[k];
  const bits = [`${d.lens} mm`, fStopText(d.aperture), `angle (${d.angle[0]}deg, ${d.angle[1]}deg)`, `fill ${d.fill}`, d.lighting, d.backdrop === "surface" ? `on ${d.surface}` : d.backdrop];
  if (d.explode) bits.push(`explode ${d.explode}`);
  if (d.section) bits.push("section through the middle");
  if (d.props.length) bits.push(`props ${d.props.join(", ")}`);
  return `- ${k}: ${bits.join(", ")}`;
};

/** The shot block reference for the system prompt. */
export function shotReference(): string {
  return `## Product shots
A shot block is a product photograph or animation of the design, art directed and saved in the design file. Shots re-render after every revision; one that can no longer render as written (a part it names is gone) is flagged. The user sees shots in the Shots view, edits them live (drag to turn the camera, scroll to zoom, a bar for lens, aperture, lighting, set and motion) and exports stills up to 4K with a transparent background, or MP4 and GIF animations.
shot hero {
  title: "Hero"
  kind: "hero"
  angle: (35deg, 18deg)
  lens: 85mm
  aperture: 8
  focus: lid
  fill: 0.72
  offset: (-0.08, 0)
  aspect: "16:9"
  lighting: "showroom"
  light_angle: 30deg
  backdrop: "seamless"
  color: #1d2026
  ghost: [cover]
  props: ["coin"]
  note: "Low three-quarter angle so the lid's chamfer catches the key light"
  callout(lid, "Tool-free twist lock")
}
Properties: ${SHOT_PROPS.join(", ")}. Only kind's defaults apply to what is left out.
- kind: ${SHOT_KINDS.map((k) => `"${k}"`).join(", ")}. Defaults per kind:
${SHOT_KINDS.map(kindLine).join("\n")}
- angle: (turn, height). turn is degrees around from the front (the camera on -Y looking along +Y) toward the right side; height is degrees above the floor. (35deg, 18deg) is a low front-right three-quarter view.
- lens: 35 mm-equivalent focal length, 14–400. Long lenses (85–135) flatten and flatter products; wide ones (24–35) exaggerate depth and suit big machines and interiors. The subject keeps the size fill gives it whatever the lens.
- aperture: f-number, physically based on the real distance and lens: a 50 mm part at 85 mm and f/4 has only a few millimetres in focus. Leave it out (or aperture: false) for everything sharp, as product photographers do with focus stacking. Use a wide aperture on purpose, for a detail shot that isolates one feature with focus: on it.
- focus: a part or a point (x, y, z); default the centre of what is framed.
- frame: parts the camera frames (default everything shown); fill: how much of the frame the subject fills on its tighter axis (0.15–1); offset: (across, up) as a fraction of the frame to compose off-centre, e.g. (-0.17, 0) puts the subject on the left third.
- aspect: ${ASPECTS.map((a) => `"${a}"`).join(", ")}.
- lighting: "studio" (neutral softboxes, dark set), "showroom" (bright white cyclorama), "blueprint" (deep blue set, rim lights), "workshop" (warm lamp, cool window), "daylight" (sun and sky, crisp shadows). light_angle turns it (degrees).
- backdrop: ${BACKDROPS.map((b) => `"${b}"`).join(", ")}. studio: the lighting's own set; seamless: a paper sweep in color: (default from the lighting); surface: the product stands on surface: ${SURFACES.map((s) => `"${s}"`).join(", ")}; transparent: only the product and its soft shadow, for a website or a slide.
- explode (0–1), section("x", at: 12mm), hide: and ghost: (part names: ghosted parts are glassy so what is inside shows, hidden ones are gone).
- props: scale objects placed beside the product on the floor: ${Object.entries(PROPS)
    .map(([k, p]) => `"${k}" (${p.size})`)
    .join(", ")}.
- motion: ${MOTIONS.map((m) => `"${m}"`).join(", ")}; duration: seconds. turntable spins the camera all the way around, orbit swings it 40 degrees, push_in moves closer, explode separates the parts and brings them back, assemble flies them in one by one, mechanism runs the gears and joints through a turn, section_sweep slides a cutting plane through.
- note: why the shot looks the way it does. Write the art direction there in a sentence.
- ${SHOT_DOCS.callout}
- ${SHOT_DOCS.section}

### Art direction
When asked for a shot ("make me a hero shot", "something for the website"), act as an art director:
- Decide what the picture must say: the product's best feature, its size, how it goes together, what is inside. Choose the kind from that.
- Choose the angle from the design's shape: a three-quarter view from the side with the most interesting detail; low heights (10–20 degrees) make a product feel substantial, high ones (35–60) explain a layout. Keep the light coming from behind or beside the camera's side so edges catch it (light_angle turns it).
- A long lens for a single product, a shorter one for a large machine. Compose off-centre with offset when there is a callout or empty space to balance.
- Match the set to the brief: seamless for clean marketing, a surface (walnut, oak, concrete, cutting_mat) with props for scale and context, transparent for compositing, blueprint lighting for a technical look.
- Call offer_shots with two or three genuinely different options (different angle, lighting or set, not small tweaks), each with a one-sentence why. Kerf renders them and the user picks one, which is saved in the design. Then look at the saved shot with view_shot.
- view_shot returns the render and measurements: how much of the frame the subject fills, parts cut off at the edges or hidden behind others, depth of field against the subject's depth, clipped highlights and crushed shadows, and how the subject stands out from the background. Judge the image like a photographer: is the subject clear and well lit, is anything important hidden, does the background compete? Improve it with set_shot and look again. Two rounds are usually enough.
- set_shot creates or changes one shot; shots the user locked are theirs.`;
}
