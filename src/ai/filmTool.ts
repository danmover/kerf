// make_film: the assistant makes a showcase film of the design, with the
// same film maker the user has (src/film). It picks the sections and their
// captions, or leaves Kerf's defaults written from the design; the film
// renders with the user watching, and the tool returns a sheet of stills
// from it so the assistant can see what it made.

import { z } from "zod";
import { useDesign } from "../core/engine";
import { viewport } from "../app/viewportApi";
import { FilmInput, filmSeconds, filmSize, mergeSpec, SECTIONS, sectionInfo, type FilmSpec } from "../film/spec";
import { defaultFilm, defaultSection, sectionAvailable } from "../film/facts";
import { gatherFacts } from "../film/gather";
import { planFilm } from "../film/timeline";
import { openFilmMaker, useFilm } from "../film/store";
import { filmBusy, runFilmJob } from "../film/job";
import { FilmPreview } from "../film/render";
import { canEncode } from "../film/encode";
import type { ToolOutcome } from "./tools";

export const FILM_TOOL_DEFS = [
  {
    name: "make_film",
    description:
      "Make a showcase film of the design: an MP4 with captions, chapter labels, number cards and music, rendered in Kerf's studio lighting. Sections (any order, each with seconds and captions): title (name and tagline), reveal (hero orbit), build (every part flies in, in assembly order), explode (comes apart, main parts named), spotlight (close-ups of chosen parts, each named), inside (a section plane sweeps through), motion (the moving parts run), sim (a simulation run played back), airflow (streamlines from an airflow analysis), results (a structural analysis), wiring (cables with covers see-through), firmware (the generated code scrolling), specs (size, mass, parts, cost and checks as number cards), parts (the parts list with prices) and end (the name and a last line). Leave anything out to get Kerf's choice: the default film is about a minute, with captions written from the design. Sections the design has nothing for (no motion, no analysis run) are skipped. With open: true the film maker opens with your choices so the user can change them and render it; otherwise it renders now with the user watching (a minute of film takes a few minutes), the user saves it from the film maker, and the result has stills from each section for you to check.",
    input_schema: {
      type: "object" as const,
      properties: {
        sections: {
          type: "array",
          maxItems: 24,
          description: "The film's sections in order. Omit for Kerf's default film.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: SECTIONS.map((s) => s.kind) },
              seconds: { type: "number", minimum: 1.5, maximum: 30 },
              title: { type: "string", description: "The caption's bold first line (the title card's title; empty for none)." },
              text: { type: "string", description: "The caption's second line (the title card's tagline, the end card's last line)." },
              parts: { type: "array", items: { type: "string" }, maxItems: 6, description: "spotlight: the parts to visit, by name or id, biggest first reads best." },
              axis: { type: "string", enum: ["x", "y", "z"], description: "inside: the axis to cut across (y cuts front to back)." },
              label: { type: "string", description: "sim, airflow, results: which run, by its label." },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        title: { type: "string", description: "The film's title (default the design's name)." },
        tagline: { type: "string", description: "One line under the title (default from the brief's purpose)." },
        aspect: { type: "string", enum: ["16:9", "1:1", "4:5", "9:16"], description: "16:9 for YouTube, LinkedIn and slides; 1:1 or 4:5 for feeds; 9:16 for Reels, Shorts and TikTok." },
        size: { type: "integer", enum: [720, 1080, 1440, 2160], description: "Short side in pixels (default 1080)." },
        fps: { type: "integer", enum: [24, 30, 60] },
        look: { type: "string", enum: ["studio", "showroom", "blueprint", "workshop", "daylight"], description: "The lighting set (default studio: a dark set with softboxes)." },
        accent: { type: "string", description: "Accent colour for captions and highlights, #rrggbb." },
        music: { type: "string", enum: ["drive", "epic", "calm", "off"] },
        captions: { type: "boolean", description: "Captions, labels and number cards (default true)." },
        badge: { type: "string", description: "Top-right badge text (default DESIGNED IN KERF; empty for none)." },
        endLine: { type: "string", description: "The end card's last line." },
        quality: { type: "string", enum: ["draft", "good", "best"], description: "Samples per frame: draft is quick, best is softest (default good)." },
        motionBlur: { type: "boolean" },
        open: { type: "boolean", description: "Open the film maker with these choices instead of rendering now." },
      },
      additionalProperties: false,
    },
  },
];

export const FILM_TOOL_TITLES: Record<string, string> = { make_film: "Making a film" };

const Input = FilmInput.extend({ open: z.boolean().optional() });

const err = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, detail: content, status: "error" } });

