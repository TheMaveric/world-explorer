import {
    BIOME_COLOR_ARRAY,
    BIOME_COLORS,
    BIOME_IS_WATERLIKE,
    BIOME_NAME,
    BIOME_TO_INDEX,
    CHUNK_SIZE,
    chunkCache,
    FIREFLY_MAX_PER_CHUNK,
    FIREFLY_NIGHT_LIGHT_LEVEL,
    FISH_TYPES,
    NPC_STYLES,
    rawNoiseCache,
    ROLES,
    SEA_LEVEL_ABS,
    TREE_TYPES,
    VILLAGE_ALLOWED_BIOMES,
    VILLAGE_MIN_LAND_RATIO,
    VILLAGE_RARITY,
    Weather
} from "./constants/constants.js";
import {
    formatTime,
    getAbsoluteHeight,
    getBiomeAtWorldCoords,
    getBiomeIndexFromCache,
    getChunk,
    getFishPlacementRadius,
    getHeightGrad,
    getHeightValueAtWorldCoords,
    getMovementSpeedModifier,
    getPixelLightness,
    getRiverFlowAt,
    getSunVectorFromSlider,
    getTimeOfDayInfo,
    getTreePlacementRadius,
    isWaterLikeAt,
    isWaterLikeBiomeName,
    manageCache,
    seededRandom,
    updateNpc,
    updateWind
} from "./utils/utils.js";
import {PerlinNoise} from "./algos/perlin.js";
import {Particle} from "./object/particle.js";
import {PoissonDisk} from "./algos/poissonDisk.js";

let selectedTile = null; // { x, y } in world tile coords
let lastVisibleTiles = []; // visible tile screen diamonds for picking this frame

function pointInDiamond(mx, my, cx, cy, tw, th) {
    // diamond centered at (cx, cy) with width tw and height th
    const dx = Math.abs(mx - cx);
    const dy = Math.abs(my - cy);
    return (dx / (tw * 0.5) + dy / (th * 0.5)) <= 1;
}

let perlin, isGenerating = false, isGamePaused = false, isDebugViewActive = false, isContourOverlayActive = false;
let showSpawnOverlay = false; // NEW: toggled with P
let isLightingEnabled = true;
// Rendering mode: 'topdown' or 'isometric'
let renderMode = 'topdown';
// --- Weather & Season (globals) ---
let season = 0.25; // 0..1 (winter→spring→summer→autumn bias)
// --- Wind (global, slow-changing direction + gusts + spatial coherence) ---
let windTime = 0;

// ... your other globals ...
let nearbyTradeNpc = null;
// ---- Tile picking state ----
let mouse = {x: 0, y: 0};
let hoverTile = null; // tile currently under mouse (front-most)
// --- World life & hazards (new globals) ---
let fireflies = []; // ephemeral night particles
let waterFxQuality = 1; // you already have this below, keep the highest one (remove duplicate if present)
let frameTick = 0; // "

// Floating objects' radius (reuse fish water coverage but sparser)
function getFloatingPlacementRadius(biome, sliders) {
    if (biome.includes('Water') || /river/i.test(biome)) return Math.max(3, 14 / Math.max(0.2, sliders.fishDensityMultiplier));
    return 0;
}

let keys = {}, timeOfDay = 0.25, lastFrameTime = 0, lastFpsUpdateTime = 0;
const fpsHistory = [], messages = [], particles = [];
let minFps = Infinity, maxFps = 0;
let player = {
    x: 0, y: 0, fishLog: {}, inv: {} // emoji -> count
};
let DOMElements, canvas, viewport, playerDiv, playerEmojiSpan, seedInput, ctx, sliders;
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
minimapCanvas.width = minimapCanvas.height = 100;

let lastMinimapPlayerPos = {x: null, y: null};

export function getSliderValues() {
    return {
        heightScale: parseFloat(sliders.heightScale.slider.value),
        moistureScale: parseFloat(sliders.moistureScale.slider.value),
        climateContrast: parseFloat(sliders.climateContrast.slider.value),
        pixelScale: parseFloat(sliders.pixelScale.slider.value),
        persistence: parseFloat(sliders.persistence.slider.value),
        playerSpeed: parseFloat(sliders.playerSpeed.slider.value),
        waterLevel: parseFloat(sliders.waterLevel.slider.value),
        treeDensityMultiplier: parseFloat(sliders.treeDensity.slider.value),
        fishDensityMultiplier: parseFloat(sliders.fishDensity.slider.value),
        mapScale: parseFloat(sliders.mapScale.slider.value),

        sunDirDegrees: parseFloat(document.getElementById('sunDirSlider')?.value || 0),
    };
}

function invAdd(emoji, n = 1) {
    player.inv[emoji] = (player.inv[emoji] || 0) + n;
}

function invHasAll(req) {
    for (const [e, q] of Object.entries(req)) if ((player.inv[e] || 0) < q) return false;
    return true;
}

function invConsume(req) {
    for (const [e, q] of Object.entries(req)) player.inv[e] = (player.inv[e] || 0) - q;
}

function invGrant(give) {
    for (const [e, q] of Object.entries(give)) invAdd(e, q);
}

function formatOffer(o) {
    const lhs = Object.entries(o.give).map(([e, q]) => `${q}${e}`).join(' + ');
    const rhs = Object.entries(o.get).map(([e, q]) => `${q}${e}`).join(' + ');
    return `${lhs} → ${rhs}`;
}

function generatePerlinMaps() {
    const seed = parseInt(seedInput.value) || 0;
    perlin = {
        height: new PerlinNoise(seed),
        moisture: new PerlinNoise(seed + 1),
        object: new PerlinNoise(seed + 2),
        temperature: new PerlinNoise(seed + 3),
        river: new PerlinNoise(seed + 4)
    };
}

// --- Helpers for biome-aware rivers ----------------------------------------
function rgbMix([r1, g1, b1], [r2, g2, b2], a) {
    return [Math.round(r1 * (1 - a) + r2 * a), Math.round(g1 * (1 - a) + b2 * a), Math.round(b1 * (1 - a) + b2 * a)];
}


// Sample 8-neighborhood to find dominant *land* biome around (local grid coords)
function getDominantNeighborLandBiome(biomeGrid, x, y) {
    const w = CHUNK_SIZE, h = CHUNK_SIZE;
    const isLand = b => b && !(b.includes('Water') || /river/i.test(b)) && b !== 'beach' && b !== 'snowyBeach';
    const counts = {};
    for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
            if (i === 0 && j === 0) continue;
            const xx = x + i, yy = y + j;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const b = biomeGrid[yy * w + xx];
            if (isLand(b)) counts[b] = (counts[b] || 0) + 1;
        }
    }
    // return most frequent land biome (or null)
    let best = null, c = -1;
    for (const k in counts) if (counts[k] > c) {
        best = k;
        c = counts[k];
    }
    return best;
}

// Map surrounding land biome -> river style (color tint, extra width, speed tweak)
function getRiverStyle(surroundBiome, nearSea) {
    // default classic blue
    let tint = [37, 174, 255], // base shallow-water blue
        extraWidth = 0, // extra halo pixels
        alpha = 0.16, // Light Halo opacity
        speedMul = 0.4, // baseline matches your lowlandRiver default
        fishBoost = 0; // small density bias

    if (nearSea) { // delta behavior
        tint = [60, 170, 200]; // murkier
        extraWidth += 1;
        alpha = 0.22;
        fishBoost += 0.2; // denser fish in deltas
    }

    if (!surroundBiome) return {tint, extraWidth, alpha, speedMul, fishBoost};

    if (/mountain|snowy|ice/i.test(surroundBiome)) {
        tint = [30, 140, 210]; // cooler / glacial hint
        speedMul = 0.45; // slightly faster
        alpha = Math.max(alpha, 0.18);
    } else if (/forest|plain|taiga/i.test(surroundBiome)) {
        tint = [37, 174, 255]; // classic
        speedMul = 0.4;
    } else if (/jungle|swamp/i.test(surroundBiome)) {
        tint = [85, 70, 40]; // tea/blackwater
        extraWidth += 1; // marshy fringing
        alpha = 0.22;
        speedMul = 0.35; // slower
        fishBoost += 0.15; // catfish/piranha thrive
    } else if (/desert|badlands/i.test(surroundBiome)) {
        tint = [185, 150, 70]; // silty/yellow-brown water
        extraWidth += 1;
        alpha = 0.2;
        speedMul = 0.4;
    } else if (/savanna/i.test(surroundBiome)) {
        tint = rgbMix([37, 174, 255], [185, 150, 70], 0.25); // slightly siltier than forest
        speedMul = 0.4;
    }
    return {tint, extraWidth, alpha, speedMul, fishBoost};
}

function pickLandCenterInChunk(biomeIdx, waterMask) {
    // try the true center, then a few jitters until we hit land
    const tries = 20;
    for (let t = 0; t < tries; t++) {
        const cx = Math.floor(CHUNK_SIZE / 2 + (Math.random() - 0.5) * 8);
        const cy = Math.floor(CHUNK_SIZE / 2 + (Math.random() - 0.5) * 8);
        const i = cy * CHUNK_SIZE + cx;
        if (!waterMask[i]) return {lx: cx, ly: cy};
    }
    return {lx: Math.floor(CHUNK_SIZE / 2), ly: Math.floor(CHUNK_SIZE / 2)};
}

function buildVillageInChunk(chunkX, chunkY, biomeIdx, waterMask, seed) {
    // land ratio & dominant biome gate
    let landCount = 0, landBiomeCounts = {};
    for (let i = 0; i < biomeIdx.length; i++) if (!waterMask[i]) {
        landCount++;
        const name = BIOME_NAME[biomeIdx[i]];
        landBiomeCounts[name] = (landBiomeCounts[name] || 0) + 1;
    }
    const landRatio = landCount / (CHUNK_SIZE * CHUNK_SIZE);
    if (landRatio < VILLAGE_MIN_LAND_RATIO) return null;

    let dom = null, best = -1;
    for (const [name, c] of Object.entries(landBiomeCounts)) if (c > best) {
        best = c;
        dom = name;
    }
    if (!VILLAGE_ALLOWED_BIOMES.has(dom)) return null;

    // rarity / seed
    const r = seededRandom(chunkX * 1259 + chunkY * 3371 + seed + 77)();
    if (r > VILLAGE_RARITY) return null;

    // center
    const {lx, ly} = pickLandCenterInChunk(biomeIdx, waterMask);
    const wx0 = chunkX * CHUNK_SIZE, wy0 = chunkY * CHUNK_SIZE;
    const centerWx = wx0 + lx, centerWy = wy0 + ly;

    // theme (just pick house emoji by climate)
    const isDesert = /desert|badlands/i.test(dom);
    const isJungle = /jungle|swamp/i.test(dom);
    const HOUSE = isDesert ? '🛖' : (isJungle ? '🏚️' : '🏠');

    // layout
    const objects = [];
    const houses = [];
    const rand = seededRandom(chunkX * 8881 + chunkY * 113 + seed + 911);
    const nHouses = 4 + Math.floor(rand() * 4); // 4..7
    const ringR = 6 + Math.floor(rand() * 4); // ring radius

    const placeIfLand = (wx, wy, emoji, type, extra = {}) => {
        const cx = Math.floor(wx) - wx0, cy = Math.floor(wy) - wy0;
        if (cx < 0 || cy < 0 || cx >= CHUNK_SIZE || cy >= CHUNK_SIZE) return false;
        const i = cy * CHUNK_SIZE + cx;
        if (waterMask[i]) return false;
        objects.push({x: Math.round(wx), y: Math.round(wy), type, emoji, ...extra});
        return true;
    };

    // central plaza (market/workshop live here)
    placeIfLand(centerWx, centerWy, '🕯️', 'decor', {label: 'plaza'});

    // houses around ring
    for (let i = 0; i < nHouses; i++) {
        const a = (i / nHouses) * Math.PI * 2 + rand() * 0.3;
        const dx = Math.cos(a) * ringR + (rand() - 0.5) * 1.5;
        const dy = Math.sin(a) * ringR + (rand() - 0.5) * 1.5;
        const hx = centerWx + dx, hy = centerWy + dy;
        if (placeIfLand(hx, hy, HOUSE, 'building')) houses.push({x: Math.round(hx), y: Math.round(hy)});
    }

    // fields (🌾) in bands on one side
    const fieldDir = (rand() < 0.5) ? {x: 1, y: 0} : {x: 0, y: 1};
    for (let k = -2; k <= 2; k++) {
        for (let s = -5; s <= 5; s++) {
            const fx = centerWx + fieldDir.x * (s + 7) + (fieldDir.y ? k : 0);
            const fy = centerWy + fieldDir.y * (s + 7) + (fieldDir.x ? k : 0);
            placeIfLand(fx, fy, '🌾', 'decor');
        }
    }

    // market stall + workshop near plaza
    const market = {x: centerWx + 2, y: centerWy + (rand() < 0.5 ? 1 : -1)};
    const forge = {x: centerWx - 2, y: centerWy + (rand() < 0.5 ? -1 : 1)};
    placeIfLand(market.x, market.y, '🧺', 'building', {label: 'stall'});
    placeIfLand(forge.x, forge.y, '🔨', 'building', {label: 'forge'});

    // NPCs (farmer, vendor, smith). Pick random homes.
    const npcs = [];
    const takeHome = () => houses[(Math.floor(rand() * houses.length)) | 0];
    const mkNPC = (role, work) => {
        const home = takeHome() || {x: centerWx, y: centerWy};
        const d = ROLES[role];
        npcs.push({
            type: 'npc',
            role,
            emoji: d.emoji,
            offer: d.offer,
            x: home.x,
            y: home.y,
            homeX: home.x,
            homeY: home.y,
            workX: work.x,
            workY: work.y,
            cx: centerWx,
            cy: centerWy, // village center
            phase: rand() * Math.PI * 2,
            speed: 0.9 + rand() * 0.4
        });
    };
    mkNPC('farmer', fieldDir.x ? {x: centerWx + 10, y: centerWy} : {x: centerWx, y: centerWy + 10});
    mkNPC('vendor', market);
    mkNPC('smith', forge);

    return {centerWx, centerWy, objects, npcs};
}

