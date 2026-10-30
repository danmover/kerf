// The organic plugin: creatures, people and characters as blended, painted
// shapes, with a Meshy-style "Make a creature" panel and a game-ready export.

import type { KerfPlugin } from "../types";
import zephyrFox from "./templates/zephyr-fox.kerf?raw";
import puffling from "./templates/puffling.kerf?raw";
import { organicPromptSection } from "./prompt";

export const organicPlugin: KerfPlugin = {
  id: "organic",
  name: "Creatures and characters",
  description: "Animals, people, pets and other soft shapes: describe one or drop in a reference sheet, pick low-poly, smooth or detailed, and export it with its colours for Roblox, Unity or Godot.",
  templates: [
    {
      id: "zephyr-fox",
      name: "Zephyr Fox",
      tagline: "A chunky low-poly game pet: sky-blue fox with a cloud-swirl tail, painted markings and a blank face for expression decals.",
      source: zephyrFox,
      prompts: [
        "Make the tail swirl bigger and add a second, smaller curl",
        "Turn it into an orange fox with dark brown socks and ear tips",
        "Make a smooth, detailed version with fur for a close-up render",
      ],
      stats: "1 painted body · 2600 triangles · game export",
      category: "characters",
      shows: ["organic", "low-poly", "game export"],
    },
    {
      id: "puffling",
      name: "Puffling",
      tagline: "A round little cloud pet made of exactly five puffs, with stubby pale-blue legs, ready for a game.",
      source: puffling,
      prompts: [
        "Give it a small rainbow on its back, solid and attached",
        "Make a storm-cloud version in dark grey with a yellow lightning bolt painted on the front",
        "Make it smooth and 60 mm tall to 3D print as a figurine",
      ],
      stats: "1 painted body · 2000 triangles · game export",
      category: "characters",
      shows: ["organic", "low-poly"],
    },
  ],
  prompt: organicPromptSection,
  exports: [
    {
      id: "game-model",
      group: "model",
      label: "Game model",
      detail: "Roblox, Unity, Godot: one colour texture, no vertex colours",
      ext: ".glb",
      icon: "Sparkle",
      selection: true,
      run: async (o) => (await import("./exportAction")).exportGameModel(o.selectionOnly),
    },
  ],
};