/** A sheet of stills in one JPEG: up to three across, each labelled. */
async function contactSheet(stills: { t: number; data: string; width: number; height: number; label: string }[]): Promise<string | null> {
  if (!stills.length || typeof OffscreenCanvas === "undefined") return null;
  const cols = Math.min(3, stills.length);
  const rows = Math.ceil(stills.length / cols);
  const w = 480;
  const h = Math.round((stills[0].height / stills[0].width) * w);
  const pad = 6;
  const c = new OffscreenCanvas(cols * (w + pad) + pad, rows * (h + pad + 22) + pad);
  const g = c.getContext("2d")!;
  g.fillStyle = "#111";
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < stills.length; i++) {
    const s = stills[i];
    const img = await createImageBitmap(new Blob([Uint8Array.from(atob(s.data), (ch) => ch.charCodeAt(0))], { type: "image/jpeg" }));
    const x = pad + (i % cols) * (w + pad);
    const y = pad + Math.floor(i / cols) * (h + pad + 22);
    g.drawImage(img, x, y + 22, w, h);
    g.fillStyle = "#ddd";
    g.font = "13px sans-serif";
    g.fillText(`${s.label} · ${s.t.toFixed(1)} s`, x + 2, y + 15);
  }
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;

export async function runFilmTool(name: string, input: unknown): Promise<ToolOutcome | null> {
  if (name !== "make_film") return null;
  const p = Input.safeParse(input ?? {});
  if (!p.success) return err(p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), "Invalid tool input");
  const model = useDesign.getState().model;
  if (!model?.parts.length) return err("The design has no parts to film yet.", "Nothing to film");
  const vp = viewport();
  if (!vp) return err("The 3D view isn't open, so the film can't be drawn.", "No 3D view");
  const { open, ...want } = p.data;
  if (open) {
    openFilmMaker(want);
    return { content: "The film maker is open with your choices; the user can change any of it, preview it and render it.", card: { title: "Film maker opened" } };
  }
  if (!canEncode()) return err("This app can't encode video here (no WebCodecs). The desktop app and current Chrome and Edge can.", "Can't encode video");
  if (filmBusy()) return err("A film is already being made; wait for it to finish.", "Film already rendering");
  // the design's own film first, then what was asked for over it
  await FilmPreview.closeAll();
  const look = want.look ?? "studio";
  const probe = vp.film({ width: 64, height: 36, look });
  let facts;
  try {
    facts = gatherFacts(probe.layout(), look);
  } finally {
    probe.end();
  }
  const base = defaultFilm(facts);
  let spec: FilmSpec = mergeSpec(base, want, (k) => defaultSection(k, facts));
  const skipped = spec.sections.filter((s) => sectionAvailable(s.kind, facts));
  spec = { ...spec, sections: spec.sections.filter((s) => !sectionAvailable(s.kind, facts)) };
  // a spotlight on parts the design doesn't have visits its default parts
  spec.sections = spec.sections.map((s) => (s.kind === "spotlight" && s.parts?.length && !s.parts.some((id) => facts.parts.some((x) => x.id === id || x.name === id)) ? { ...s, parts: base.sections.find((b) => b.kind === "spotlight")?.parts } : s));
  if (!spec.sections.length) return err(`None of those sections has anything to show: ${skipped.map((s) => `${s.kind} (${sectionAvailable(s.kind, facts)})`).join("; ")}.`, "Nothing to film");
  const { width, height } = filmSize(spec.aspect, spec.size);
  const plan = planFilm(spec, facts, width / height);
  const stills = plan.shots.slice(0, 9).map((s) => s.start + s.section.seconds * (s.section.kind === "explode" || s.section.kind === "build" ? 0.75 : 0.55));
  const labels = new Map(stills.map((t, i) => [t, sectionInfo(plan.shots[i].section.kind).label]));
  const job = runFilmJob(spec, { byAssistant: true, stills });
  useFilm.setState({ open: true });
  try {
    const r = await job;
    const sheet = await contactSheet(r.stills.map((s) => ({ ...s, label: labels.get(s.t) ?? "" })));
    const lines = [
      `Rendered "${spec.title}": ${mmss(r.seconds)}, ${r.width} × ${r.height} at ${spec.fps} fps, ${r.codecs}, ${(r.blob.size / 1e6).toFixed(1)} MB, in ${mmss(r.ms / 1000)}. It is open in the film maker, where the user can watch it and save it (Save film).`,
      `Sections: ${plan.shots.map((s) => `${sectionInfo(s.section.kind).label} ${s.start.toFixed(1)}–${s.end.toFixed(1)} s${s.section.title ? ` ("${s.section.title}")` : ""}`).join("; ")}.`,
      skipped.length ? `Skipped, with nothing to show: ${skipped.map((s) => `${s.kind} (${sectionAvailable(s.kind, facts)})`).join("; ")}.` : "",
      sheet ? "The sheet shows a still from each section: check the framing and captions, and make it again with changes if something reads badly." : "",
      `Total ${filmSeconds(spec.sections).toFixed(1)} s.`,
    ].filter(Boolean);
    return {
      content: sheet ? [{ type: "text", text: lines.join("\n") }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sheet } }] : lines.join("\n"),
      card: { title: `Film made: ${mmss(r.seconds)}, ${r.width} × ${r.height}`, detail: r.codecs, image: sheet ? `data:image/jpeg;base64,${sheet}` : undefined },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`The film didn't finish: ${msg}`, "Film failed");
  }
}
