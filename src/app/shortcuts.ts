// The command a key press runs in the workspace, with the keys the user moved (see app/keymap).

import { bindingOf, commandFor } from "./keymap";
import { useSettings } from "./settings";

export const commandOf = (e: KeyboardEvent): string | null => commandFor(bindingOf(e), useSettings.getState().keys);

export const isCommand = (e: KeyboardEvent, id: string): boolean => commandOf(e) === id;
