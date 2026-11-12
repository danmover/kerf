// What a showcase film holds: its sections in order (each one a shot with
// its captions), how it looks and sounds, and the file it makes. The film
// maker dialog edits one of these, the assistant's make_film tool writes one,
// and src/film/timeline.ts turns it into the camera moves and graphics of
// every frame.

import { z } from "zod";

export type SectionKind =
  | "title"
  | "reveal"
  | "build"
  | "explode"
  | "inside"
  | "motion"
  | "sim"
  | "airflow"
  | "results"
  | "wiring"
  | "spotlight"
  | "firmware"
  | "specs"
  | "parts"
  | "end";

export type Axis = "x" | "y" | "z";

export interface FilmSection {
  kind: SectionKind;
  /** seconds on screen, crossfades included */
  seconds: number;
  /** the caption's first, bold line (or the title card's title); empty for none */
  title?: string;
  /** the caption's second line */
  text?: string;
  /** spotlight: the parts visited, by id or block name */
  parts?: string[];
  /** inside: the axis cut across */
  axis?: Axis;
  /** sim, airflow, results: which run, by its label */
  label?: string;
}

export type FilmAspect = "16:9" | "1:1" | "4:5" | "9:16";
export type FilmLook = "studio" | "showroom" | "blueprint" | "workshop" | "daylight";
export type FilmMusic = "drive" | "calm" | "epic" | "off";
export type FilmQuality = "draft" | "good" | "best";

export interface FilmSpec {
  title: string;
  tagline: string;
  sections: FilmSection[];
  aspect: FilmAspect;
  /** the short side in pixels: 720, 1080, 1440 or 2160 */
  size: 720 | 1080 | 1440 | 2160;
  fps: 24 | 30 | 60;
  look: FilmLook;
  /** captions, lines and highlights, as #rrggbb */
  accent: string;
  music: FilmMusic;
  /** captions, chapter labels and number cards on (off: pictures only) */
  captions: boolean;
  /** top-right badge, e.g. DESIGNED IN KERF; empty for none */
  badge: string;
  /** last line on the end card */
  endLine: string;
  quality: FilmQuality;
  /** blur what moves fast, like a real camera's shutter */
  motionBlur: boolean;
}

export interface SectionInfo {
  kind: SectionKind;
  label: string;
  /** what it shows, for the picker */
  detail: string;
  /** small caps label shown top left while it plays */
  chapter: string;
  seconds: number;
  /** lowest and highest seconds the picker offers */
  min: number;
  max: number;
}

export const SECTIONS: SectionInfo[] = [
  { kind: "title", label: "Title", detail: "The name and tagline over a slow push in", chapter: "", seconds: 4, min: 2, max: 8 },
  { kind: "reveal", label: "Reveal", detail: "A hero orbit round the whole design", chapter: "The design", seconds: 6, min: 3, max: 14 },
  { kind: "build", label: "Assembly", detail: "Every part flies in, in the order it goes together", chapter: "Assembly", seconds: 7, min: 3, max: 16 },
  { kind: "explode", label: "Exploded view", detail: "It comes apart, with the main parts named", chapter: "Exploded", seconds: 6, min: 3, max: 14 },
  { kind: "inside", label: "Inside", detail: "A section plane sweeps through it", chapter: "Section", seconds: 5, min: 3, max: 12 },
  { kind: "motion", label: "Motion", detail: "The moving parts run", chapter: "Motion", seconds: 6, min: 3, max: 16 },
  { kind: "sim", label: "Simulation", detail: "A simulation run played back", chapter: "Simulation", seconds: 8, min: 3, max: 20 },
  { kind: "airflow", label: "Airflow", detail: "Streamlines and pressure from an airflow analysis", chapter: "Airflow", seconds: 6, min: 3, max: 14 },
  { kind: "results", label: "Strength", detail: "Stress or safety factor from a structural analysis", chapter: "Strength", seconds: 5, min: 3, max: 12 },
  { kind: "wiring", label: "Wiring", detail: "The cables, with covers see-through", chapter: "Wiring", seconds: 6, min: 3, max: 14 },
  { kind: "spotlight", label: "Details", detail: "Close-ups of chosen parts, each one named", chapter: "Details", seconds: 8, min: 3, max: 20 },
  { kind: "firmware", label: "Firmware", detail: "The generated code scrolling past", chapter: "Firmware", seconds: 5, min: 3, max: 12 },
  { kind: "specs", label: "By the numbers", detail: "Size, mass, parts, cost and checks as number cards", chapter: "Specs", seconds: 5, min: 3, max: 12 },
  { kind: "parts", label: "Parts and cost", detail: "The parts list with prices and the total", chapter: "Parts", seconds: 6, min: 3, max: 14 },
  { kind: "end", label: "End card", detail: "The name and your last line", chapter: "", seconds: 4, min: 2, max: 8 },
];