function generateChunkData(chunkX, chunkY, sliders, sunVector, seed) {
    const key = `${chunkX},${chunkY}`;
    // Store per-pixel biome; used by banks/branches/foam
    const biomeIdx = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE);
    const biomeGrid = new Array(CHUNK_SIZE * CHUNK_SIZE);
    // Fast helpers

    const chunkCanvas = document.createElement('canvas');
    chunkCanvas.width = chunkCanvas.height = CHUNK_SIZE;
    const chunkCtx = chunkCanvas.getContext('2d'), chunkImageData = chunkCtx.createImageData(CHUNK_SIZE, CHUNK_SIZE);
    const data = chunkImageData.data, objects = [];

    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const worldX = chunkX * CHUNK_SIZE + x + 0.5; // ← +0.5
            const worldY = chunkY * CHUNK_SIZE + y + 0.5; // ← +0.5
            const biome = getBiomeAtWorldCoords(worldX, worldY, perlin, sliders);
            const bIndex = BIOME_TO_INDEX.get(biome);
            const i1d = y * CHUNK_SIZE + x;
            biomeIdx[i1d] = bIndex;
            biomeGrid[i1d] = biome; // <-- add
            const heightValue = getHeightValueAtWorldCoords(worldX, worldY, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
            const baseColor = BIOME_COLOR_ARRAY[bIndex] || [255, 0, 0];
            const lightness = isLightingEnabled ? getPixelLightness(worldX, worldY, heightValue, perlin.height, sliders, sunVector) : 1.0;


            const [r, g, b] = baseColor.map(c => Math.min(255, Math.max(0, c * lightness)));
            const idx = (y * CHUNK_SIZE + x) * 4;
            [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]] = [r, g, b, 255];
        }
    }
    // --- Precompute water mask + shoreline for cheap per-frame drawing ---
    const waterMask = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    const shoreline = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const i = y * CHUNK_SIZE + x;
            waterMask[i] = BIOME_IS_WATERLIKE[biomeIdx[i]] ? 1 : 0;
        }
    }
    // find shoreline cells (water cells adjacent to non-water)
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const i = y * CHUNK_SIZE + x;
            if (!waterMask[i]) continue;

            const getWaterAt = (lx, ly) => {
                if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < CHUNK_SIZE) {
                    return waterMask[ly * CHUNK_SIZE + lx];
                }
                const wx = chunkX * CHUNK_SIZE + lx;
                const wy = chunkY * CHUNK_SIZE + ly;
                const ncx = Math.floor(wx / CHUNK_SIZE), ncy = Math.floor(wy / CHUNK_SIZE);
                const neighbor = getChunk(ncx, ncy);
                if (neighbor && neighbor.waterMask) {
                    const nlx = wx - ncx * CHUNK_SIZE, nly = wy - ncy * CHUNK_SIZE;
                    return neighbor.waterMask[nly * CHUNK_SIZE + nlx] || 0;
                }
                // rare fallback
                return isWaterLikeBiomeName(getBiomeAtWorldCoords(wx, wy, perlin, sliders)) ? 1 : 0;
            };

            const left = getWaterAt(x - 1, y);
            const right = getWaterAt(x + 1, y);
            const up = getWaterAt(x, y - 1);
            const down = getWaterAt(x, y + 1);
            if (!(left && right && up && down)) shoreline.push(i);
        }
    }

    // --- Firefly nests (shoreline cells touching friendly land biomes) ---
    const fireflyNests = [];
    // seeded RNG so nests are deterministic per chunk+seed
    const nestRand = seededRandom(chunkX * 73856093 ^ chunkY * 19349663 ^ seed);

    function isLandFriendly(ii) {
        const name = BIOME_NAME[biomeIdx[ii]];
        // prefer treed/vegetated land near water
        return name && (/forest|swamp|jungle/i.test(name) || name === 'plain');
    }

    for (let s = 0; s < shoreline.length; s++) {
        const i = shoreline[s];
        const x = i % CHUNK_SIZE, y = (i / CHUNK_SIZE) | 0;

        // check 4-neighbors for a suitable land tile
        const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        let good = false;
        for (const [xx, yy] of nb) {
            if (xx < 0 || yy < 0 || xx >= CHUNK_SIZE || yy >= CHUNK_SIZE) continue;
            const ii = yy * CHUNK_SIZE + xx;
            if (!waterMask[ii] && isLandFriendly(ii)) {
                good = true;
                break;
            }
        }
        if (good && nestRand() < 0.18) {
            // store local coords (tile space inside this chunk)
            fireflyNests.push({x, y});
        }
    }

    // --- Biome-aware river rendering & bank effects ---
    const riverHints = [];
    const heightCacheLocal = new Map();

    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const i = y * CHUNK_SIZE + x;
            const b = biomeGrid[i];
            if (!isWaterLikeBiomeName(b)) continue;

            const worldX = chunkX * CHUNK_SIZE + x;
            const worldY = chunkY * CHUNK_SIZE + y;

            const domLand = getDominantNeighborLandBiome(biomeGrid, x, y);
            const style = getRiverStyle(domLand, (() => {
                const h = getAbsoluteHeight(worldX, worldY, perlin, sliders, heightCacheLocal);
                return h < 140 && h >= 132;
            })());

            // mix color directly in the buffer (no get/put per pixel)
            const idx = (i << 2);
            const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];
            const [nr, ng, nb] = rgbMix([pr, pg, pb], style.tint, 0.55);
            data[idx] = nr;
            data[idx + 1] = ng;
            data[idx + 2] = nb;

            // cheap 4-neighborhood halo (optional)
            if (style.extraWidth > 0) {
                const halo = (xx, yy) => {
                    if (xx < 0 || yy < 0 || xx >= CHUNK_SIZE || yy >= CHUNK_SIZE) return;
                    const ii = (yy * CHUNK_SIZE + xx) << 2;
                    // alpha blend against existing buffer
                    data[ii] = Math.round(data[ii] * (1 - style.alpha) + style.tint[0] * style.alpha);
                    data[ii + 1] = Math.round(data[ii + 1] * (1 - style.alpha) + style.tint[1] * style.alpha);
                    data[ii + 2] = Math.round(data[ii + 2] * (1 - style.alpha) + style.tint[2] * style.alpha);
                };
                halo(x - 1, y);
                halo(x + 1, y);
                halo(x, y - 1);
                halo(x, y + 1);
            }

            // flow hint
            const g = getHeightGrad(worldX, worldY, perlin, sliders);
            const n = (() => {
                const m = Math.hypot(g.fx, g.fy) || 1e-6;
                return {x: g.fx / m, y: g.fy / m};
            })();
            const gradMag = Math.min(1, Math.hypot(g.fx, g.fy) * 4.0);
            const currentStrength = style.speedMul * (0.6 + 0.6 * gradMag);

            riverHints.push({
                x,
                y,
                speedMul: style.speedMul,
                fishBoost: style.fishBoost,
                flow: {x: n.x * currentStrength, y: n.y * currentStrength}
            });
        }
    }

    chunkCtx.putImageData(chunkImageData, 0, 0);

    const trees = PoissonDisk.generatePointsForChunk(chunkX, chunkY, perlin, sliders, seed, getTreePlacementRadius, (biome) => getTreePlacementRadius(biome, sliders) > 0, (c) => {
        const possibleTrees = Object.values(TREE_TYPES).filter(t => t.biomes.includes(c.biome));
        if (possibleTrees.length === 0) return null;

        const typeRand = seededRandom(c.x * c.y + seed + 1)();
        const treeIndex = Math.floor(typeRand * possibleTrees.length);
        const treeType = possibleTrees[treeIndex];
        if (!treeType) return null;

        const heightRand = seededRandom(c.x * 123 + c.y * 456 + seed + 4)();
        const height = treeType.minHeight + Math.floor(heightRand * (treeType.maxHeight - treeType.minHeight + 1));

        const offsetXRand = seededRandom(c.x * 987 + c.y * 654 + seed + 2)();
        const offsetYRand = seededRandom(c.x * 321 + c.y * 123 + seed + 3)();

        const offsetX = (offsetXRand - 0.5) * 0.8;
        const offsetY = (offsetYRand - 0.5) * 0.8;

        return {
            x: Math.round(c.x),
            y: Math.round(c.y),
            type: 'tree',
            emoji: treeType.emoji,
            height,
            offsetX,
            offsetY,
            swayPhase: seededRandom(c.x * 777 + c.y * 333 + seed + 9)() * Math.PI * 2, // NEW: spring state (bending with inertia)
            bend: 0, // current tip offset in pixels
            bendVel: 0 // velocity of the bend (px/s)
        };

    });

    const fish = PoissonDisk.generatePointsForChunk(chunkX, chunkY, perlin, sliders, seed, getFishPlacementRadius, isWaterLikeBiomeName, (c) => {
        const possibleFish = Object.entries(FISH_TYPES).filter(([_, f]) => f.biomes.includes(c.biome));
        if (possibleFish.length === 0) return null;

        // Weighted pick by rarity (no early return!)
        const rand = seededRandom(c.x * c.y + seed)();
        const totalRarity = possibleFish.reduce((sum, [, f]) => sum + f.rarity, 0);
        let choice = rand * totalRarity;
        let selected = possibleFish[possibleFish.length - 1];
        for (const entry of possibleFish) {
            const [, f] = entry;
            if (choice < f.rarity) {
                selected = entry;
                break;
            }
            choice -= f.rarity;
        }
        const [name, fishData] = selected;

        // Motion/state present for ALL fish
        let baseSpeed = (/river/i.test(c.biome) ? 1.8 : 1.1);
        if (/frozen/i.test(c.biome)) baseSpeed *= 0.8;
        if (/deltaRiver|marshRiver/i.test(c.biome)) baseSpeed *= 1.1;

        const dirRand = seededRandom(c.x * 41 + c.y * 73 + seed + 5)();
        const theta = dirRand * Math.PI * 2;

        return {
            x: Math.round(c.x),
            y: Math.round(c.y),
            type: 'fish',
            name,
            emoji: fishData.emoji,

            vx: Math.cos(theta) * 0.5,
            vy: Math.sin(theta) * 0.5,
            speed: baseSpeed,
            phase: seededRandom(c.x * 17 + c.y * 29 + seed + 6)() * Math.PI * 2,
            homeX: Math.round(c.x),
            homeY: Math.round(c.y),
        };
    });

    // Floating debris / lilies (🍃, 🪵, 🪷)
    const floaters = PoissonDisk.generatePointsForChunk(chunkX, chunkY, perlin, sliders, seed + 101, getFloatingPlacementRadius, isWaterLikeBiomeName, (c) => {
        // choose type by biome
        const onRiver = /river/i.test(c.biome);
        const onShallow = /shallowWater|deltaRiver|marshRiver/i.test(c.biome);
        let kind = 'leaf', emoji = '🍃', drag = 1.0;

        const r = seededRandom(13 * c.x + 37 * c.y + seed + 7)();
        if (onShallow && r < 0.25) {
            kind = 'lily';
            emoji = '🪷';
            drag = 0.35;
        } else if (r < 0.45) {
            kind = 'log';
            emoji = '🪵';
            drag = 0.7;
        }
        // else leaf (🍃)

        const theta = seededRandom(19 * c.x + 23 * c.y + seed + 8)() * Math.PI * 2;
        return {
            x: Math.round(c.x),
            y: Math.round(c.y),
            type: 'float',
            kind,
            emoji,
            vx: Math.cos(theta) * 0.1,
            vy: Math.sin(theta) * 0.1,
            drag, // 0..1 less = drifts mostly with flow
            phase: seededRandom(c.x * 5 + c.y * 3 + seed)() * Math.PI * 2
        };
    });
    objects.push(...floaters.filter(f => f));
    objects.push(...trees.filter(t => t !== null), ...fish.filter(f => f !== null));
    // --- Procedural village (rare, per-chunk) ---
    let village = buildVillageInChunk(chunkX, chunkY, biomeIdx, waterMask, seed);
    if (village) {
        // buildings/fields are just scene objects
        for (const o of village.objects) objects.push(o);
        // NPCs are objects too; keep them inside this chunk (their routines respect bounds)
        for (const n of village.npcs) objects.push(n);
    }

    chunkCache.set(key, {
        canvas: chunkCanvas, objects, riverHints, waterMask, shoreline, biomeIdx, fireflyNests, fireflies: [], village // may be null
    });
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function renderNpc(obj, objScreenX, objScreenY, pixelScale, ctx) {
    // Resolve role/style
    const role = obj.role || (obj.offer ? 'trader' : 'villager');
    const st = NPC_STYLES[role] || NPC_STYLES.villager;

    const cx = objScreenX + pixelScale / 2;
    const cy = objScreenY + pixelScale / 2;

    // 1) Drop shadow (subtle for all)
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'black';
    ctx.beginPath();
    ctx.ellipse(cx, cy + pixelScale * 0.32, pixelScale * 0.35, pixelScale * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2) Back ring (color-coded; traders glow)
    ctx.save();
    if (st.glow) {
        const r = pixelScale * 0.75;
        const g = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
        g.addColorStop(0.00, 'rgba(255, 221, 120, 0.85)');
        g.addColorStop(0.50, 'rgba(255, 213, 74, 0.35)');
        g.addColorStop(1.00, 'rgba(255, 213, 74, 0.00)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = st.ring;
        ctx.lineWidth = Math.max(1, pixelScale * 0.12);
        ctx.beginPath();
        ctx.arc(cx, cy, pixelScale * 0.55, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();

    // 3) Main emoji (bigger for trader)
    ctx.save();
    ctx.font = `${Math.max(12, pixelScale * st.scale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.emoji, cx, cy);
    ctx.restore();

    // 4) Role badge (top-right)
    if (st.badge) {
        const bx = cx + pixelScale * 0.45;
        const by = cy - pixelScale * 0.45;
        // badge background
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(bx, by, pixelScale * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // badge emoji
        ctx.save();
        ctx.font = `${Math.max(10, pixelScale * 0.6)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(st.badge, bx, by);
        ctx.restore();
    }

    // 5) Trader sparkle (rare, brief)
    if (st.sparkle) {
        const phase = (frameTick + ((obj.sparkSeed ??= (Math.random() * 1000) | 0))) % 90;
        if (phase < 10) {
            const sx = cx + (Math.random() - 0.5) * pixelScale * 0.9;
            const sy = cy - pixelScale * 0.9 + Math.random() * pixelScale * 0.3;
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.font = `${Math.max(10, pixelScale * 0.55)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(st.sparkle, sx, sy);
            ctx.restore();
        }
    }
}

// ---------- ISO helpers ----------
const iso = {
    tileW() {
        return parseInt(sliders.pixelScale.slider.value) * 2;
    }, // width
    tileH() {
        return parseInt(sliders.pixelScale.slider.value);
    }, // height = width/2
    elev() {
        const pixelScale = parseInt(sliders.pixelScale.slider.value);
        return pixelScale * 1.3;
    }
};


// Convert world (wx,wy) + vertical lift (wz pixels) to screen
function worldToScreenIso(wx, wy, wz, centerX, centerY) {
    const tw = iso.tileW(), th = iso.tileH();
    const sx = (wx - wy) * (tw / 2);
    const sy = (wx + wy) * (th / 2) - wz;
    return {x: centerX + sx, y: centerY + sy};
}

// Approx inverse (ignores vertical lift), for clicks
function screenToWorldIso(sx, sy, centerX, centerY) {
    const tw = iso.tileW(), th = iso.tileH();
    const dx = sx - centerX, dy = sy - centerY;
    const A = dx / (tw / 2); // wx - wy
    const B = dy / (th / 2); // wx + wy
    return {x: (A + B) / 2, y: (B - A) / 2};
}

// Draw a filled diamond (top face of an iso tile)
function fillIsoDiamond(ctx, cx, cy, tw, th, fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(cx, cy - th / 2); // top
    ctx.lineTo(cx + tw / 2, cy); // right
    ctx.lineTo(cx, cy + th / 2); // bottom
    ctx.lineTo(cx - tw / 2, cy); // left
    ctx.closePath();
    ctx.fill();
}

// --- NEW: Helper to draw a generic isometric box (e.g., a cube) ---
function drawIsoBox(ctx, wx, wy, wz, size, color, proj, lightK) {
    const elevScale = iso.elev();
    const tw = iso.tileW();

    // Calculate screen coordinates for all 8 corners of the box
    // Bottom face
    const pB_TL = proj(wx, wy, wz);
    const pB_TR = proj(wx + size, wy, wz);
    const pB_BL = proj(wx, wy + size, wz);
    const pB_BR = proj(wx + size, wy + size, wz);

    // Top face
    const topWz = wz + size * elevScale;
    const pT_TL = proj(wx, wy, topWz);
    const pT_TR = proj(wx + size, wy, topWz);
    const pT_BL = proj(wx, wy + size, topWz);
    const pT_BR = proj(wx + size, wy + size, topWz);

    const [r, g, b] = color;

    // Draw left face (darkest)
    ctx.fillStyle = `rgb(${Math.round(r * lightK * 0.7)}, ${Math.round(g * lightK * 0.7)}, ${Math.round(b * lightK * 0.7)})`;
    ctx.beginPath();
    ctx.moveTo(pT_TL.x, pT_TL.y);
    ctx.lineTo(pB_TL.x, pB_TL.y);
    ctx.lineTo(pB_BL.x, pB_BL.y);
    ctx.lineTo(pT_BL.x, pT_BL.y);
    ctx.closePath();
    ctx.fill();

    // Draw right face (medium shade)
    ctx.fillStyle = `rgb(${Math.round(r * lightK * 0.85)}, ${Math.round(g * lightK * 0.85)}, ${Math.round(b * lightK * 0.85)})`;
    ctx.beginPath();
    ctx.moveTo(pT_TR.x, pT_TR.y);
    ctx.lineTo(pB_TR.x, pB_TR.y);
    ctx.lineTo(pB_BR.x, pB_BR.y);
    ctx.lineTo(pT_BR.x, pT_BR.y);
    ctx.closePath();
    ctx.fill();

    // Draw top face (lightest)
    ctx.fillStyle = `rgb(${Math.round(r * lightK)}, ${Math.round(g * lightK)}, ${Math.round(b * lightK)})`;
    ctx.beginPath();
    ctx.moveTo(pT_TL.x, pT_TL.y);
    ctx.lineTo(pT_TR.x, pT_TR.y);
    ctx.lineTo(pT_BR.x, pT_BR.y);
    ctx.lineTo(pT_BL.x, pT_BL.y);
    ctx.closePath();
    ctx.fill();
}


// --- NEW: toggle + label helper + debug store ---
let showTileHeights = true; // press "K" to toggle

function drawCenteredLabel(ctx, x, y, text, px) {
    const fontPx = Math.max(8, Math.min(12, Math.floor(px)));
    ctx.save();
    ctx.font = `${fontPx}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(1, Math.floor(fontPx * 0.22));
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
}

// Debug buffer + flag (used by J toggle below)
window.__isoDebug = [];
let ISO_DEBUG = false;

// ---- helpers for water depth lighting ----
function pathIsoDiamond(ctx, cx, cy, tw, th) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - th / 2);
    ctx.lineTo(cx + tw / 2, cy);
    ctx.lineTo(cx, cy + th / 2);
    ctx.lineTo(cx - tw / 2, cy);
    ctx.closePath();
}

// Gradient + subtle animated caustics on the water top
function fillIsoDiamondWater(ctx, cx, cy, tw, th, baseRGB, depth01, lightK, sunVec, rippleSeed = 0) {
    // depth01: 0 = very shallow, 1 = very deep
    const [r0, g0, b0] = baseRGB;

    // Shallow boost / deep darken
    const shallowBoost = (1 - depth01) * 0.35;
    const deepDarken = depth01 * 0.30;

    // Sun-facing vs far side (simple linear grad along sun direction)
    const ax = cx - sunVec[0] * tw * 0.45, ay = cy - sunVec[1] * th * 0.45;
    const bx = cx + sunVec[0] * tw * 0.45, by = cy + sunVec[1] * th * 0.45;

    const kNear = Math.max(0.55, lightK) * (1.00 + shallowBoost); // brighter on sun side, esp. shallow
    const kFar = Math.max(0.55, lightK) * (1.00 - deepDarken); // darker away, esp. deep

    const cNear = `rgb(${Math.min(255, Math.round(r0 * kNear))},${Math.min(255, Math.round(g0 * kNear))},${Math.min(255, Math.round(b0 * kNear))})`;
    const cFar = `rgb(${Math.min(255, Math.round(r0 * kFar))},${Math.min(255, Math.round(g0 * kFar))},${Math.min(255, Math.round(b0 * kFar))})`;

    const grad = ctx.createLinearGradient(ax, ay, bx, by);
    grad.addColorStop(0, cNear);
    grad.addColorStop(1, cFar);

    ctx.save();
    pathIsoDiamond(ctx, cx, cy, tw, th);
    ctx.fillStyle = grad;
    ctx.fill();

    // Caustic shimmer in shallows (very subtle, fades with depth)
    const ca = (1 - depth01) * 0.25;
    if (ca > 0.01) {
        const t = performance.now() * 0.001 + rippleSeed * 12.345;
        const nx = -sunVec[1], ny = sunVec[0]; // across-sun direction
        ctx.globalAlpha = ca * 0.25;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = Math.max(1, tw * 0.03);
        for (let i = -1; i <= 1; i++) {
            const off = (i * 0.18) + (Math.sin(t * 1.7 + i) * 0.05);
            ctx.beginPath();
            ctx.moveTo(cx + nx * tw * 0.45 + sunVec[0] * off * tw, cy + ny * th * 0.45 + sunVec[1] * off * th);
            ctx.lineTo(cx - nx * tw * 0.45 + sunVec[0] * off * tw, cy - ny * th * 0.45 + sunVec[1] * off * th);
            ctx.stroke();
        }
    }
    ctx.restore();
}

function drawIsoWorld(deltaTime = 0) {
    if (isGenerating || !perlin) return {visibleTrees: 0, visibleFish: 0};

    // --- constants just for this pass (units are in absolute height 0..255) ---
    const RIVER_SURFACE_DROP_UNITS = 0; // river surface sits this much below local ground
    const RIVER_WATER_DEPTH_UNITS = 4; // shallow river thickness under surface

    nearbyTradeNpc = null;

    let slidersVals = getSliderValues();
    const {pixelScale} = slidersVals;

    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    canvas.width = vw;
    canvas.height = vh;
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;

    const camX = vw / 2, camY = vh / 2;

    const dayAngle = (timeOfDay - 0.25) * 2 * Math.PI;
    slidersVals = getSliderValues();
    const sunVector = getSunVectorFromSlider();
    const timeInfo = getTimeOfDayInfo(timeOfDay);

    const seed = parseInt(seedInput.value) || 0;

    canvas.width = vw;
    canvas.height = vh;

    const tw = iso.tileW(), th = iso.tileH();
    const elevScale = iso.elev();
    const heightCache = new Map();
    const pH = getAbsoluteHeight(Math.round(player.x), Math.round(player.y), perlin, slidersVals, heightCache);
    const pWz = (pH - SEA_LEVEL_ABS) * elevScale;

    // Use a simplified projection for the tile drawing logic
    const proj = (wx, wy, wz = 0) => worldToScreenIso(wx - player.x, wy - player.y, wz - pWz, camX, camY);


    // --- outline styles for isometric view ---
    const OUTLINE_WIDTH = Math.max(1, pixelScale * 0.12);
    const OUTLINE_TOP = 'rgba(0,0,0,0.18)';
    const OUTLINE_SIDE = 'rgba(0,0,0,0.25)';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;
    const tilesAcross = Math.ceil(vw / tw) + 4;
    const tilesDown = Math.ceil(vh / th) + 6;
    const startX = Math.floor(player.x - tilesAcross);
    const endX = Math.ceil(player.x + tilesAcross);
    const startY = Math.floor(player.y - tilesDown);
    const endY = Math.ceil(player.y + tilesDown);

    for (let wy = startY; wy <= endY; wy += CHUNK_SIZE) {
        for (let wx = startX; wx <= endX; wx += CHUNK_SIZE) {
            const cx = Math.floor(wx / CHUNK_SIZE), cy = Math.floor(wy / CHUNK_SIZE);
            const key = `${cx},${cy}`;
            if (!chunkCache.has(key)) {
                generateChunkData(cx, cy, slidersVals, sunVector, seed);
            }
        }
    }

    const allVisibleTiles = [];
    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) allVisibleTiles.push({x, y});
    }
    allVisibleTiles.sort((a, b) => (a.x + a.y) - (b.x + b.y));

    const countsByIndex = new Uint32Array(BIOME_NAME.length);
    hoverTile = null;
    let bestMatch = null;
    let bestDepth = -Infinity;

    lastVisibleTiles.sort((a, b) => (a.wx + a.wy) - (b.wx + b.wy) || a.wy - b.wy || a.wx - b.y);
    for (const tile of lastVisibleTiles) {
        const {wx, wy} = tile;
        if (pointInDiamond(mouse.x, mouse.y, tile.sx, tile.sy, tw, th)) {
            const depth = wx + wy;
            if (depth > bestDepth) {
                bestDepth = depth;
                bestMatch = tile;
            }
        }
    }
    if (bestMatch) {
        const chunk = getChunk(Math.floor(bestMatch.wx / CHUNK_SIZE), Math.floor(bestMatch.wy / CHUNK_SIZE));
        const idx = getBiomeIndexFromCache(bestMatch.wx, bestMatch.wy, chunk);
        const biomeName = idx >= 0 ? BIOME_NAME[idx] : getBiomeAtWorldCoords(bestMatch.wx, bestMatch.wy, perlin, slidersVals);
        const Hraw = getAbsoluteHeight(bestMatch.wx, bestMatch.wy, perlin, slidersVals);
        const isWater = isWaterLikeBiomeName(biomeName);
        const Htop = Hraw;
        hoverTile = {
            wx: bestMatch.wx,
            wy: bestMatch.wy,
            cx: bestMatch.sx,
            cy: bestMatch.sy,
            tw,
            th,
            biomeName,
            isWater,
            isRiver: /river/i.test(biomeName),
            isOcean: biomeName && biomeName.includes('Water'),
            Hraw: Hraw,
            Htop
        };
    }

    lastVisibleTiles = [];
    let visibleTrees = 0, visibleFish = 0;
    const objects = [];
    const allVisibleObjects = [];
    const drawnObjects = new Set();


    // --- Single pass to draw terrain and objects
    for (const t of allVisibleTiles) {
        const wx = t.x, wy = t.y;
        const idx = getBiomeIndexFromCache(wx, wy);
        const biomeName = idx >= 0 ? BIOME_NAME[idx] : getBiomeAtWorldCoords(wx, wy, perlin, slidersVals);
        const baseColor = idx >= 0 ? BIOME_COLOR_ARRAY[idx] : BIOME_COLORS[biomeName] || [255, 0, 0];

        const isWater = isWaterLikeBiomeName(biomeName);
        const Hraw = getAbsoluteHeight(wx, wy, perlin, slidersVals, heightCache);
        const isRiver = /river/i.test(biomeName);
        const isOcean = isWater && !isRiver;
        let riverHtop = SEA_LEVEL_ABS;
        if (isRiver) {
            let neighborLandHeights = [];
            const neighbors = [getAbsoluteHeight(wx - 1, wy, perlin, slidersVals, heightCache), getAbsoluteHeight(wx + 1, wy, perlin, slidersVals, heightCache), getAbsoluteHeight(wx, wy - 1, perlin, slidersVals, heightCache), getAbsoluteHeight(wx, wy + 1, perlin, slidersVals, heightCache)];

            for (const h of neighbors) {
                if (h > SEA_LEVEL_ABS) neighborLandHeights.push(h);
            }

            if (neighborLandHeights.length > 0) {
                const avgHeight = neighborLandHeights.reduce((a, b) => a + b) / neighborLandHeights.length;
                riverHtop = Math.min(Hraw, avgHeight - RIVER_SURFACE_DROP_UNITS);
            } else {
                riverHtop = Math.max(SEA_LEVEL_ABS, Hraw);
            }
        }
        const currentHtop = Hraw;
        const p_C = proj(wx, wy, (currentHtop - SEA_LEVEL_ABS) * elevScale);

        if (p_C.x < -tw || p_C.x > vw + tw || p_C.y < -th - 200 || p_C.y > vh + 200) continue;

        lastVisibleTiles.push({wx, wy, sx: p_C.x, sy: p_C.y});

        const lightness = isLightingEnabled ? getPixelLightness(wx, wy, currentHtop / 255, perlin.height, slidersVals, sunVector) : 1.0;
        const k = lightness;

        // Draw sides first to be occluded by tile tops
        const H_E_raw = getAbsoluteHeight(wx + 1, wy, perlin, slidersVals, heightCache);
        const H_S_raw = getAbsoluteHeight(wx, wy + 1, perlin, slidersVals, heightCache);
        const isWater_E = isWaterLikeBiomeName(getBiomeAtWorldCoords(wx + 1, wy, perlin, slidersVals));
        const isWater_S = isWaterLikeBiomeName(getBiomeAtWorldCoords(wx, wy + 1, perlin, slidersVals));
        const H_E = H_E_raw;
        const H_S = H_S_raw;
        const p_E = proj(wx + 1, wy, (H_E - SEA_LEVEL_ABS) * elevScale);
        const p_S = proj(wx, wy + 1, (H_S - SEA_LEVEL_ABS) * elevScale);

        const pT = {x: p_C.x, y: p_C.y - th / 2};
        const pR = {x: p_C.x + tw / 2, y: p_C.y};
        const pB = {x: p_C.x, y: p_C.y + th / 2};
        const pL = {x: p_C.x - tw / 2, y: p_C.y};


// LEFT/BOTTOM face (South → uses H_S)
        if (currentHtop > H_S) {
            const leftFill = `rgb(${Math.round(baseColor[0] * k)}, ${Math.round(baseColor[1] * k)}, ${Math.round(baseColor[2] * k)})`;
            ctx.fillStyle = leftFill;
            ctx.beginPath();
            const dh = (currentHtop - H_S) * elevScale;
            const EOL = 1; // tiny overlap into the top to hide hairlines
            // top edge follows the diamond edge: pL → pB
            ctx.moveTo(pL.x, pL.y - EOL);
            ctx.lineTo(pB.x, pB.y - EOL);
            // drop by dh
            ctx.lineTo(pB.x, pB.y + dh);
            ctx.lineTo(pL.x, pL.y + dh);
            ctx.closePath();
            ctx.fill();
            // outline left and bottom edges
            ctx.save();
            ctx.lineWidth = OUTLINE_WIDTH;
            ctx.strokeStyle = OUTLINE_SIDE;
            ctx.beginPath();
            // left vertical edge
            ctx.moveTo(pL.x, pL.y);
            ctx.lineTo(pL.x, pL.y + dh);
            // bottom edge
            ctx.moveTo(pL.x, pL.y + dh);
            ctx.lineTo(pB.x, pB.y + dh);
            ctx.stroke();
            ctx.restore();
        }

// RIGHT face (East → uses H_E)
        if (currentHtop > H_E) {
            const rightFill = `rgb(${Math.round(baseColor[0] * k)}, ${Math.round(baseColor[1] * k)}, ${Math.round(baseColor[2] * k)})`;
            ctx.fillStyle = rightFill;
            ctx.beginPath();
            const dh = (currentHtop - H_E) * elevScale;
            const EOL = 1;
            // top edge follows the diamond edge: pR → pB
            ctx.moveTo(pR.x, pR.y - EOL);
            ctx.lineTo(pB.x, pB.y - EOL);
            // drop by dh
            ctx.lineTo(pB.x, pB.y + dh);
            ctx.lineTo(pR.x, pR.y + dh);
            ctx.closePath();
            ctx.fill();
            // outline right and bottom edges
            ctx.save();
            ctx.lineWidth = OUTLINE_WIDTH;
            ctx.strokeStyle = OUTLINE_SIDE;
            ctx.beginPath();
            // right vertical edge
            ctx.moveTo(pR.x, pR.y);
            ctx.lineTo(pR.x, pR.y + dh);
            // bottom edge
            ctx.moveTo(pB.x, pB.y + dh);
            ctx.lineTo(pR.x, pR.y + dh);
            ctx.stroke();
            ctx.restore();
        }


        // Draw the top face
        if (isWater) {
            const depthUnits = isOcean ? Math.max(0, SEA_LEVEL_ABS - Hraw) : RIVER_WATER_DEPTH_UNITS;
            const depth01 = Math.max(0, Math.min(1, depthUnits / 128));
            fillIsoDiamondWater(ctx, p_C.x, p_C.y, tw, th, baseColor, depth01, lightness, sunVector, (wx * 73 + wy * 91) * 0.001);
        } else {
            const topFill = `rgb(${Math.round(baseColor[0] * k)},
                              ${Math.round(baseColor[1] * k)},
                              ${Math.round(baseColor[2] * k)})`;
            fillIsoDiamond(ctx, p_C.x, p_C.y, tw, th, topFill);
            // outline top diamond
            ctx.lineWidth = OUTLINE_WIDTH;
            ctx.strokeStyle = OUTLINE_TOP;
            pathIsoDiamond(ctx, p_C.x, p_C.y, tw, th);
            ctx.stroke();
        }

        // --- Draw object on this tile
        const chunk = getChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wy / CHUNK_SIZE));
        if (chunk && chunk.objects) {
            for (const obj of chunk.objects) {
                if (obj.x === wx && obj.y === wy) {
                    // Check if object is already drawn to avoid duplicates on chunk boundaries
                    if (!drawnObjects.has(obj)) {
                        allVisibleObjects.push(obj);
                        drawnObjects.add(obj);
                    }
                }
            }
        }


        if (showTileHeights) {
            const label = String(Math.round(currentHtop));
            const labelX = (p_C.x | 0);
            const labelY = (p_C.y | 0);
            const labelPx = Math.max(8, Math.min(12, (th * 0.65) | 0));
            drawCenteredLabel(ctx, labelX, labelY, label, labelPx);
        }

        if (selectedTile && selectedTile.x === wx && selectedTile.y === wy) {
            ctx.save();
            ctx.lineWidth = Math.max(1.5, pixelScale * 0.1);
            ctx.strokeStyle = 'rgba(255,255,0,0.95)';
            ctx.fillStyle = 'rgba(255,255,0,0.15)';
            pathIsoDiamond(ctx, p_C.x, p_C.y, tw, th);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }

        if (idx >= 0) countsByIndex[idx]++;
    }

    // Sort all objects for correct rendering order
    allVisibleObjects.sort((a, b) => {
        const a_depth = a.x + a.y + (a.type === 'tree' ? a.height * 0.5 : 0);
        const b_depth = b.x + b.y + (b.type === 'tree' ? b.height * 0.5 : 0);
        return a_depth - b_depth;
    });

    // Pass 2: Draw all sorted objects
    for (const obj of allVisibleObjects) {
        // Match terrain’s conversion: height units → pixels
        const objHeightUnits = getAbsoluteHeight(obj.x, obj.y, perlin, slidersVals) - SEA_LEVEL_ABS;
        let objWz = objHeightUnits * elevScale;
        // A simple example for a cube-like house
        if (obj.emoji === '🏠') {
            const size = 1.0;
            const color = [200, 150, 100]; // a nice house color
            drawIsoBox(ctx, obj.x, obj.y, objWz, size, color, proj, isLightingEnabled ? getPixelLightness(obj.x, obj.y, objWz, perlin.height, slidersVals, sunVector) : 1.0);
            continue;
        } else if (obj.emoji === '🛖') { // another example
            const size = 1.0;
            const color = [150, 120, 80];
            drawIsoBox(ctx, obj.x, obj.y, objWz, size, color, proj, isLightingEnabled ? getPixelLightness(obj.x, obj.y, objWz, perlin.height, slidersVals, sunVector) : 1.0);
            continue;
        }

        const p = proj(obj.x, obj.y, objWz);

        if (obj.type === 'tree') {
            visibleTrees++;
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.ellipse(p.x, p.y + pixelScale * 0.25, pixelScale * 0.45, pixelScale * 0.22, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            ctx.font = `${Math.max(10, pixelScale * (obj.height ? 0.8 + obj.height * 0.12 : 1.1))}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(obj.emoji, p.x, p.y);
        } else if (obj.type === 'fish' || obj.type === 'float') {
            visibleFish++;
            ctx.save();
            ctx.globalAlpha = (obj.type === 'fish') ? 0.75 : 0.9;
            ctx.font = `${Math.max(10, pixelScale * 0.9)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(obj.emoji, p.x, p.y);
            ctx.restore();
        } else if (obj.type === 'npc') {
            renderNpc(obj, p.x - pixelScale / 2, p.y - pixelScale / 2, pixelScale, ctx);
            const d = Math.hypot(obj.x - player.x, obj.y - player.y);
            const canTrade = (typeof invHasAll === 'function') ? invHasAll((obj.offer && obj.offer.give) || {}) : true;
            const isTrader = (obj.role === 'trader') || !!obj.offer;
            if (isTrader && d < 1.6 && canTrade) {
                if (!nearbyTradeNpc || d < nearbyTradeNpc._d) {
                    nearbyTradeNpc = {
                        npc: obj, sx: p.x, sy: p.y - pixelScale * 0.9, _d: d
                    };
                }
            }
        }
    }


    // --- Tile highlight & info (rendered on top of terrain) ----
    if (hoverTile) {
        const {cx, cy, tw, th} = hoverTile;
        ctx.save();
        ctx.lineWidth = Math.max(1, pixelScale * 0.12);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255,255,0,0.85)';
        pathIsoDiamond(ctx, cx, cy, tw, th);
        ctx.stroke();
        ctx.globalAlpha = 0.08;
        ctx.setLineDash([]);
        ctx.fillStyle = 'yellow';
        ctx.fill();
        ctx.restore();
    }

    // Fixed selection ring
    if (selectedTile && lastVisibleTiles.some(t => t.wx === selectedTile.x && t.wy === selectedTile.y)) {
        const p = proj(selectedTile.x, selectedTile.y, (selectedTile.Htop - SEA_LEVEL_ABS) * elevScale);
        const {cx, cy} = p;
        ctx.save();
        ctx.lineWidth = Math.max(1, pixelScale * 0.16);
        ctx.strokeStyle = 'rgba(255,180,0,0.95)';
        pathIsoDiamond(ctx, cx, cy, tw, th);
        ctx.stroke();
        ctx.restore();
    }

    // Info panel DOM update
    let info = document.getElementById('tileInfo');
    if (!info) {
        info = document.createElement('div');
        info.id = 'tileInfo';
        info.style.position = 'absolute';
        info.style.right = '12px';
        info.style.top = '12px';
        info.style.padding = '8px 10px';
        info.style.background = 'rgba(0,0,0,0.55)';
        info.style.color = '#fff';
        info.style.font = '12px/1.35 sans-serif';
        info.style.border = '1px solid rgba(255,255,255,0.15)';
        info.style.borderRadius = '6px';
        info.style.pointerEvents = 'none';
        document.body.appendChild(info);
    }
    const selTile = selectedTile || hoverTile;
    if (selTile) {
        const playerX = Math.round(player.x);
        const playerY = Math.round(player.y);
        const playerSpeed = getSliderValues().playerSpeed;
        const currentBiome = getBiomeAtWorldCoords(player.x, player.y, perlin, slidersVals);
        const speedModifier = getMovementSpeedModifier(currentBiome);
        const cameraX = Math.round(player.x);
        const cameraY = Math.round(player.y);

        info.innerHTML = `<b>Tile</b> ${selTile.wx}, ${selTile.wy}<br>` + `Biome: ${selTile.biomeName || '—'}<br>` + `Top: ${Math.round(selTile.Htop) ?? '—'} | Raw: ${Math.round(selTile.Hraw) ?? '—'}<br>` + `Water: ${selTile.isWater ? (selTile.isOcean ? 'Ocean' : (selTile.isRiver ? 'River' : 'Yes')) : 'No'}<br>` + `---<br>` + `<b>Player Pos</b> ${playerX}, ${playerY}<br>` + `<b>Camera Pos</b> ${cameraX}, ${cameraY}<br>` + `<b>Player Speed</b> ${playerSpeed} base | ${speedModifier}x mod.`;
        info.style.display = 'block';
    } else {
        info.style.display = 'none';
    }

    // -------- Sun/Moon + night tint --------
    if (isLightingEnabled) {
        const centerX = canvas.width / 2, horizonY = canvas.height / 2 + 50;
        const skyPathRadius = Math.min(canvas.width, canvas.height) * 0.7;
        const sunX = centerX - Math.cos(dayAngle) * skyPathRadius;
        const sunY = horizonY - Math.sin(dayAngle) * skyPathRadius;
        const moonX = centerX + Math.cos(dayAngle) * skyPathRadius;
        const moonY = horizonY - Math.sin(dayAngle) * skyPathRadius;

        if (sunY < horizonY + 20) {
            ctx.fillStyle = 'rgba(255, 255, 150, 0.9)';
            ctx.beginPath();
            ctx.arc(sunX, sunY, 30, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (moonY < horizonY + 20) {
            ctx.fillStyle = 'rgba(230, 230, 240, 0.8)';
            ctx.beginPath();
            ctx.arc(moonX, moonY, 25, 0, 2 * Math.PI);
            ctx.fill();
        }

        const overlayAlpha = (1 - timeInfo.lightLevel) * 0.75, tint = timeInfo.tint;
        ctx.fillStyle = `rgba(${tint[0] * 30}, ${tint[1] * 40}, ${tint[2] * 80}, ${overlayAlpha})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (nearbyTradeNpc) {
        const offerText = (typeof formatOffer === 'function' && nearbyTradeNpc.npc.offer) ? formatOffer(nearbyTradeNpc.npc.offer) : 'Trade';
        const txt = `E: ${offerText}`;
        ctx.save();
        ctx.font = `${Math.max(10, pixelScale * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(txt).width + 12;
        const x = nearbyTradeNpc.sx, y = nearbyTradeNpc.sy;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - w / 2, y - 18, w, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, x, y - 4);
        ctx.restore();
    }

    playerDiv.style.left = `${vw / 2}px`;
    playerDiv.style.top = `${vh / 2}px`;

    const visibleBiomeCounts = {};
    for (let i = 0; i < countsByIndex.length; i++) {
        const c = countsByIndex[i];
        if (c) visibleBiomeCounts[BIOME_NAME[i]] = c;
    }

    return {visibleTrees, visibleFish, visibleBiomeCounts};
}

function updateChunkObjects(chunk, deltaTime, timeInfo, perlin, sliders) {
    const fishDayFactor = Math.max(0.4, timeInfo.lightLevel);
    const lightLevel = timeInfo.lightLevel;

    if (deltaTime > 0 && chunk.objects && chunk.objects.length) {
        for (let i = 0; i < chunk.objects.length; i++) {
            const obj = chunk.objects[i];
            if (obj.type === 'fish') {
                const speed = (obj.speed || 1.2) * fishDayFactor;
                obj.phase = (obj.phase || 0) + deltaTime * 2.0;

                const wiggleX = Math.cos(obj.phase) * 0.15;
                const wiggleY = Math.sin(obj.phase) * 0.15;

                const toHomeX = (obj.homeX - obj.x), toHomeY = (obj.homeY - obj.y);
                const distHome = Math.hypot(toHomeX, toHomeY) + 1e-6;
                const homePull = Math.min(0.8, distHome * 0.02);
                const nHomeX = toHomeX / distHome, nHomeY = toHomeY / distHome;

                const dPX = (player.x - obj.x), dPY = (player.y - obj.y);
                const dToPlayer = Math.hypot(dPX, dPY) + 1e-6;
                let fleeX = 0, fleeY = 0;
                if (dToPlayer < 10) {
                    fleeX = -(dPX / dToPlayer) * 0.8;
                    fleeY = -(dPY / dToPlayer) * 0.8;
                }

                const flow = getRiverFlowAt(obj.x, obj.y, chunk);
                const flowX = flow.x * 2.2, flowY = flow.y * 2.2;

                let vx = (obj.vx || 0) + wiggleX + nHomeX * homePull + fleeX + flowX * deltaTime;
                let vy = (obj.vy || 0) + wiggleY + nHomeY * homePull + fleeY + flowY * deltaTime;
                const vm = Math.hypot(vx, vy) || 1e-6;
                vx /= vm;
                vy /= vm;

                const step = speed * deltaTime;
                let nx = obj.x + vx * step, ny = obj.y + vy * step;

                if (!isWaterLikeAt(Math.round(nx), Math.round(ny), perlin, sliders)) {
                    vx = -vx * 0.4 + nHomeX * 0.8;
                    vy = -vy * 0.4 + nHomeY * 0.8;
                    const m2 = Math.hypot(vx, vy) || 1e-6;
                    vx /= m2;
                    vy /= m2;
                    nx = obj.x + vx * step * 0.6;
                    ny = obj.y + vy * step * 0.6;
                }

                obj.x = nx;
                obj.y = ny;
                obj.vx = vx;
                obj.vy = vy;
            } else if (obj.type === 'float') {
                const flow = getRiverFlowAt(obj.x, obj.y, chunk);
                const wiggleX = Math.cos((obj.phase = (obj.phase || 0) + deltaTime)) * 0.05;
                const wiggleY = Math.sin(obj.phase * 1.3) * 0.05;

                const speed = 1.0;
                let vx = wiggleX * (1 - obj.drag) + (flow.x || 0) * (1.3 + (obj.kind === 'log' ? 0.2 : 0)) + (obj.vx || 0) * 0.1;
                let vy = wiggleY * (1 - obj.drag) + (flow.y || 0) * (1.3 + (obj.kind === 'log' ? 0.2 : 0)) + (obj.vy || 0) * 0.1;

                const step = speed * deltaTime;
                let nx = obj.x + vx * step, ny = obj.y + vy * step;

                if (!isWaterLikeAt(Math.round(nx), Math.round(ny), perlin, sliders)) {
                    vx = -vx * 0.25;
                    vy = -vy * 0.25;
                    nx = obj.x + vx * step * 0.5;
                    ny = obj.y + vy * step * 0.5;
                }
                obj.vx = vx;
                obj.vy = vy;
                obj.x = nx;
                obj.y = ny;
            } else if (obj.type === 'npc') {
                updateNpc(obj, deltaTime, chunk, lightLevel, perlin, sliders);
            }
        }
    }
}

function drawWorld(deltaTime = 0) {
    if (isGenerating || !perlin) return {visibleTrees: 0, visibleFish: 0};
    if (isDebugViewActive) {
        return drawDebugSpawnsView();
    }
    // Early branch to iso mode
    if (renderMode === 'isometric') {
        return drawIsoWorld();
    }
    nearbyTradeNpc = null;

    const sliders = getSliderValues();
    const {pixelScale} = sliders;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;

    canvas.width = vw;
    canvas.height = vh;
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;

    const viewTilesX = vw / pixelScale, viewTilesY = vh / pixelScale;
    const startTileX = player.x - viewTilesX / 2, endTileX = player.x + viewTilesX / 2;
    const startTileY = player.y - viewTilesY / 2, endTileY = player.y + viewTilesY / 2;
    const startChunkX = Math.floor(startTileX / CHUNK_SIZE), endChunkX = Math.ceil(endTileX / CHUNK_SIZE);
    const startChunkY = Math.floor(startTileY / CHUNK_SIZE), endChunkY = Math.ceil(endTileY / CHUNK_SIZE);

    let visibleTrees = 0, visibleFish = 0;
    const countsByIndex = new Uint32Array(BIOME_NAME.length);

    const dayAngle = (timeOfDay - 0.25) * 2 * Math.PI;

    const sunVector = getSunVectorFromSlider();

    const seed = parseInt(seedInput.value) || 0;
    const timeInfo = getTimeOfDayInfo(timeOfDay);

    // --- MOUSE HOVER TILE FOR TOP-DOWN ---
    // Recalculate hoverTile based on mouse position
    const mouseWorldX = player.x - viewTilesX / 2 + mouse.x / pixelScale;
    const mouseWorldY = player.y - viewTilesY / 2 + mouse.y / pixelScale;
    hoverTile = {
        wx: Math.floor(mouseWorldX),
        wy: Math.floor(mouseWorldY),
        biomeName: getBiomeAtWorldCoords(mouseWorldX, mouseWorldY, perlin, sliders),
        isWater: isWaterLikeAt(Math.floor(mouseWorldX), Math.floor(mouseWorldY), perlin, sliders),
        Htop: getAbsoluteHeight(mouseWorldX, mouseWorldY, perlin, sliders),
        Hraw: getHeightValueAtWorldCoords(mouseWorldX, mouseWorldY, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel)
    };
    // Highlight the hovered tile
    if (hoverTile) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = 'yellow';
        const hx = (hoverTile.wx - startTileX) * pixelScale;
        const hy = (hoverTile.wy - startTileY) * pixelScale;
        ctx.fillRect(hx, hy, pixelScale, pixelScale);
        ctx.restore();
    }

    // Pass 1: Draw chunks
    const drawList = [];
    const allVisibleObjects = [];

    for (let cy = startChunkY; cy <= endChunkY; cy++) {
        for (let cx = startChunkX; cx <= endChunkX; cx++) {
            const key = `${cx},${cy}`;
            let chunk = chunkCache.get(key);
            if (!chunk) {
                // Generate chunks on demand, without a per-frame limit
                generateChunkData(cx, cy, sliders, sunVector, seed);
                chunk = chunkCache.get(key);
            }
            if (!chunk) continue;

            updateChunkObjects(chunk, deltaTime, timeInfo, perlin, sliders);

            const screenX = Math.round((cx * CHUNK_SIZE - startTileX) * pixelScale);
            const screenY = Math.round((cy * CHUNK_SIZE - startTileY) * pixelScale);
            ctx.drawImage(chunk.canvas, screenX, screenY, CHUNK_SIZE * pixelScale, CHUNK_SIZE * pixelScale);

            drawList.push({chunk, screenX, screenY, cx, cy});
            if (chunk.objects) {
                allVisibleObjects.push(...chunk.objects);
            }
        }
    }

    // Sort all objects for correct rendering order
    allVisibleObjects.sort((a, b) => {
        // Correct sorting for top-down view: sort by y, then by x for a stable sort
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
    });

    // Pass 2: Draw all sorted objects
    for (const obj of allVisibleObjects) {
        const objScreenX = (obj.x - startTileX) * pixelScale;
        const objScreenY = (obj.y - startTileY) * pixelScale;
        if (objScreenX < -pixelScale || objScreenX > vw || objScreenY < -pixelScale || objScreenY > vh) continue;

        if (obj.type === 'tree') {
            visibleTrees++;
            if (!obj._fontCache || obj._fontCache.scale !== pixelScale) {
                const px = Math.max(8, Math.round(pixelScale * 1.2 * (obj.height * 0.5)));
                obj._fontCache = {scale: pixelScale, px};
            }

            ctx.font = `${obj._fontCache.px}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const tileLeft = Math.floor(objScreenX);
            const tileTop = Math.floor(objScreenY);
            const tileBottom = tileTop + pixelScale;

            const basePad = Math.max(1, Math.floor(pixelScale * 0.08));
            const jxMax = (pixelScale / 2) - basePad;
            const jx = clamp((obj.offsetX || 0) * pixelScale, -jxMax, jxMax);

            const windMul = (Weather.type === '🌧️') ? 1.0 : 0.55;
            const phase = frameTick * 0.05 + (obj.swayPhase || 0);
            const tipShiftMax = Math.min(pixelScale * 0.35, 4) * windMul * (0.8 + 0.1 * (obj.height || 1));
            const tipShift = Math.sin(phase) * tipShiftMax;
            const shearX = tipShift / obj._fontCache.px;

            const baseX = tileLeft + Math.floor(pixelScale / 2 + jx);
            const baseY = tileBottom - basePad;

            ctx.save();
            ctx.translate(baseX, baseY);
            ctx.rotate(tipShift * 0.01);
            ctx.transform(1, 0, shearX, 1, 0, 0);

            ctx.fillText(obj.emoji, 0, 0);
            ctx.restore();
        } else if (obj.type === 'fish') {
            visibleFish++;
            ctx.globalAlpha = 0.6 + Math.sin(frameTick / 12 + obj.x) * 0.3;
            ctx.font = `${pixelScale * 0.8}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(obj.emoji, objScreenX + pixelScale / 2, objScreenY + pixelScale / 2);
            ctx.globalAlpha = 1.0;
        } else if (obj.type === 'float') {
            visibleFish++;
            ctx.globalAlpha = 0.85;
            ctx.font = `${Math.max(10, pixelScale * 0.8)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(obj.emoji, objScreenX + pixelScale / 2, objScreenY + pixelScale / 2);
            ctx.globalAlpha = 1.0;
        } else if (obj.type === 'npc') {
            renderNpc(obj, objScreenX, objScreenY, pixelScale, ctx);
            const d = Math.hypot(obj.x - player.x, obj.y - player.y);
            const canTrade = (typeof invHasAll === 'function') ? invHasAll((obj.offer && obj.offer.give) || {}) : true;
            const isTrader = (obj.role === 'trader') || !!obj.offer;
            if (isTrader && d < 1.6 && canTrade) {
                if (!nearbyTradeNpc || d < nearbyTradeNpc._d) {
                    nearbyTradeNpc = {
                        npc: obj, sx: objScreenX + pixelScale / 2, sy: objScreenY - pixelScale * 0.2, _d: d
                    };
                }
            }
        }
        if (showSpawnOverlay) {
            ctx.save();
            ctx.lineWidth = 2;
            ctx.strokeStyle = (obj.type === 'fish') ? '#00FFFF' : '#00FF66';
            ctx.strokeRect(Math.floor(objScreenX) + 1, Math.floor(objScreenY) + 1, Math.max(2, pixelScale - 2), Math.max(2, pixelScale - 2));
            ctx.restore();
        }
    }


    if (showTileHeights) {
        ctx.save();
        ctx.font = `${Math.max(9, pixelScale * 0.8)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let ty = Math.floor(startTileY); ty < Math.ceil(endTileY); ty++) {
            for (let tx = Math.floor(startTileX); tx < Math.ceil(endTileX); tx++) {
                const H = getAbsoluteHeight(tx, ty, perlin, sliders); // 0..255
                const sx = (tx - startTileX) * pixelScale + pixelScale * 0.5;
                const sy = (ty - startTileY) * pixelScale + pixelScale * 0.45;
                // outline for readability
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.strokeText(String(Math.round(H)), sx, sy);
                ctx.fillStyle = 'white';
                ctx.fillText(String(Math.round(H)), sx, sy);
            }
        }
        ctx.restore();
    }

    // Biome counts (legend) using cached chunk biomes (no perlin)
    for (const {cx, cy} of drawList) {
        const localStartX = Math.max(0, Math.floor(startTileX - cx * CHUNK_SIZE));
        const localEndX = Math.min(CHUNK_SIZE, Math.ceil(endTileX - cx * CHUNK_SIZE));
        const localStartY = Math.max(0, Math.floor(startTileY - cy * CHUNK_SIZE));
        const localEndY = Math.min(CHUNK_SIZE, Math.ceil(endTileY - cy * CHUNK_SIZE));

        const chunk = getChunk(cx, cy);
        if (!chunk || !chunk.biomeIdx) continue;
        const stride = Math.max(1, Math.floor(12 / Math.max(1, pixelScale)));
        for (let y = localStartY; y < localEndY; y += stride) {
            const rowOff = y * CHUNK_SIZE;
            for (let x = localStartX; x < localEndX; x += stride) {
                countsByIndex[chunk.biomeIdx[rowOff + x]]++;
            }
        }
    }

    if (isContourOverlayActive) {
        const contourInterval = 20, majorContourInterval = 100;
        const contourColor = 'rgba(0, 0, 0, 0.4)', majorContourColor = 'rgba(0, 0, 0, 0.7)',
            labelColor = 'rgba(255, 255, 255, 0.9)';
        const heightCache = new Map();
        const labelInterval = Math.max(10, Math.round(120 / pixelScale));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'black';
        ctx.shadowBlur = 2;
        for (let y = Math.floor(startTileY); y < endTileY; y++) {
            for (let x = Math.floor(startTileX); x < endTileX; x++) {
                const h1 = getAbsoluteHeight(x, y, perlin, sliders, heightCache);
                const h2 = getAbsoluteHeight(x + 1, y, perlin, sliders, heightCache);
                const h3 = getAbsoluteHeight(x, y + 1, perlin, sliders, heightCache); // Corrected: h3 was missing from the local scope
                let minH = Math.min(h1, h2), maxH = Math.max(h1, h3);
                let level = Math.ceil(minH / contourInterval) * contourInterval;
                while (level < maxH) {
                    const isMajor = level % majorContourInterval === 0;
                    ctx.strokeStyle = isMajor ? majorContourColor : contourColor;
                    ctx.lineWidth = isMajor ? 2 : 1.5;
                    const sx = (x + 1 - startTileX) * pixelScale, sy = (y - startTileY) * pixelScale;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo(sx, sy + pixelScale);
                    ctx.stroke();
                    if (y % labelInterval === 0) {
                        ctx.font = `bold ${isMajor ? Math.max(9, pixelScale / 1.4) : Math.max(7, pixelScale / 1.6)}px sans-serif`;
                        ctx.fillStyle = labelColor;
                        ctx.fillText(level, sx + 3, sy + pixelScale / 2);
                    }
                    level += contourInterval;
                }

                minH = Math.min(h1, h3);
                maxH = Math.max(h1, h3);
                level = Math.ceil(minH / contourInterval) * contourInterval;
                while (level < maxH) {
                    const isMajor = level % majorContourInterval === 0;
                    ctx.strokeStyle = isMajor ? majorContourColor : contourColor;
                    ctx.lineWidth = isMajor ? 2 : 1.5;
                    const sx = (x - startTileX) * pixelScale, sy = (y + 1 - startTileY) * pixelScale;
                    ctx.beginPath();
                    ctx.moveTo(sx, sy);
                    ctx.lineTo(sx + pixelScale, sy);
                    ctx.stroke();
                    if (x % labelInterval === 0) {
                        ctx.font = `bold ${isMajor ? Math.max(9, pixelScale / 1.4) : Math.max(7, pixelScale / 1.6)}px sans-serif`;
                        ctx.fillStyle = labelColor;
                        ctx.fillText(level, sx + pixelScale / 2, sy + 3);
                    }
                    level += contourInterval;
                }
            }
        }
        ctx.shadowBlur = 0;
    }

    // Pass 3: Particles & Weather
    // Particles
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.update();
        const pScreenX = (p.x - startTileX) * pixelScale, pScreenY = (p.y - startTileY) * pixelScale;
        ctx.fillRect(pScreenX, pScreenY, p.size, p.size);
        if (p.life <= 0) particles.splice(i, 1);
    }
    // Weather
    if (Weather.type === '🌧️') {
        ctx.fillStyle = 'rgba(60,80,120,0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = 'rgba(200, 200, 255, 0.9)';
        const n = Math.max(60, Math.min(140, Math.floor(canvas.width * canvas.height / 20000)));
        for (let i = 0; i < n; i++) {
            const rx = (i * 97 + frameTick * 2) % canvas.width;
            const ry = (i * 53 + frameTick * 3) % canvas.height;
            ctx.fillRect(rx, ry, 1, 8);
        }
        ctx.globalAlpha = 1.0;
    } else if (Weather.type === '❄️') {
        ctx.fillStyle = 'rgba(230,230,255,0.06)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const n = Math.max(40, Math.min(110, Math.floor(canvas.width * canvas.height / 30000)));
        for (let i = 0; i < n; i++) {
            const rx = (i * 137 + Math.sin(frameTick / 30 + i) * 30 + canvas.width) % canvas.width;
            const ry = (i * 71 + frameTick * 2) % canvas.height;
            ctx.fillRect(rx, ry, 2, 2);
        }
        ctx.globalAlpha = 1.0;
    }

    // Pass 4: Night overlay
    // Day/Night overlay & bodies (wrap with lighting)
    if (isLightingEnabled) {
        const centerX = canvas.width / 2, horizonY = canvas.height / 2 + 50;
        const skyPathRadius = Math.min(canvas.width, canvas.height) * 0.7;
        const sunX = centerX - Math.cos(dayAngle) * skyPathRadius;
        const sunY = horizonY - Math.sin(dayAngle) * skyPathRadius;
        const moonX = centerX + Math.cos(dayAngle) * skyPathRadius;
        const moonY = horizonY + Math.sin(dayAngle) * skyPathRadius;
        if (sunY < horizonY + 20) {
            ctx.fillStyle = 'rgba(255, 255, 150, 0.9)';
            ctx.beginPath();
            ctx.arc(sunX, sunY, 30, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (moonY < horizonY + 20) {
            ctx.fillStyle = 'rgba(230, 230, 240, 0.8)';
            ctx.beginPath();
            ctx.arc(moonX, moonY, 25, 0, 2 * Math.PI);
            ctx.fill();
        }

        const overlayAlpha = (1 - timeInfo.lightLevel) * 0.75, tint = timeInfo.tint;
        ctx.fillStyle = `rgba(${tint[0] * 30}, ${tint[1] * 40}, ${tint[2] * 80}, ${overlayAlpha})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Pass 5: Fireflies & Trade prompt
    // --- Fireflies: update + render (glowing, pulsing, night-only) ---
    if (timeInfo.lightLevel < FIREFLY_NIGHT_LIGHT_LEVEL) {
        for (const {chunk} of drawList) {
            const anchors = chunk.objects ? chunk.objects.filter(o => o.type === 'tree') : [];
            if (anchors.length === 0) continue;

            if (!chunk.fireflies) chunk.fireflies = [];

            const target = Math.min(FIREFLY_MAX_PER_CHUNK, Math.max(1, Math.floor(anchors.length * 0.4)));

            while (chunk.fireflies.length < target) {
                const t = anchors[(Math.random() * anchors.length) | 0];
                const jitter = () => (Math.random() - 0.5) * 2.0;
                chunk.fireflies.push({
                    x: t.x + jitter(),
                    y: t.y + jitter(),
                    homeX: t.x + jitter(),
                    homeY: t.y + jitter(),
                    phase: Math.random() * Math.PI * 2
                });
            }

            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (const f of chunk.fireflies) {
                f.phase += deltaTime * (1.2 + (Weather.type === '🌧️' ? 0.6 : 0));
                f.x += (Math.random() - 0.5) * 0.06;
                f.y += (Math.random() - 0.5) * 0.06;
                const toHomeX = f.homeX - f.x, toHomeY = f.homeY - f.y;
                f.x += toHomeX * 0.015;
                f.y += toHomeY * 0.015;

                const sx = (f.x - startTileX) * pixelScale;
                const sy = (f.y - startTileY) * pixelScale;

                const pulse = 0.5 + 0.5 * Math.sin(f.phase * 2.3);
                const flicker = 0.85 + 0.15 * Math.sin(f.phase * 17.0 + f.x);
                const alpha = 0.15 + 0.45 * pulse * flicker;

                if (sx < -10 || sy < -10 || sx > vw + 10 || sy > vh + 10) continue;

                const radius = Math.max(1.5, pixelScale * 0.6);
                const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius);
                g.addColorStop(0.0, `rgba(255,255,170,${alpha})`);
                g.addColorStop(0.6, `rgba(190,255,140,${alpha * 0.6})`);
                g.addColorStop(1.0, `rgba(190, 255, 140, 0)`);
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(sx, sy, radius, 0, Math.PI * 2);
                ctx.fill();

                ctx.globalAlpha = Math.min(0.9, alpha * 1.2);
                ctx.fillStyle = 'rgba(255,255,210,1)';
                ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);
                ctx.globalAlpha = 1.0;
            }
            ctx.restore();
        }
    } else {
        for (const {chunk} of drawList) {
            if (chunk.fireflies && chunk.fireflies.length) chunk.fireflies.length = 0;
        }
    }
    if (nearbyTradeNpc) {
        const offerText = (typeof formatOffer === 'function' && nearbyTradeNpc.npc.offer) ? formatOffer(nearbyTradeNpc.npc.offer) : 'Trade';
        const txt = `E: ${offerText}`;
        ctx.save();
        ctx.font = `${Math.max(10, pixelScale * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(txt).width + 12;
        const x = nearbyTradeNpc.sx, y = nearbyTradeNpc.sy;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - w / 2, y - 18, w, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, x, y - 4);
        ctx.restore();
    }


    // Keep player centered
    playerDiv.style.left = `${vw / 2}px`;
    playerDiv.style.top = `${vh / 2}px`;

    const visibleBiomeCounts = {};
    for (let i = 0; i < countsByIndex.length; i++) {
        const c = countsByIndex[i];
        if (c) visibleBiomeCounts[BIOME_NAME[i]] = c;
    }

    return {visibleTrees, visibleFish, visibleBiomeCounts};
}

// Replace your drawDebugNoiseView() with this:
function drawDebugSpawnsView() {
    const sliders = getSliderValues();
    const {pixelScale} = sliders;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;

    canvas.width = vw;
    canvas.height = vh;
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = false;

    let tilesAcross, tilesDown;
    let startTileX, endTileX, startTileY, endTileY;
    let centerX, centerY;
    let isIsometric = renderMode === 'isometric';

    if (isIsometric) {
        // Iso geometry
        const tw = iso.tileW(), th = iso.tileH();
        tilesAcross = Math.ceil(vw / tw) + 4;
        tilesDown = Math.ceil(vh / th) + 6;
        startTileX = Math.floor(player.x - tilesAcross);
        endTileX = Math.ceil(player.x + tilesAcross);
        startTileY = Math.floor(player.y - tilesDown);
        endTileY = Math.ceil(player.y + tilesDown);
        centerX = vw / 2;
        centerY = vh / 2;
    } else {
        tilesAcross = vw / pixelScale;
        tilesDown = vh / pixelScale;
        startTileX = player.x - tilesAcross / 2;
        endTileX = player.x + tilesAcross / 2;
        startTileY = player.y - tilesDown / 2;
        endTileY = player.y + tilesDown / 2;
    }


    // faint biome background (so markers have context)
    for (let wy = Math.floor(startTileY); wy < Math.ceil(endTileY); wy++) {
        for (let wx = Math.floor(startTileX); wx < Math.ceil(endTileX); wx++) {
            const biome = getBiomeAtWorldCoords(wx, wy, perlin, sliders);
            const [r, g, b] = BIOME_COLORS[biome] || [0, 0, 0];
            ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;

            if (isIsometric) {
                const H = getAbsoluteHeight(wx, wy, perlin, sliders, null);
                const Htop = H;
                const p = worldToScreenIso(wx - player.x, wy - player.y, (Htop - SEA_LEVEL_ABS) * iso.elev(), centerX, centerY);
                const tw = iso.tileW(), th = iso.tileH();
                fillIsoDiamond(ctx, p.x, p.y, tw, th, ctx.fillStyle);
            } else {
                ctx.fillRect((wx - startTileX) * pixelScale, (wy - startTileY) * pixelScale, pixelScale, pixelScale);
            }
        }
    }

    // ensure chunks exist, then overlay spawn markers
    const startChunkX = Math.floor(startTileX / CHUNK_SIZE), endChunkX = Math.ceil(endTileX / CHUNK_SIZE);
    const startChunkY = Math.floor(startTileY / CHUNK_SIZE), endChunkY = Math.ceil(endTileY / CHUNK_SIZE);

    let visibleTrees = 0, visibleFish = 0;
    const visibleBiomeCounts = {};

    const seed = parseInt(seedInput.value) || 0;
    const sunVector = getSunVectorFromSlider();

    for (let cy = startChunkY; cy < endChunkY; cy++) {
        for (let cx = startChunkX; cx < endChunkX; cx++) {
            const key = `${cx},${cy}`;
            if (!chunkCache.has(key)) generateChunkData(cx, cy, sliders, sunVector, seed);
            const chunk = chunkCache.get(key);
            if (!chunk) continue;

            for (const obj of chunk.objects) {
                let sx, sy;

                if (isIsometric) {
                    const Htop = getAbsoluteHeight(obj.x, obj.y, perlin, sliders, null);
                    const p = proj(obj.x, obj.y, (Htop - SEA_LEVEL_ABS) * iso.elev());
                    sx = p.x;
                    sy = p.y;
                } else {
                    sx = (obj.x - startTileX) * pixelScale + pixelScale / 2;
                    sy = (obj.y - startTileY) * pixelScale + pixelScale / 2;
                }

                if (obj.type === 'tree') {
                    visibleTrees++;
                    ctx.strokeStyle = 'rgba(34,197,94,0.9)'; // green
                    ctx.lineWidth = Math.max(1, pixelScale / 8);
                    ctx.beginPath();
                    ctx.arc(sx, sy, Math.max(2, pixelScale * 0.4), 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.font = `${pixelScale * 0.9}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = 'rgba(34,197,94,0.9)';
                    ctx.fillText('🌳', sx, sy - pixelScale * 0.1);
                } else if (obj.type === 'fish') {
                    visibleFish++;
                    ctx.strokeStyle = 'rgba(59,130,246,0.95)'; // blue
                    ctx.lineWidth = Math.max(1, pixelScale / 8);
                    ctx.strokeRect(sx - pixelScale * 0.5, sy - pixelScale * 0.5, pixelScale, pixelScale);
                    ctx.font = `${pixelScale * 0.8}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = 'rgba(59,130,246,0.95)';
                    ctx.fillText('🐟', sx, sy);
                }
            }
        }
    }

    // gather biome counts like the normal view (so legend still makes sense)
    for (let wy = Math.floor(startTileY); wy < Math.ceil(endY); wy++) {
        for (let wx = Math.floor(startTileX); wx < Math.ceil(endX); wx++) {
            const biome = getBiomeAtWorldCoords(wx, wy, perlin, sliders);
            visibleBiomeCounts[biome] = (visibleBiomeCounts[biome] || 0) + 1;
        }
    }

    // small on-canvas label
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(8, 8, 230, 48);
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.fillText(`DEBUG: spawns  🌳 ${visibleTrees}   🐟 ${visibleFish}`, 18, 26);
    ctx.fillText(`Press P to return`, 18, 44);

    // keep player centered
    playerDiv.style.left = `${vw / 2}px`;
    playerDiv.style.top = `${vh / 2}px`;

    return {visibleTrees, visibleFish, visibleBiomeCounts};
}

function drawMinimap() {
    const roundedPlayerX = Math.round(player.x), roundedPlayerY = Math.round(player.y);
    if (lastMinimapPlayerPos.x === roundedPlayerX && lastMinimapPlayerPos.y === roundedPlayerY) return;
    lastMinimapPlayerPos.x = roundedPlayerX;
    lastMinimapPlayerPos.y = roundedPlayerY;

    minimapCtx.clearRect(0, 0, 100, 100);
    minimapCtx.imageSmoothingEnabled = false;

    const MINIMAP_ZOOM = 4;
    const startX = roundedPlayerX - (minimapCanvas.width / 2) * MINIMAP_ZOOM;
    const startY = roundedPlayerY - (minimapCanvas.height / 2) * MINIMAP_ZOOM;

    for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
            const wx = startX + x * MINIMAP_ZOOM;
            const wy = startY + y * MINIMAP_ZOOM;

            const idx = getBiomeIndexFromCache(wx, wy);
            const color = (idx >= 0 ? BIOME_COLOR_ARRAY[idx] : [0, 0, 0]);
            minimapCtx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
            minimapCtx.fillRect(x, y, 1, 1);
        }
    }
}

// =================================================================================
// GAME STATE, HUD, AND LOOP
// =================================================================================
function showMessage(msg) {
    messages.push(msg);
    if (messages.length === 1) displayNextMessage();
}

function displayNextMessage() {
    if (messages.length === 0) return;
    DOMElements.messageText.textContent = messages[0];
    DOMElements.messageText.classList.remove('hidden');
    DOMElements.messageText.classList.add('bubble-effect');
    setTimeout(() => {
        DOMElements.messageText.classList.remove('bubble-effect');
        setTimeout(() => {
            DOMElements.messageText.classList.add('hidden');
            messages.shift();
            displayNextMessage();
        }, 2000);
    }, 500);
}

function updateHUD(currentBiome, visibleTrees = 0, visibleFish = 0, visibleBiomeCounts = {}) {
    const speedMod = getMovementSpeedModifier(currentBiome);
    DOMElements.speedModifierText.textContent = `${speedMod}x`;
    DOMElements.posText.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}`;
    DOMElements.biomeText.textContent = currentBiome;
    DOMElements.timeText.textContent = formatTime(timeOfDay);
    DOMElements.treeCountText.textContent = visibleTrees;
    DOMElements.fishCountText.textContent = visibleFish;

    if (DOMElements.fishLog) DOMElements.fishLog.innerHTML = '';
    const fishEntries = Object.keys(player.fishLog);
    if (fishEntries.length === 0) {
        if (DOMElements.fishLog) DOMElements.fishLog.innerHTML = `<p class="text-gray-500 text-xs italic">No fish discovered</p>`;
    } else {
        for (const fishName of fishEntries) {
            const fishInfo = FISH_TYPES[fishName];
            if (DOMElements.fishLog) DOMElements.fishLog.innerHTML += `<div class="flex justify-between items-center text-sm font-semibold"><span>${fishInfo.emoji} ${fishName.charAt(0).toUpperCase() + fishName.slice(1)}</span><span class="text-green-400">✓</span></div>`;
        }
    }

    const legendEntries = DOMElements.legendEntries;
    legendEntries.innerHTML = '';
    const sortedBiomes = Object.keys(visibleBiomeCounts).sort((a, b) => visibleBiomeCounts[b] - visibleBiomeCounts[a]);

    if (sortedBiomes.length === 0) {
        legendEntries.innerHTML = `<p class="text-gray-500 text-xs italic">No biomes in view</p>`;
    } else {
        for (const biomeName of sortedBiomes) {
            const count = visibleBiomeCounts[biomeName];
            const color = BIOME_COLORS[biomeName];
            const colorHex = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

            const entryHTML = `
                        <div class="flex justify-between items-center">
                            <div class="flex items-center gap-2">
                                <div class="w-4 h-4 rounded-sm border border-gray-600" style="background-color: ${colorHex};"></div>
                                <span>${biomeName.charAt(0).toUpperCase() + biomeName.slice(1)}</span>
                            </div>
                            <span class="font-mono text-gray-400">${count}</span>
                        </div>
                    `;
            legendEntries.innerHTML += entryHTML;
        }
    }


    if (DOMElements.keysText) DOMElements.keysText.textContent = Object.keys(keys).filter(k => keys[k]).map(k => k.toUpperCase()).join(', ') || '...';
    DOMElements.contourStatus.textContent = isContourOverlayActive ? 'On' : 'Off';
    DOMElements.contourStatus.classList.toggle('text-green-400', isContourOverlayActive);
    DOMElements.contourStatus.classList.toggle('text-red-400', !isContourOverlayActive);
}

// =================================================================================
// GAME LOOP AND INPUT HANDLING
// =================================================================================
function gameLoop(timestamp) {
    // keep the loop alive even if paused
    requestAnimationFrame(gameLoop);
    if (isGamePaused) return;

    // --- timing ---
    const deltaTime = (timestamp - lastFrameTime) / 1000 || 0;
    frameTick = (frameTick + 1) | 0;
    lastFrameTime = timestamp;

    // --- wind updates ---
    updateWind(deltaTime, windTime, perlin);

    // --- FPS & auto water-FX throttle ---
    if (timestamp - lastFpsUpdateTime > 100) {
        const fps = 1 / deltaTime;
        fpsHistory.push(fps);
        if (fpsHistory.length > 60) fpsHistory.shift();
        minFps = Math.min(minFps, fps);
        maxFps = Math.max(maxFps, fps);

        if (fps < 28 && waterFxQuality > 0) {
            waterFxQuality = 0;
        } else if (fps < 40 && waterFxQuality > 1) {
            waterFxQuality = 1;
        } else if (fps > 55 && waterFxQuality < 2) {
            waterFxQuality = 2;
        }
        DOMElements.currentFps.textContent = Math.round(fps);
        DOMElements.minFps.textContent = Math.round(minFps);
        DOMElements.maxFps.textContent = Math.round(maxFps);
        lastFpsUpdateTime = timestamp;
    }

    // --- simple weather director ---
    {
        const t = performance.now();
        if (t > Weather.until) {
            const r = Math.random();
            let next = 'clear';
            let dur = 30000 + Math.random() * 30000; // 30–60s
            if (season < 0.25) { // winter bias
                next = r < 0.40 ? '❄️' : (r < 0.65 ? '☀️' : '🌧️');
            } else if (season < 0.5) { // spring
                next = r < 0.45 ? '🌧️' : '☀️';
            } else if (season < 0.75) { // summer
                next = r < 0.15 ? '🌧️' : '☀️';
            } else { // autumn
                next = r < 0.35 ? '🌧️' : '☀️';
            }
            Weather.type = next;
            Weather.until = t + dur;
        }
    }

    const sliders = getSliderValues();

    // ================================
    // INPUT → MOVEMENT (screen → world)
    // ================================
    // 1) Build input in *screen* space (WASD = up/down/left/right on screen)
    let sx = 0, sy = 0;
    if (keys['w'] || keys['arrowup']) sy -= 1;
    if (keys['s'] || keys['arrowdown']) sy += 1;
    if (keys['a'] || keys['arrowleft']) sx -= 1;
    if (keys['d'] || keys['arrowright']) sx += 1;

    // normalize screen vector
    let sm = Math.hypot(sx, sy);
    if (sm > 0) {
        sx /= sm;
        sy /= sm;
    }

    // 2) Map to world axes depending on render mode
    // worldToScreenIso uses: Xs ∝ (wx - wy), Ys ∝ (wx + wy)
    // Invert it so screen motion feels natural in isometric view:
    let moveX, moveY;
    if (renderMode === 'isometric') {
        moveX = sx + sy; // Δwx
        moveY = sy - sx; // Δwy
        const m = Math.hypot(moveX, moveY) || 1;
        moveX /= m;
        moveY /= m;
    } else {
        // top-down: screen == world
        moveX = sx;
        moveY = sy;
    }

    // --- biome & movement modifiers ---
    const currentBiome = getBiomeAtWorldCoords(Math.round(player.x), Math.round(player.y), perlin, sliders);
    let speedModifier = getMovementSpeedModifier(currentBiome);

    // subtle weather nudge
    let weatherSpeedMul = 1.0;
    if (Weather.type === '🌧️') weatherSpeedMul = 0.95; else if (Weather.type === '❄️') weatherSpeedMul = 0.90;
    speedModifier *= weatherSpeedMul;

    // --- current drift if in river (unchanged logic) ---
    if (/river/i.test(currentBiome)) {
        const cx = Math.floor(player.x / CHUNK_SIZE), cy = Math.floor(player.y / CHUNK_SIZE);
        const chunk = chunkCache.get(`${cx},${cy}`);
        if (chunk && chunk.riverHints && chunk.riverHints.length) {
            const lx = Math.round(player.x - cx * CHUNK_SIZE);
            const ly = Math.round(player.y - cy * CHUNK_SIZE);
            let best = null, bestD = 2;
            for (const h of chunk.riverHints) {
                const d = Math.abs(h.x - lx) + Math.abs(h.y - ly);
                if (d < bestD) {
                    bestD = d;
                    best = h;
                    if (d === 0) break;
                }
            }
            if (best && best.flow) {
                player.x += best.flow.x * 6 * deltaTime;
                player.y += best.flow.y * 6 * deltaTime;
            }
        }
    }

    // --- apply player movement ---
    const step = sliders.playerSpeed * 10 * speedModifier;
    player.x += moveX * step * deltaTime;
    player.y += moveY * step * deltaTime;

    // --- HUD avatar: swimming + facing; flip by *screen* horizontal intent ---
    const isSwimming = (currentBiome.includes('Water') || /river/i.test(currentBiome));
    playerEmojiSpan.textContent = isSwimming ? '🏊' : '🚶';
    if (sx > 0) playerEmojiSpan.style.transform = 'scaleX(-1)'; else if (sx < 0) playerEmojiSpan.style.transform = 'scaleX(1)';

    // --- draw frame ---
    const {visibleTrees, visibleFish, visibleBiomeCounts} = drawWorld(deltaTime);
    manageCache(player);
    drawMinimap();
    updateHUD(currentBiome, visibleTrees, visibleFish, visibleBiomeCounts || {});
}

function performInteraction(worldX, worldY) {
    if (isGenerating || isGamePaused || !perlin) return;
    const chunkX = Math.floor(worldX / CHUNK_SIZE), chunkY = Math.floor(worldY / CHUNK_SIZE);
    const chunk = chunkCache.get(`${chunkX},${chunkY}`);

    if (chunk) {
        const objIndex = chunk.objects.findIndex(obj => obj.x === worldX && obj.y === worldY);
        if (objIndex !== -1) {
            const object = chunk.objects[objIndex];
            if (object.type === 'fish') {
                if (!player.fishLog[object.name]) {
                    player.fishLog[object.name] = true;
                    showMessage(`Discovered a ${object.name}! ${object.emoji}`);
                } else {
                    showMessage(`You've already discovered the ${object.name}.`);
                }
                invAdd('🐟', 1);
                chunk.objects.splice(objIndex, 1);
                for (let i = 0; i < 5; i++) particles.push(new Particle(worldX, worldY));
            }
        }
    }
}

