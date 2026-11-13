// Moving shortcut keys: what a key press is called, which command it runs,
// giving a command a key another had, the other CAD programs' view keys, and
// the mouse schemes' buttons.

import { describe, expect, it } from "vitest";
import { KEY_COMMANDS, bindKey, bindingOf, cleanKeys, commandFor, keyCaps, presetKeys, presetOf, validBinding } from "../src/app/keymap";
import { MOUSE_SCHEMES, sketchButtons } from "../src/app/mouse";

const press = (key: string, code: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
  bindingOf({ key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("key presses", () => {
  it("names a press the way bindings are written", () => {
    expect(press("f", "KeyF")).toBe("f");
    expect(press("G", "KeyG", { shiftKey: true })).toBe("shift+g");
    // digits by position, whatever Shift types there on this layout
    expect(press("@", "Digit2", { shiftKey: true })).toBe("shift+2");
    expect(press('"', "Digit2", { shiftKey: true })).toBe("shift+2");
    expect(press("1", "Numpad1")).toBe("1");
    // a symbol that needs Shift is the symbol
    expect(press("?", "Slash", { shiftKey: true })).toBe("?");
    expect(press(" ", "Space")).toBe("space");
    expect(press("1", "Digit1", { ctrlKey: true })).toBe("mod+1");
    expect(press("1", "Digit1", { metaKey: true })).toBe("mod+1");
    expect(press("Z", "KeyZ", { ctrlKey: true, shiftKey: true })).toBe("mod+shift+z");
    // Option+G on a Mac types ©; a Russian layout types а for F: both by position
    expect(press("©", "KeyG", { altKey: true })).toBe("alt+g");
    expect(press("а", "KeyF")).toBe("f");
    expect(press("F5", "F5")).toBe("f5");
    expect(press("+", "Equal", { shiftKey: true })).toBe("plus");
    expect(press("Shift", "ShiftLeft", { shiftKey: true })).toBeNull();
  });

  it("runs Kerf's own commands on their own keys", () => {
    expect(commandFor("f")).toBe("fit");
    expect(commandFor("shift+2")).toBe("view.back");
    expect(commandFor("?")).toBe("shortcuts");
    expect(commandFor("space")).toBe("play");
    expect(commandFor("shift+q")).toBe("filter.back");
    expect(commandFor("mod+1")).toBeNull();
    expect(commandFor(null)).toBeNull();
    // no key is on two commands
    const all = KEY_COMMANDS.flatMap((c) => c.keys);
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) expect(validBinding(k)).toBe(true);
  });

  it("takes a key off the command that had it, and puts keys back", () => {
    const { keys, took } = bindKey({}, "measure", "f");
    expect(took).toBe("fit");
    expect(keys).toEqual({ measure: ["f"], fit: [] });
    expect(commandFor("f", keys)).toBe("measure");
    expect(commandFor("r", keys)).toBeNull();
    // back on its own key, measure is no longer moved; fit still has none until it is given one
    const back = bindKey(keys, "measure", "r").keys;
    expect(back).toEqual({ fit: [] });
    expect(bindKey(back, "fit", "f").keys).toEqual({});
    // none at all
    expect(commandFor("x", bindKey({}, "xray", null).keys)).toBeNull();
  });

  it("has SolidWorks' and Onshape's view keys", () => {
    const sw = presetKeys("solidworks");
    expect(commandFor("mod+1", sw)).toBe("view.front");
    expect(commandFor("mod+7", sw)).toBe("view.iso");
    expect(commandFor("2", sw)).toBeNull();
    expect(commandFor("f", sw)).toBe("fit");
    const on = presetKeys("onshape");
    expect(commandFor("shift+1", on)).toBe("view.front");
    expect(commandFor("shift+2", on)).toBe("view.back");
    expect(commandFor("shift+4", on)).toBe("view.right");
    expect(commandFor("shift+5", on)).toBe("view.top");
    // Kerf's shift+3 (left) moved to Onshape's left
    expect(commandFor("shift+3", on)).toBe("view.left");
    expect(presetOf(sw)).toBe("solidworks");
    expect(presetOf(on)).toBe("onshape");
    expect(presetOf({})).toBe("kerf");
    expect(presetOf(bindKey(sw, "fit", "z").keys)).toBeNull();
  });

  it("keeps only sound keys from storage", () => {
    expect(cleanKeys({ fit: ["z"], nosuch: ["k"], xray: ["mod+k", "shift+mod+1", 7, "x"], measure: ["z"] })).toEqual({ fit: ["z"], measure: [] });
    // a key someone moved is off the command it started on
    expect(cleanKeys({ measure: ["f"] })).toEqual({ measure: ["f"], fit: [] });
    expect(cleanKeys("nonsense")).toEqual({});
    expect(validBinding("mod+shift+1")).toBe(true);
    expect(validBinding("shift+mod+1")).toBe(false);
    expect(validBinding("ctrl+1")).toBe(false);
    expect(validBinding("escape")).toBe(false);
    expect(validBinding("f12")).toBe(true);
  });

  it("shows keys as key caps", () => {
    expect(keyCaps("mod+shift+2", false)).toEqual(["Ctrl", "⇧", "2"]);
    expect(keyCaps("mod+1", true)).toEqual(["⌘", "1"]);
    expect(keyCaps("alt+g", true)).toEqual(["⌥", "G"]);
    expect(keyCaps("space", false)).toEqual(["Space"]);
    expect(keyCaps("f5", false)).toEqual(["F5"]);
    expect(keyCaps("plus", false)).toEqual(["+"]);
    expect(keyCaps("?", false)).toEqual(["?"]);
  });
});

describe("mouse schemes", () => {
  it("turns, pans and zooms with the buttons each program uses", () => {
    expect(MOUSE_SCHEMES.kerf).toMatchObject({ left: "rotate", middle: "zoom", right: "pan", leftBox: false });
    expect(MOUSE_SCHEMES.solidworks).toMatchObject({ left: "none", middle: "rotate", leftBox: true });
    expect(MOUSE_SCHEMES.fusion).toMatchObject({ left: "none", middle: "pan", leftBox: true });
    expect(MOUSE_SCHEMES.onshape).toMatchObject({ left: "none", middle: "pan", right: "rotate", leftBox: true });
    // sketching, the left button is the sketch tools'; something else still turns the view
    expect(sketchButtons("kerf")).toEqual({ left: "none", middle: "rotate", right: "pan" });
    expect(sketchButtons("onshape")).toEqual({ left: "none", middle: "pan", right: "rotate" });
    for (const id of Object.keys(MOUSE_SCHEMES) as (keyof typeof MOUSE_SCHEMES)[]) {
      const b = sketchButtons(id);
      expect([b.middle, b.right].some((a) => a === "rotate") || id === "fusion").toBe(true);
    }
  });
});