export const sectionInfo = (k: SectionKind): SectionInfo => SECTIONS.find((s) => s.kind === k)!;

/** Pixel size of the film for an aspect and short side, rounded to even numbers (video encoders need them). */
export function filmSize(aspect: FilmAspect, short: number): { width: number; height: number } {
  const [a, b] = aspect.split(":").map(Number);
  const even = (n: number) => Math.round(n / 2) * 2;
  return a >= b ? { width: even((short * a) / b), height: short } : { width: short, height: even((short * b) / a) };
}

/** Samples drawn for each frame: more gives softer shadows and cleaner edges. */
export const QUALITY_SAMPLES: Record<FilmQuality, number> = { draft: 2, good: 8, best: 24 };

export const LOOKS: { id: FilmLook; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "showroom", label: "Showroom" },
  { id: "blueprint", label: "Blueprint" },
  { id: "workshop", label: "Workshop" },
  { id: "daylight", label: "Daylight" },
];

export const MUSIC: { id: FilmMusic; label: string; detail: string }[] = [
  { id: "drive", label: "Drive", detail: "Upbeat pulse, builds through the film" },
  { id: "epic", label: "Epic", detail: "Slow, wide and dramatic" },
  { id: "calm", label: "Calm", detail: "Soft pads, no drums" },
  { id: "off", label: "No sound", detail: "A silent film" },
];

export const ASPECTS: { id: FilmAspect; label: string; detail: string }[] = [
  { id: "16:9", label: "Wide 16:9", detail: "YouTube, LinkedIn, slides" },
  { id: "1:1", label: "Square 1:1", detail: "Feeds" },
  { id: "4:5", label: "Portrait 4:5", detail: "Instagram, LinkedIn feed" },
  { id: "9:16", label: "Vertical 9:16", detail: "Reels, Shorts, TikTok" },
];

/** Total running time: each section after the first starts as the one before fades out. */
export const CROSSFADE = 0.5;
export function filmSeconds(sections: FilmSection[]): number {
  if (!sections.length) return 0;
  return sections.reduce((s, x) => s + x.seconds, 0) - CROSSFADE * (sections.length - 1);
}

export const MAX_FILM_SECONDS = 180;

const Kind = z.enum(SECTIONS.map((s) => s.kind) as [SectionKind, ...SectionKind[]]);

export const SectionInput = z.object({
  kind: Kind,
  seconds: z.number().min(1.5).max(30).optional(),
  title: z.string().max(90).optional(),
  text: z.string().max(140).optional(),
  parts: z.array(z.string().min(1).max(120)).max(6).optional(),
  axis: z.enum(["x", "y", "z"]).optional(),
  label: z.string().max(120).optional(),
});

export const FilmInput = z.object({
  title: z.string().max(70).optional(),
  tagline: z.string().max(120).optional(),
  sections: z.array(SectionInput).min(1).max(24).optional(),
  aspect: z.enum(["16:9", "1:1", "4:5", "9:16"]).optional(),
  size: z.union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).optional(),
  look: z.enum(["studio", "showroom", "blueprint", "workshop", "daylight"]).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  music: z.enum(["drive", "calm", "epic", "off"]).optional(),
  captions: z.boolean().optional(),
  badge: z.string().max(40).optional(),
  endLine: z.string().max(90).optional(),
  quality: z.enum(["draft", "good", "best"]).optional(),
  motionBlur: z.boolean().optional(),
});
export type FilmInputT = z.infer<typeof FilmInput>;

/**
 * Fill a partial film (from the assistant or a saved one) over a default one:
 * sections given replace the default's, each filled from the default's section
 * of that kind, or from `fallback` for a kind the default leaves out.
 */
export function mergeSpec(base: FilmSpec, input: FilmInputT, fallback?: (k: SectionKind) => FilmSection): FilmSpec {
  const sections = input.sections
    ? input.sections.map((s) => {
        const d = base.sections.find((b) => b.kind === s.kind) ?? fallback?.(s.kind);
        const info = sectionInfo(s.kind);
        const seconds = Math.min(info.max, Math.max(info.min, s.seconds ?? d?.seconds ?? info.seconds));
        return { ...d, ...stripUndefined(s), kind: s.kind, seconds };
      })
    : base.sections;
  return { ...base, ...stripUndefined({ ...input, sections: undefined }), sections };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const DEFAULT_ACCENT = "#ff7a1a";
