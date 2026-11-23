declare module "obj2gltf" {
  /** Convert an OBJ (with its MTL and textures) to glTF; `binary: true` returns a GLB buffer. */
  export default function obj2gltf(path: string, options?: { binary?: boolean }): Promise<Uint8Array>;
}
