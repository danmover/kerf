// The Export menu's "Game model": the visible (or selected) parts as one .glb
// with its colours and shading baked into one texture.

import { baseName, placedMeshes, suffix } from "../../app/exports";
import { download, safeFileName } from "../../persist/files";
import { toast } from "../../app/ui";
import { xformMatrix } from "../../kernel/recipe";
import { gameGlb, gameModel, ROBLOX_MAX_TRIS } from "./gameExport";

export async function exportGameModel(selectionOnly = false) {
  const items = await placedMeshes(selectionOnly);
  if (!items) return;
  const model = gameModel(items.map(({ part, mesh }) => ({ name: part.id, matrix: xformMatrix(part.xf), mesh, color: part.color, painted: !!part.painted })));
  const data = await gameGlb(model, baseName());
  download(data, safeFileName(baseName() + suffix(selectionOnly), "glb"), "model/gltf-binary");
  const big = model.meshes.filter((m) => m.indices.length / 3 > ROBLOX_MAX_TRIS).map((m) => m.name);
  toast({
    kind: big.length ? "warn" : "success",
    title: "Game model exported",
    detail: big.length
      ? `${big.join(", ")} ${big.length > 1 ? "have" : "has"} more than Roblox's ${ROBLOX_MAX_TRIS} triangles per mesh: lower tris: in organic.model() before importing there.`
      : `${model.meshes.length} mesh${model.meshes.length > 1 ? "es" : ""}, ${model.triangles} triangles, colours baked into one ${model.size} px texture. Metres, Y up, facing +Z.`,
  });
}
