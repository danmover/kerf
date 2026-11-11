// Sheet cutting off the main thread: each flat part's profile from its triangles, then the nest and the cut paths.

import { computeSheets, profilesOf, type FlatProfile, type ProfileItem, type SheetRequest, type SheetResult } from "./sheet";

export type SheetWorkerRequest = { id: number; kind: "profiles"; items: ProfileItem[] } | { id: number; kind: "sheets"; req: SheetRequest };
export type SheetWorkerResponse = { id: number; ok: true; result: { key: string; profile: FlatProfile | null }[] | SheetResult } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<SheetWorkerRequest>) => {
  const m = ev.data;
  let msg: SheetWorkerResponse;
  try {
    msg = { id: m.id, ok: true, result: m.kind === "profiles" ? profilesOf(m.items) : computeSheets(m.req) };
  } catch (e) {
    msg = { id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg);
};