// =================================================================================
// EVENT HANDLERS
// =================================================================================
function handleGenerate(isSeedChange = false) {
    if (isGenerating) return;
    DOMElements.loading.classList.remove('hidden');
    isGenerating = true;

    lastMinimapPlayerPos = {x: null, y: null}; // Force minimap redraw
    PoissonDisk.clearCache();
    rawNoiseCache.clear();
    chunkCache.clear();

    if (isSeedChange) {
        generatePerlinMaps();
    }

    drawWorld();
    drawMinimap();
    DOMElements.loading.classList.add('hidden');
    isGenerating = false;
    minFps = Infinity;
    maxFps = 0;
    fpsHistory.length = 0;
}

function handleLoadAndResize() {
    canvas.width = viewport.clientWidth;
    canvas.height = viewport.clientHeight;
    if (!isGenerating && perlin) {
        drawWorld();
        drawMinimap();
    }
}

function handleTimeSliderInteraction(event) {
    event.preventDefault();
    const rect = DOMElements.timeSliderContainer.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;

    let wasPaused = isGamePaused;
    isGamePaused = true;

    function onMove(moveEvent) {
        const clientX = moveEvent.touches ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const clientY = moveEvent.touches ? moveEvent.touches[0].clientY : moveEvent.clientY;
        const angleRad = Math.atan2(clientY - centerY, clientX - centerX) + Math.PI / 2;
        let angleDeg = angleRad * 180 / Math.PI;
        if (angleDeg < 0) angleDeg += 360;
        timeOfDay = angleDeg / 360;
        updateCircularSliderUI(timeOfDay);
        chunkCache.clear();
        drawWorld();
    }

    function onEnd() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        isGamePaused = wasPaused;
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
    onMove(event);
}

