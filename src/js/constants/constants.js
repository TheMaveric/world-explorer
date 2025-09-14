export const TREE_TYPES = {
    'oak': {emoji: '🌳', biomes: ['forest', 'forestHills', 'plain'], minHeight: 1, maxHeight: 4},
    'pine': {
        emoji: '🌲',
        biomes: ['taiga', 'taigaHills', 'taigaMountains', 'snowyTaiga', 'snowyTaigaHills', 'snowyTaigaMountains', 'mountain'],
        minHeight: 2,
        maxHeight: 6
    },
    'jungle': {emoji: '🌴', biomes: ['jungle', 'jungleHills', 'beach'], minHeight: 3, maxHeight: 7},
    'acacia': {emoji: '🌳', biomes: ['savanna', 'savannaPlateau'], minHeight: 2, maxHeight: 5}, // Using oak emoji as a stand-in
    'swamp': {emoji: '🌳', biomes: ['swamp', 'swampHills'], minHeight: 1, maxHeight: 3} // Using oak emoji as a stand-in
};
export const FISH_TYPES = {
    // Common
    'cod': {emoji: '🐟', biomes: ['deepWater', 'shallowWater'], rarity: 0.5},
    'salmon': {
        emoji: '🐠', biomes: ['river', 'lowlandRiver', 'mountainRiver', 'deltaRiver', 'shallowWater'], rarity: 0.4
    }, // Temperate
    'trout': {emoji: '🐟', biomes: ['river', 'mountainRiver'], rarity: 0.3},
    'mackerel': {emoji: '🎣', biomes: ['shallowWater'], rarity: 0.2}, // Tropical
    'clownfish': {emoji: '🐠', biomes: ['shallowWater', 'jungle'], rarity: 0.2},
    'pufferfish': {emoji: '🐡', biomes: ['jungle', 'swamp', 'shallowWater'], rarity: 0.15},
    'piranha': {emoji: '🐟', biomes: ['river', 'marshRiver', 'swamp'], rarity: 0.1}, // Cold
    'arctic char': {emoji: '🐟', biomes: ['frozenDeepWater', 'frozenShallowWater', 'frozenRiver'], rarity: 0.4},
    'icefish': {emoji: '🧊', biomes: ['frozenDeepWater', 'frozenRiver'], rarity: 0.2}, // Swamp/Murky
    'catfish': {
        emoji: '🎣', biomes: ['swamp', 'river', 'marshRiver', 'lowlandRiver', 'deltaRiver'], rarity: 0.3
    }, // Deep Ocean
    'tuna': {emoji: '🐟', biomes: ['deepWater'], rarity: 0.2},
    'swordfish': {emoji: '🗡️', biomes: ['deepWater'], rarity: 0.1},
    'anglerfish': {emoji: '💡', biomes: ['deepWater'], rarity: 0.05},
};
// === Fast biome lookup tables =====================================
export const BIOME_COLORS = {
    'deepWater': [20, 91, 134],
    'shallowWater': [38, 166, 245],
    'frozenDeepWater': [20, 123, 174],
    'frozenShallowWater': [37, 174, 255],
    'beach': [255, 216, 122],
    'snowyBeach': [250, 240, 191],
    'desert': [250, 148, 24],
    'desertHills': [210, 95, 17],
    'badlands': [217, 69, 21],
    'badlandsPlateau': [202, 140, 101],
    'badlandsHills': [120, 25, 25],
    'taiga': [10, 102, 89],
    'taigaHills': [22, 57, 51],
    'taigaMountains': [51, 142, 129],
    'snowyTaiga': [49, 85, 74],
    'snowyTaigaHills': [36, 63, 54],
    'snowyTaigaMountains': [89, 125, 114],
    'savanna': [189, 178, 95],
    'savannaPlateau': [167, 157, 100],
    'jungle': [83, 123, 9],
    'jungleHills': [44, 66, 4],
    'swamp': [48, 53, 40],
    'swampHills': [31, 36, 24],
    'plain': [141, 179, 96],
    'forest': [5, 102, 33],
    'forestHills': [0, 66, 44],
    'forestMountains': [0, 48, 31],
    'mountain': [96, 96, 96],
    'snowyTundra': [255, 255, 255],
    'snowyMountains': [160, 160, 160],
    'iceSpikes': [180, 220, 220],
    'river': [37, 174, 255],
    'frozenRiver': [180, 220, 255],
    'marshRiver': [34, 120, 90],       // greenish, swampy
    'mountainRiver': [30, 140, 210],   // cooler blue
    'lowlandRiver': [37, 174, 255],    // keep bright
    'deltaRiver': [60, 170, 200],      // murky blue
};
export const BIOME_KEYS = Object.keys(BIOME_COLORS);
export const BIOME_TO_INDEX = new Map(BIOME_KEYS.map((k, i) => [k, i]));
export const BIOME_NAME = BIOME_KEYS; // index -> name
export const BIOME_COLOR_ARRAY = BIOME_KEYS.map(k => BIOME_COLORS[k]);
export const BIOME_IS_WATERLIKE = BIOME_KEYS.map(k => k.includes('Water') || /river/i.test(k));
// Forest like biomes where fireflies can appear (and we’ll bias them near water)
export const FIREFLY_BIOMES = ['forest', 'forestHills', 'taiga', 'taigaHills', 'taigaMountains', 'jungle', 'jungleHills', 'swamp', 'swampHills'];
export const FIREFLY_BIOME_IDX = new Set(FIREFLY_BIOMES.map(n => BIOME_TO_INDEX.get(n)));
// Distinct looks for NPC roles
export const NPC_STYLES = {
    villager: {emoji: '🧑', ring: '#74a3b9', badge: null, scale: 1.00, glow: false, sparkle: null},
    farmer: {emoji: '🧑‍🌾', ring: '#7dcf7b', badge: '🌾', scale: 1.05, glow: false, sparkle: null},
    builder: {emoji: '🧑‍🔧', ring: '#a3a3a3', badge: '🔨', scale: 1.05, glow: false, sparkle: null},
    trader: {emoji: '🧑‍💼', ring: '#ffd54a', badge: '🧺', scale: 1.22, glow: true, sparkle: '🪙'}
};


