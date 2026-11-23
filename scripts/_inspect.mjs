import { NodeIO } from "@gltf-transform/core";
import { getBounds } from "@gltf-transform/core";
const io = new NodeIO();
for (const f of process.argv.slice(2)) {
  try {
    const doc = await io.read(f);
    const root = doc.getRoot();
    const b = getBounds(root.listScenes()[0]);
    console.log(f.split("/").pop(), "meshes", root.listMeshes().length, "mats", root.listMaterials().map(m => m.getName() + (m.getBaseColorTexture() ? "(tex)" : "")).join(","), "textures", root.listTextures().map(t => t.getURI() || "embedded").join(","), "size", b.max.map((v, i) => (v - b.min[i]).toFixed(2)).join("x"));
  } catch (e) { console.log(f, "ERR", e.message); }
}