// Corrected updateCircularSliderUI function
function updateCircularSliderUI(time) {
    const angle = time * 360;
    const r = 40, cx = 50, cy = 50;
    const handlePos = {
        x: cx + (r * Math.cos((angle - 90) * Math.PI / 180)), y: cy + (r * Math.sin((angle - 90) * Math.PI / 180))
    };
    DOMElements.timeSliderHandle.setAttribute('cx', handlePos.x);
    DOMElements.timeSliderHandle.setAttribute('cy', handlePos.y);

    const endAngle = angle >= 359.99 ? 359.99 : angle;
    const start = {x: cx + (r * Math.cos((-90) * Math.PI / 180)), y: cy + (r * Math.sin((-90) * Math.PI / 180))};
    const end = {
        x: cx + (r * Math.cos((endAngle - 90) * Math.PI / 180)), y: cy + (r * Math.sin((endAngle - 90) * Math.PI / 180))
    };
    const largeArcFlag = endAngle <= 180 ? "0" : "1";
    DOMElements.timeSliderProgress.setAttribute('d', `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`);
}

window.onload = () => {
    DOMElements = {
        canvas: document.getElementById('canvas'),
        viewport: document.getElementById('viewport'),
        loading: document.getElementById('loading'),
        player: document.getElementById('player'),
        playerEmoji: document.getElementById('player-emoji'),
        speedModifierText: document.getElementById('speedModifierText'),
        posText: document.getElementById('posText'),
        biomeText: document.getElementById('biomeText'),
        timeText: document.getElementById('timeText'),
        treeCountText: document.getElementById('treeCountText'),
        fishCountText: document.getElementById('fishCountText'),
        keysText: document.getElementById('keysText'),
        fishLog: document.getElementById('fishLog'),
        currentFps: document.getElementById('currentFps'),
        minFps: document.getElementById('minFps'),
        maxFps: document.getElementById('maxFps'),
        messageBox: document.getElementById('messageBox'),
        messageText: document.getElementById('messageText'),
        contourStatus: document.getElementById('contourStatus'),
        settingsHud: document.getElementById('settingsHud'),
        toggleSettings: document.getElementById('toggleSettings'),
        legendHud: document.getElementById('legendHud'),
        toggleLegend: document.getElementById('toggleLegend'),
        legendEntries: document.getElementById('legendEntries'),
        seedInput: document.getElementById('seedInput'),
        heightScaleSlider: document.getElementById('heightScaleSlider'),
        heightScaleValue: document.getElementById('heightScaleValue'),
        moistureScaleSlider: document.getElementById('moistureScaleSlider'),
        moistureScaleValue: document.getElementById('moistureScaleValue'),
        climateContrastSlider: document.getElementById('climateContrastSlider'),
        climateContrastValue: document.getElementById('climateContrastValue'),
        pixelScaleSlider: document.getElementById('pixelScaleSlider'),
        pixelScaleValue: document.getElementById('pixelScaleValue'),
        persistenceSlider: document.getElementById('persistenceSlider'),
        persistenceValue: document.getElementById('persistenceValue'),
        playerSpeedSlider: document.getElementById('playerSpeedSlider'),
        playerSpeedValue: document.getElementById('playerSpeedValue'),
        waterLevelSlider: document.getElementById('waterLevelSlider'),
        waterLevelValue: document.getElementById('waterLevelValue'),
        treeDensitySlider: document.getElementById('treeDensitySlider'),
        treeDensityValue: document.getElementById('treeDensityValue'),
        fishDensitySlider: document.getElementById('fishDensitySlider'),
        fishDensityValue: document.getElementById('fishDensitySlider'),
        mapScaleSlider: document.getElementById('mapScaleSlider'),
        mapScaleValue: document.getElementById('mapScaleValue'),
        timeSliderContainer: document.getElementById('timeSliderContainer'),
        timeSliderProgress: document.getElementById('timeSliderProgress'),
        timeSliderHandle: document.getElementById('timeSliderHandle'),
        mobileControls: document.getElementById('mobileControls'),
        joystick: document.getElementById('joystick'),
        joystickHandle: document.getElementById('joystickHandle'),
        lightingToggle: document.getElementById('lightingToggle'),
        inventoryText: document.getElementById('invText'),
    };

    DOMElements.seedInput.value = Math.floor(Math.random() * 90000) + 10000; // Set a random starting seed

    ({canvas, viewport, player: playerDiv, playerEmoji: playerEmojiSpan, seedInput} = DOMElements);
    ctx = canvas.getContext('2d');

    sliders = {
        heightScale: {slider: DOMElements.heightScaleSlider, span: DOMElements.heightScaleValue},
        moistureScale: {slider: DOMElements.moistureScaleSlider, span: DOMElements.moistureScaleValue},
        climateContrast: {
            slider: DOMElements.climateContrastSlider, span: DOMElements.climateContrastValue, fixed: 1
        },
        persistence: {slider: DOMElements.persistenceSlider, span: DOMElements.persistenceValue},
        waterLevel: {slider: DOMElements.waterLevelSlider, span: DOMElements.waterLevelValue, fixed: 3},
        treeDensity: {
            slider: DOMElements.treeDensitySlider, span: DOMElements.treeDensityValue, suffix: 'x', fixed: 1
        },
        fishDensity: {
            slider: DOMElements.fishDensitySlider, span: DOMElements.fishDensityValue, suffix: 'x', fixed: 1
        },
        mapScale: {slider: DOMElements.mapScaleSlider, span: DOMElements.mapScaleValue, fixed: 2},
        pixelScale: {slider: DOMElements.pixelScaleSlider, span: DOMElements.pixelScaleValue, regen: false},
        playerSpeed: {slider: DOMElements.playerSpeedSlider, span: DOMElements.playerSpeedValue, regen: false},
    };

    // slider DOM
    const sunDirSlider = document.getElementById('sunDirSlider');
    const sunDirValueEl = document.getElementById('sunDirValue');

    // register
    sliders.sunDir = {
        slider: document.getElementById('sunDirSlider'),
        span: document.getElementById('sunDirValue'),
        regen: false,
        fmt: v => `${Math.round(v)}°`
    }


    // live label
    sunDirSlider.addEventListener('input', () => {
        sunDirValueEl.textContent = `${Math.round(parseFloat(sunDirSlider.value))}°`;
    });
    // initialize label
    sunDirValueEl.textContent = `${Math.round(parseFloat(sunDirSlider.value))}°`;

    DOMElements.toggleSettings.addEventListener('click', () => {
        DOMElements.settingsHud.classList.toggle('collapsed');
    });
    DOMElements.toggleLegend.addEventListener('click', () => {
        DOMElements.legendHud.classList.toggle('collapsed');
    });
    DOMElements.lightingToggle.addEventListener('change', () => {
        isLightingEnabled = DOMElements.lightingToggle.checked;
        showMessage(`Lighting: ${isLightingEnabled ? 'On' : 'Off'}`);
        // Rebuild chunks so per-pixel shading matches the new mode
        handleGenerate(false);
    });


    window.addEventListener('resize', handleLoadAndResize);
    seedInput.addEventListener('change', () => handleGenerate(true));
    for (const key in sliders) {
        const {slider, span, regen = true, suffix = '', fixed = 0} = sliders[key];
        slider.addEventListener('input', () => {
            span.textContent = `${parseFloat(slider.value).toFixed(fixed)}${suffix}`;
            if (regen) handleGenerate(false); else if (key === 'pixelScale' && !isGenerating) drawWorld();
        });
    }
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const slider = sliders.pixelScale.slider;
        let newPixelScale = parseInt(slider.value) - Math.sign(e.deltaY);
        slider.value = Math.max(1, Math.min(24, newPixelScale));
        sliders.pixelScale.span.textContent = slider.value;
        if (!isGenerating) drawWorld();
    });
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();

        if (key === 'p') {
            if (e.shiftKey) {
                isDebugViewActive = !isDebugViewActive;
                chunkCache.clear();
            } else {
                showSpawnOverlay = !showSpawnOverlay;
            }
            return; // <--
        } else if (key === 'h') {
            isContourOverlayActive = !isContourOverlayActive;
            return; // <--
        } else if (key === 'o') {
            waterFxQuality = (waterFxQuality + 1) % 3;
            showMessage(`Water FX: ${['Off', 'Low', 'Med'][waterFxQuality]}`);
            return; // <--
        } else if (key === 'l') {
            isLightingEnabled = !isLightingEnabled;
            if (DOMElements.lightingToggle) DOMElements.lightingToggle.checked = isLightingEnabled;
            showMessage(`Lighting: ${isLightingEnabled ? 'On' : 'Off'}`);
            handleGenerate(false);
            return;
        } else if (key === 'e') {
            if (nearbyTradeNpc && nearbyTradeNpc.npc && nearbyTradeNpc.npc.offer && typeof invHasAll === 'function') {
                const o = nearbyTradeNpc.npc.offer;
                if (invHasAll(o.give)) {
                    invConsume(o.give);
                    invGrant(o.get);
                    showMessage(`Trade: ${typeof formatOffer === 'function' ? formatOffer(o) : 'Done'}`);
                } else {
                    showMessage('You are missing items to trade.');
                }
            }
            return;
        } else if (key === 'v') {
            renderMode = (renderMode === 'topdown') ? 'isometric' : 'topdown';
            showMessage(`View: ${renderMode === 'isometric' ? '2.5D' : 'Top-down'}`);
            // Force a quick redraw (no regen needed)
            drawWorld();
            return;
        } else if (e.key.toLowerCase() === 'i') {
            renderMode = renderMode === 'topdown' ? 'isometric' : 'topdown';
            handleGenerate(false); // forces redraw with current cache settings
        } else if (key === 'k') {
            showTileHeights = !showTileHeights;
            if (typeof showMessage === 'function') showMessage(`Tile heights: ${showTileHeights ? 'On' : 'Off'}`);
            return;
        } else if (key === 'j') {
            ISO_DEBUG = !ISO_DEBUG;
            window.__isoDebug.length = 0;
            if (typeof showMessage === 'function') showMessage(`ISO debug: ${ISO_DEBUG ? 'On' : 'Off'}`);
            return;
        }

        keys[e.key.toLowerCase()] = true;
    });

    document.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
    });
    // Prevent 'stuck key' issues if window loses focus (e.g., alt-tab, devtools)
    window.addEventListener('blur', () => {
        keys = {};
    });
    window.addEventListener('focus', () => { /* no-op; keys will be rebuilt on next input */
    });

    canvas.addEventListener('click', (e) => {
        const pixelScale = parseInt(sliders.pixelScale.slider.value);
        const rect = canvas.getBoundingClientRect();

        if (renderMode === 'isometric') {
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            // Convert screen -> world (approx; ignores vertical lift)
            const centerX = viewport.clientWidth / 2;
            const centerY = viewport.clientHeight / 2;
            const w = screenToWorldIso(sx, sy, centerX, centerY);
            performInteraction(Math.floor(w.x), Math.floor(w.y));
            return;
        }

        // original top-down click
        const worldX = Math.floor((player.x - (viewport.clientWidth / pixelScale) / 2) + (e.clientX - rect.left) / pixelScale);
        const worldY = Math.floor((player.y - (viewport.clientHeight / pixelScale) / 2) + (e.clientY - rect.top) / pixelScale);
        performInteraction(worldX, worldY);
    });


    DOMElements.timeSliderContainer.addEventListener('mousedown', handleTimeSliderInteraction);
    DOMElements.timeSliderContainer.addEventListener('touchstart', handleTimeSliderInteraction);

    generatePerlinMaps();
    handleLoadAndResize();
    //setupMobileControls();
    updateCircularSliderUI(timeOfDay);
    gameLoop(0);
};