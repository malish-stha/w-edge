/**
 * Every environment model the world uses, by pack ("<pack>/<model>"). The asset
 * build (`npm run build-env`) converts exactly these; the layout code refers to
 * them through the helpers below so a typo can't silently drop a model.
 */
const id = (pack: string) => (name: string) => `${pack}/${name}`;
export const kh = id("kaykit-medieval-hexagon");
export const kd = id("kaykit-dungeon");
export const nk = id("kenney-nature-kit");
export const ck = id("kenney-castle-kit");
export const pk = id("kenney-pirate-kit");
export const wk = id("kenney-watercraft-kit");
export const cave = id("kenney-modular-cave-kit");
export const dk = id("kenney-modular-dungeon-kit");

export type KkColour = "blue" | "red" | "yellow" | "green";
export const KK_COLOURS: KkColour[] = ["blue", "red", "yellow", "green"];
export const KK_BUILDINGS = [
  "home_A", "home_B", "tavern", "church", "market", "blacksmith", "windmill", "well",
  "tower_A", "tower_B", "tower_base", "castle", "barracks", "archeryrange", "lumbermill", "watermill",
] as const;
export type KkBuilding = (typeof KK_BUILDINGS)[number];
export const kkBuilding = (type: KkBuilding, colour: KkColour) => kh(`building_${type}_${colour}`);

const names = (f: (n: string) => string, list: string) => list.trim().split(/\s+/).map(f);

/** Models placed by the layout code (terrain, buildings, set pieces); props in dressing.ts add their own. */
export const CATALOGUE: string[] = [
  ...names(kh, `hex_grass hex_grass_bottom building_destroyed building_scaffolding building_grain building_dirt
    building_stage_A building_stage_B building_stage_C fence_wood_straight fence_wood_straight_gate fence_stone_straight
    wall_straight wall_straight_gate wall_corner_A_outside
    mountain_A mountain_B mountain_C mountain_A_grass mountain_B_grass mountain_C_grass
    mountain_A_grass_trees mountain_B_grass_trees mountain_C_grass_trees hills_A hills_B hills_C hills_A_trees hills_B_trees hills_C_trees
    rock_single_A rock_single_B rock_single_C rock_single_D rock_single_E tree_single_A tree_single_B
    trees_A_small trees_A_medium trees_A_large trees_B_small trees_B_medium trees_B_large cloud_big cloud_small
    waterplant_A waterplant_B waterlily_A barrel crate_A_big crate_B_small crate_long_A crate_open sack target tent
    weaponrack wheelbarrow flag_blue flag_red flag_yellow flag_green bucket_water ladder pallet resource_lumber resource_stone`),
  ...KK_BUILDINGS.flatMap((b) => KK_COLOURS.map((c) => kkBuilding(b, c))),
  ...names(kd, `floor_tile_large floor_dirt_large floor_tile_large_rocks pillar pillar_decorated column wall wall_arched
    wall_broken wall_cracked wall_half rubble_large rubble_half stairs_wide banner_blue banner_patternA_blue
    banner_shield_blue banner_thin_blue torch_lit torch_mounted barrel_large crates_stacked chest_gold barrier barrier_column`),
  ...names(ck, `tower-square-base tower-square-mid tower-square-mid-windows tower-square-top tower-square-top-roof-high
    tower-hexagon-base tower-hexagon-mid tower-hexagon-top tower-hexagon-roof wall wall-narrow wall-narrow-wood-fence gate
    flag flag-banner-long flag-pennant flag-wide siege-catapult siege-ballista siege-trebuchet stairs-stone bridge-straight`),
  ...names(pk, `structure-platform-dock structure-platform-dock-small structure-platform platform-planks structure
    structure-roof tower-watch tower-complete-large tower-complete-small ship-wreck ship-pirate-large ship-large mast`),
  ...names(wk, `boat-sail-a boat-sail-b boat-fishing-small boat-row-large boat-row-small ship-small ship-large ship-cargo-a buoy buoy-flag`),
  ...names(cave, `gate-rock template-wall-detail-a`),
];