export const SEA_LEVEL_ABS = 128;
export const _OVERLAP = 1;
export const NOISE_OFFSET_X = 0.5, NOISE_OFFSET_Y = 0.5;
export const FIREFLY_NIGHT_LIGHT_LEVEL = 0.45;  // from getTimeOfDayInfo().lightLevel
export const FIREFLY_MAX_PER_CHUNK = 6;         // cap per visible chunk
// Fireflies settings
export const Wind = {
    baseAngle: 0,      // radians; slowly meanders
    speed: 0.25,       // current wind strength (0..~2)
    targetSpeed: 0.25, // eased toward by updateWind()
};

export const CHUNK_SIZE = 32, MAX_CACHE_SIZE = 2500, MAX_CHUNKS_PER_FRAME = 3, chunkCache = new Map(),
    rawNoiseCache = new Map();

export const Weather = {type: '☀️', until: 0}; // ☀️ (clear) | 🌧️ (rain) | ❄️ (snow)

// --- Settlements (villages) & trading ---
export const VILLAGE_RARITY = 0.012; // ~1.2% of suitable chunks attempt a village
export const VILLAGE_MIN_LAND_RATIO = 0.82;
export const VILLAGE_ALLOWED_BIOMES = new Set(['plain', 'savanna', 'forest', 'forestHills', 'taiga', 'taigaHills', 'jungle', 'jungleHills', 'swamp', 'swampHills', 'desert', 'desertHills']);
export const ROLES = {
    farmer: {emoji: '🧑‍🌾', offer: {give: {'🪵': 2}, get: {'🍞': 1}}},
    vendor: {emoji: '🧺', offer: {give: {'🐟': 2}, get: {'🧺': 1}}}, // simple “basket” reward
    smith: {emoji: '🔨', offer: {give: {'🪵': 4}, get: {'🪓': 1}}},
};


