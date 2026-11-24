/**
 * Download the free CC0 environment packs (from the Worlds_Edge_Free_3D_Environment_Packs
 * guide) into .asset-cache/<pack>/. Raw downloads stay out of git; `npm run build-env`
 * then picks the models we use and writes compact GLBs into the client.
 *
 *   npx tsx scripts/fetch-assets.ts            # all packs
 *   npx tsx scripts/fetch-assets.ts kenney-nature-kit
 *
 * Sources: Kenney (signed link from the "continue without donating" endpoint),
 * KayKit (official GitHub repositories) and Quaternius (public Google Drive
 * folders). itch.io-only packs (the other KayKit packs, Quaternius MegaKits) need
 * a manual browser download: put the extracted folder in .asset-cache/<pack>/
 * and the build step will find it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE = join(process.cwd(), ".asset-cache");
const UA = "Mozilla/5.0 (asset fetch for a CC0 pack)";

type Pack =
  | { id: string; kind: "kenney"; slug: string }
  | { id: string; kind: "github"; repo: string; branch: string }
  | { id: string; kind: "drive"; folder: string; /** Subfolder with models, in order of preference. */ formats: string[] };

export const PACKS: Pack[] = [
  { id: "kenney-castle-kit", kind: "kenney", slug: "castle-kit" },
  { id: "kenney-nature-kit", kind: "kenney", slug: "nature-kit" },
  { id: "kenney-pirate-kit", kind: "kenney", slug: "pirate-kit" },
  { id: "kenney-watercraft-kit", kind: "kenney", slug: "watercraft-kit" },
  { id: "kenney-modular-cave-kit", kind: "kenney", slug: "modular-cave-kit" },
  { id: "kenney-modular-dungeon-kit", kind: "kenney", slug: "modular-dungeon-kit" },
  // KayKit publishes the free editions of these on GitHub as well as itch.io.
  { id: "kaykit-medieval-hexagon", kind: "github", repo: "KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0", branch: "main" },
  { id: "kaykit-dungeon", kind: "github", repo: "KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0", branch: "main" },
  { id: "quaternius-medieval-village", kind: "drive", folder: "18T92VcNldHG0ugWo1u0hSJGDLua-n7o5", formats: ["glTF", "OBJ"] },
  { id: "quaternius-modular-medieval-buildings", kind: "drive", folder: "1WCmnrS1fYQLYfRwztVErgAOyWXdJiVIo", formats: ["glTF", "OBJ"] },
  { id: "quaternius-ultimate-nature", kind: "drive", folder: "1-Kl0L_Jg8awbh0S5T-z3zxh4mVlnxTpa", formats: ["glTF", "OBJ"] },
  { id: "quaternius-ultimate-stylized-nature", kind: "drive", folder: "1IV3bXHzkNvuNWFHPi4KPx-G4ghuxIuT-", formats: ["glTF", "OBJ"] },
  { id: "quaternius-survival", kind: "drive", folder: "1NKfC95GMWWJquy6rRzwFVkVDoZ_QP7K_", formats: ["glTF", "OBJ"] },
  { id: "quaternius-ships", kind: "drive", folder: "1Qf31QTnGfxRzYxx8dHmlVGDT4KmIa0Vy", formats: ["glTF", "OBJ"] },
  { id: "quaternius-pirate-kit", kind: "drive", folder: "1KjMzhVsDcyvYMWeVjZcRfuu8auBLpNi2", formats: ["glTF", "OBJ"] },
  { id: "quaternius-ultimate-modular-ruins", kind: "drive", folder: "1ETp2ldaHaP0BkS4FBmkT-g9Yf88T_cIX", formats: ["glTF", "OBJ"] },
];

