/** Server simulation and input rate. One input == one fixed step on both sides. */
export const TICK_RATE = 30;
export const STEP_SECONDS = 1 / TICK_RATE;

/** State patches sent to clients per second. */
export const PATCH_RATE = 20;

/** Players allowed in one copy of the shared world before a new copy opens. */
export const WORLD_ROOM_CAPACITY = 60;

export const ROOM_WORLD = "world";

// --- Player body -----------------------------------------------------------
export const PLAYER_HALF_WIDTH = 0.35;
export const PLAYER_HEIGHT = 1.8;
/** Ledges up to this height are climbed automatically while walking. */
export const STEP_HEIGHT = 0.6;

// --- Ground movement --------------------------------------------------------
export const WALK_SPEED = 7;
export const RUN_SPEED = 11;
export const GROUND_ACCEL = 60;
export const AIR_ACCEL = 14;
export const JUMP_VELOCITY = 9;
export const GRAVITY = 25;
export const MAX_FALL_SPEED = 45;

// --- Flight -----------------------------------------------------------------
export const FLIGHT_SPEED = 15;
export const FLIGHT_ACCEL = 22;
export const BOOST_SPEED = 32;
export const CLIMB_SPEED = 9;
export const DESCEND_SPEED = 11;
/** Hover drag when there is no input. */
export const HOVER_DRAG = 3;
/** Camera pitch (radians, negative = looking down) needed for a boost to become a dive. */
export const DIVE_PITCH = -0.35;
export const DIVE_ACCEL = 40;
export const DIVE_MAX_SPEED = 60;
/** Momentum kept per second after a dive ends, as a fraction. */
export const MOMENTUM_DECAY = 0.6;
/** Touching the ground slower than this while flying lands you. Holding descend always lands. */
export const LAND_SPEED = 9;
/** Lowest height above the sea that fliers skim at. */
export const SKIM_HEIGHT = 0.4;

// --- Stamina and dodge ------------------------------------------------------
export const STAMINA_MAX = 100;
export const STAMINA_REGEN = 20;
/** After running dry, boosting stays locked until stamina recovers to this. */
export const STAMINA_RECOVER = 25;
export const BOOST_DRAIN = 22;
export const DIVE_DRAIN = 10;
export const DODGE_COST = 20;
export const DODGE_SPEED = 24;
export const DODGE_TIME = 0.22;
export const DODGE_COOLDOWN = 0.6;
export const TELEPORT_DISTANCE = 18;
export const TELEPORT_COST = 25;
export const TELEPORT_COOLDOWN = 2.5;

// --- World -----------------------------------------------------------------
export const SEA_LEVEL = 0;
/** The ocean ends here and spills over the World's Edge (negative z is "outward"). */
export const RIM_Z = -1400;
/** Falling below this height returns the player to their last safe spot. */
export const KILL_Y = -260;
