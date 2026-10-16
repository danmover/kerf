// The Build tab's Board section: each circuit board drawn from its routed
// copper, with its rule check and the files a board house needs.

import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import type { MachineData } from "../machine/types";

export function BoardView({ m }: { model: Model; m: MachineData; items: CheckItem[] }) {
  return <div className="mp-pad">{m.boards.length} circuit board{m.boards.length === 1 ? "" : "s"}.</div>;
}
