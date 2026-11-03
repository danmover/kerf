// The organic plugin: creatures, people and characters as blended, painted
// shapes, with a Meshy-style "Make a creature" panel and a game-ready export.

import type { KerfPlugin } from "../types";
import fox from "./templates/fox.kerf?raw";
import cloudSheep from "./templates/cloud-sheep.kerf?raw";
import { organicPromptSection } from "./prompt";

export const organicPlugin: KerfPlugin = {
  id: "organic",
  name: "Creatures and characters",
  description: "Animals, people, pets and other soft shapes: describe one or drop in a reference sheet, pick smooth, low-poly or detailed, and export it with its colours for Roblox, Unity or Godot.",
  templates: [
    {
      id: "fox",
      name: "Fox",
      tagline: "A smooth stylised game pet built to match its reference sheet: cheek ruffs, a bushy tail, dark boots and a blank face for expression decals.",
      source: fox,
      prompts: [
        "Make it a sky-blue Zephyr Fox whose tail ends in a white cloud swirl",
        "Give it big glossy eyes and a small smile for a render",
        "Make a detailed version with fur for a close-up",
      ],
      stats: "1 painted body · 16k triangles · game export",
      category: "characters",
      shows: ["organic", "smooth", "game export"],
    },
    {
      id: "cloud-sheep",
      name: "Cloud Sheep",
      tagline: "A woolly game pet from its reference sheet: a coat of round puffs, curled lavender horns and a star on its forehead.",
      source: cloudSheep,
      prompts: [
        "Make the horns curl one more turn and add a rainbow star",
        "Turn it into a storm sheep: dark grey wool with a yellow lightning bolt",
        "Make it 60 mm tall to 3D print as a figurine",
      ],
      stats: "1 painted body · 18k triangles · game export",
      category: "characters",
      shows: ["organic", "smooth"],
    },
  ],
  prompt: organicPromptSection,
  exports: [
    {
      id: "game-model",
      group: "model",
      label: "Game model",
      detail: "Roblox, Unity, Godot: colours and shading baked into one texture",
      ext: ".glb",
      icon: "Sparkle",
      selection: true,
      run: async (o) => (await import("./exportAction")).exportGameModel(o.selectionOnly),
    },
  ],
};