async function get(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

async function download(url: string, file: string, init: RequestInit = {}) {
  const res = await get(url, init);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function fetchKenney(slug: string, dir: string) {
  const page = await get(`https://kenney.nl/assets/${slug}`);
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const id = Buffer.from(`assets/${slug}`).toString("hex");
  const link = await (await get(`https://kenney.nl/download-link/${id}`, { headers: { Cookie: cookie, Referer: `https://kenney.nl/assets/${slug}` } })).json() as { url?: string };
  if (!link.url) throw new Error(`no download link for ${slug}`);
  const zip = join(CACHE, `${slug}.zip`);
  await download(link.url, zip);
  execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
}

async function fetchGithub(repo: string, branch: string, dir: string) {
  const zip = join(CACHE, `${repo.split("/")[1]}.zip`);
  await download(`https://codeload.github.com/${repo}/zip/refs/heads/${branch}`, zip);
  execFileSync("unzip", ["-q", "-o", zip, "-d", dir]);
}

interface DriveEntry { id: string; name: string; folder: boolean }

async function listDrive(folder: string): Promise<DriveEntry[]> {
  const html = await (await get(`https://drive.google.com/embeddedfolderview?id=${folder}`)).text();
  const out: DriveEntry[] = [];
  const re = /href="https:\/\/drive\.google\.com\/(file\/d|drive\/folders)\/([A-Za-z0-9_-]+)[^"]*"[\s\S]*?<div class="flip-entry-title">([^<]+)/g;
  for (let m; (m = re.exec(html));) out.push({ id: m[2], name: m[3].trim(), folder: m[1] !== "file/d" });
  return out;
}

async function downloadDriveFile(id: string, file: string) {
  const res = await get(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
  const body = Buffer.from(await res.arrayBuffer());
  // Popular shared files hit Google's daily download quota; Drive then returns an HTML page.
  if (body.subarray(0, 200).toString("latin1").includes("<!DOCTYPE html")) {
    const quota = body.toString("latin1").includes("Quota exceeded");
    throw new Error(quota ? "Google Drive download quota exceeded for this pack — try again tomorrow" : `Drive returned a web page instead of ${file}`);
  }
  writeFileSync(file, body);
}

async function fetchDriveTree(folder: string, dir: string, depth = 0) {
  mkdirSync(dir, { recursive: true });
  for (const e of await listDrive(folder)) {
    const target = join(dir, e.name);
    if (e.folder) { if (depth < 4) await fetchDriveTree(e.id, target, depth + 1); }
    else if (!existsSync(target)) await downloadDriveFile(e.id, target);
  }
}

async function fetchDrive(folder: string, formats: string[], dir: string) {
  const top = await listDrive(folder);
  // License and the preferred model format (plus shared textures).
  for (const e of top) if (!e.folder && /license/i.test(e.name)) await downloadDriveFile(e.id, join(dir, e.name));
  const format = formats.map((f) => top.find((e) => e.folder && e.name.toLowerCase() === f.toLowerCase())).find(Boolean);
  const nested = format ? [format] : top.filter((e) => e.folder); // e.g. Buildings/ Props/ each with formats inside
  for (const f of nested) {
    if (format) { await fetchDriveTree(f.id, join(dir, f.name)); continue; }
    const inner = await listDrive(f.id);
    const pick = formats.map((fmt) => inner.find((e) => e.folder && e.name.toLowerCase() === fmt.toLowerCase())).find(Boolean);
    if (pick) await fetchDriveTree(pick.id, join(dir, f.name, pick.name));
  }
  const textures = top.find((e) => e.folder && /textures/i.test(e.name));
  if (textures) await fetchDriveTree(textures.id, join(dir, textures.name));
  for (const e of top) if (!e.folder && /\.(png|jpg)$/i.test(e.name) && /atlas/i.test(e.name)) await downloadDriveFile(e.id, join(dir, e.name));
}

/** A cached pack is real if its model files aren't HTML error pages. */
function looksReal(dir: string): boolean {
  const models: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(glb|gltf|obj)$/i.test(e)) models.push(p);
    }
  };
  walk(dir);
  return models.length > 0 && !readFileSync(models[0]).subarray(0, 64).toString("latin1").toLowerCase().includes("<!doctype html");
}

const only = process.argv.slice(2);
mkdirSync(CACHE, { recursive: true });
for (const pack of PACKS) {
  if (only.length && !only.includes(pack.id)) continue;
  const dir = join(CACHE, pack.id);
  if (existsSync(join(dir, ".done")) && looksReal(dir)) { console.log(`✔ ${pack.id} (cached)`); continue; }
  rmSync(dir, { recursive: true, force: true }); // missing, partial, or full of Drive error pages
  mkdirSync(dir, { recursive: true });
  try {
    if (pack.kind === "kenney") await fetchKenney(pack.slug, dir);
    else if (pack.kind === "github") await fetchGithub(pack.repo, pack.branch, dir);
    else await fetchDrive(pack.folder, pack.formats, dir);
    writeFileSync(join(dir, ".done"), new Date().toISOString());
    console.log(`✔ ${pack.id}`);
  } catch (err) {
    console.log(`✖ ${pack.id}: ${(err as Error).message}`);
    rmSync(dir, { recursive: true, force: true }); // don't leave half a pack behind
  }
}
