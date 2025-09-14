import {
    BIOME_IS_WATERLIKE,
    CHUNK_SIZE,
    chunkCache, MAX_CACHE_SIZE,
    NOISE_OFFSET_X,
    NOISE_OFFSET_Y,
    Weather,
    Wind
} from "../constants/constants.js";

export function seededRandom(seed) {
    let state = Math.sin(seed) * 10000;
    return function () {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
    };
}

export function lerpColor(c1, c2, t) {
    return [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
}

export function formatTime(time) {
    const hours = Math.floor(time * 24), minutes = Math.floor(((time * 24) - hours) * 60);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 === 0 ? 12 : hours % 12;
    return `${displayHours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

export function smoothStep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

export function remapNoise(value, exponent) {
    return Math.pow(value, exponent);
}

export function getOctaveNoise(x, y, perlin, scale, persistence, initialAmplitude = 1, mapScale = 1) {
    x += NOISE_OFFSET_X;      // ← fractional sampling
    y += NOISE_OFFSET_Y;

    let total = 0, amplitude = initialAmplitude, frequency = 1, maxAmplitude = 0;

    // Anti-alias: skip octaves that change > ~0.5 lattice unit per world tile
    const CUTOFF = 0.5;
    for (let i = 0; i < 16; i++) {
        const stepArg = (mapScale / scale) * frequency;
        if (stepArg > CUTOFF) break;

        total += perlin.noise((x * mapScale) / scale * frequency, (y * mapScale) / scale * frequency) * amplitude;
        maxAmplitude += amplitude;
        amplitude *= persistence;
        frequency *= 2;
    }
    return maxAmplitude ? total / maxAmplitude : 0.5;
}

export function sampleBaseHeight(x, y, perlinHeight, baseScale, mapScale) {
    const nx = (x + NOISE_OFFSET_X) * mapScale / baseScale;
    const ny = (y + NOISE_OFFSET_Y) * mapScale / baseScale;
    return perlinHeight.noise(nx, ny);
}

export function getBiomeFromValues(heightValue, moistureValue, temperatureValue, riverValue, sliders) {
    const {waterLevel} = sliders;
    const landHeight = (heightValue - waterLevel) / (1 - waterLevel);
    const h = heightValue < waterLevel ? (1 - (waterLevel - heightValue) / waterLevel) * 128 : 128 + landHeight * 127;
    const m = moistureValue * 255, t = temperatureValue * 255;

    // REPLACE your current river check with this block:
    if (h >= 132) {
        let riverThreshold = 0.965;          // hybrid: continuous but still branchy
        const nearSea = h < 140;
        const isMarshy = (m > 75 && t > 50);
        const isArid = (t > 66 && m <= 25) || (t > 25 && t <= 66 && m <= 25);

        // moderate deltas/marshes, not overpowering
        if (nearSea) riverThreshold -= 0.015;
        if (isMarshy) riverThreshold -= 0.007;
        if (isArid) riverThreshold += 0.017;

        if (riverValue > riverThreshold) {
            if (t <= 25) return 'frozenRiver';
            if (nearSea) return 'deltaRiver';
            if (isMarshy) return 'marshRiver';
            if (h > 200) return 'mountainRiver';
            if (h < 150) return 'lowlandRiver';
            return 'river';
        }
    }

    if (h < 110) return t <= 25 ? 'frozenDeepWater' : 'deepWater';
    if (h < 128) return t <= 25 ? 'frozenShallowWater' : 'shallowWater';
    if (h < 132) return t <= 25 ? 'snowyBeach' : 'beach';
    if (t <= 25 && m > 75) return 'iceSpikes';
    if (t <= 25 && m <= 50) return 'snowyTundra';
    if ((t > 25 && t <= 50 && m > 25 && m <= 75) || (t <= 25 && m > 50 && m <= 75)) {
        if (t < 25) {
            if (h > 200) return 'snowyTaigaMountains';
            if (h > 180) return 'snowyTaigaHills';
            return 'snowyTaiga';
        } else {
            if (h > 200) return 'taigaMountains';
            if (h > 180) return 'taigaHills';
            return 'taiga';
        }
    }
    if (t > 66 && m <= 25) return h > 180 ? 'desertHills' : 'desert';
    if (t > 25 && t <= 66 && m <= 25) return h > 180 ? 'badlandsHills' : 'badlands';
    if ((t > 66 && m > 75) || (m > 50 && t > 50 && t <= 66)) return h > 180 ? 'jungleHills' : 'jungle';
    if (t > 66 && m <= 75 && m > 50) {
        if (h > 220) return 'forestMountains';
        if (h > 180) return 'forestHills';
        return 'forest';
    }
    if (t > 75 && m <= 50 && m > 25) return h > 180 ? 'savannaPlateau' : 'savanna';
    if (t > 50 && t <= 75 && m > 25 && m <= 50) return h > 200 ? 'mountain' : 'plain';
    return 'swamp';
}

export function getBiomeAtWorldCoords(worldX, worldY, perlin, sliders) {
    const heightValue = getHeightValueAtWorldCoords(worldX, worldY, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
    let moistureValue = getOctaveNoise(worldX, worldY, perlin.moisture, sliders.moistureScale, sliders.persistence, 10, sliders.mapScale);
    let temperatureValue = getOctaveNoise(worldX, worldY, perlin.temperature, 150, sliders.persistence, 10, sliders.mapScale);
    moistureValue = remapNoise(moistureValue, sliders.climateContrast);
    temperatureValue = remapNoise(temperatureValue, sliders.climateContrast);
    // --- HYBRID RIVERS: long trunks + detailed branches + mild deltas ---
    const RIVER_TRUNK_SCALE = 95;   // 70–120 → longer/smoother trunks when higher
    const RIVER_DETAIL_SCALE = 34;   // 26–45 → more/less branch detail
    const RIVER_MAP_SCALE = 1.0;  // decouple from sliders.mapScale
    // Gentle domain warp so paths meander
    const WARP1_SCALE = 240, WARP2_SCALE = 520, WARP_AMPL = 12;
    const wu = getOctaveNoise(worldX, worldY, perlin.object, WARP1_SCALE, 0.5, 10, 1.0);
    const wv = getOctaveNoise(worldX, worldY, perlin.temperature, WARP2_SCALE, 0.5, 10, 1.0);
    const wx = worldX + (wu - 0.5) * WARP_AMPL;
    const wy = worldY + (wv - 0.5) * WARP_AMPL;
    // Long “trunk” field (ridged)
    const trunkRaw = getOctaveNoise(wx, wy, perlin.river, RIVER_TRUNK_SCALE, sliders.persistence, 10, RIVER_MAP_SCALE);
    const trunkRidged = 1 - Math.abs(trunkRaw * 2 - 1);
    // Higher-frequency detail (ridged) to spawn tributaries/branches
    const detailRaw = getOctaveNoise(wx, wy, perlin.river, RIVER_DETAIL_SCALE, 0.55, 10, RIVER_MAP_SCALE);
    const detailRidged = 1 - Math.abs(detailRaw * 2 - 1);
    // A de-correlated helper for branches, so they don’t mirror trunks
    const tribRaw = getOctaveNoise(wx, wy, perlin.object, 42, 0.5, 10, 1.0);
    const tribRidged = 1 - Math.abs(tribRaw * 2 - 1);
    // Blend: keep continuous trunks, add fine branches (moisture helps branches)
    const branchWeight = 0.55; // 0 → trunks only, 1 → lots of branches
    const branchField = (detailRidged * 0.6 + tribRidged * 0.4) * (0.55 + 0.45 * moistureValue);
    let riverSignal = Math.max(trunkRidged, trunkRidged * 0.5 + branchField * branchWeight);
    // Lightweight continuity bridge so near-misses connect (sample 4-neighbors on trunk)
    const n1 = getOctaveNoise(wx + 1, wy, perlin.river, RIVER_TRUNK_SCALE, sliders.persistence, 10, RIVER_MAP_SCALE);
    const n2 = getOctaveNoise(wx - 1, wy, perlin.river, RIVER_TRUNK_SCALE, sliders.persistence, 10, RIVER_MAP_SCALE);
    const n3 = getOctaveNoise(wx, wy + 1, perlin.river, RIVER_TRUNK_SCALE, sliders.persistence, 10, RIVER_MAP_SCALE);
    const n4 = getOctaveNoise(wx, wy - 1, perlin.river, RIVER_TRUNK_SCALE, sliders.persistence, 10, RIVER_MAP_SCALE);
    const neighTrunk = Math.max(1 - Math.abs(n1 * 2 - 1), 1 - Math.abs(n2 * 2 - 1), 1 - Math.abs(n3 * 2 - 1), 1 - Math.abs(n4 * 2 - 1));
    riverSignal = Math.max(riverSignal, neighTrunk * 0.985);
    // Gentle valley & moisture bias (keeps trunks crossing the map, but favors low/wet)
    const landV = Math.max(0, Math.min(1, (heightValue - sliders.waterLevel) / (1 - sliders.waterLevel)));
    const valleyBoost = 0.80 + 0.30 * (1 - landV);                 // prefer lower land
    const moistureBoost = 0.88 + 0.28 * remapNoise(moistureValue, 1.1); // prefer wetter climates

    // Compute absolute 'h' like in getBiomeFromValues to spot near-sea for deltas
    const landHeight = (heightValue - sliders.waterLevel) / (1 - sliders.waterLevel);
    const h = (heightValue < sliders.waterLevel) ? (1 - (sliders.waterLevel - heightValue) / sliders.waterLevel) * 128 : 128 + landHeight * 127;
    const nearSea = (h >= 132 && h < 140);

    // Mild widening near sea → deltas without overwhelming trunks
    const deltaWiden = nearSea ? 1.05 : 1.0;

    // Final river field (clamped)
    const riverValue = Math.max(0, Math.min(1, riverSignal * valleyBoost * moistureBoost * deltaWiden));
    return getBiomeFromValues(heightValue, moistureValue, temperatureValue, riverValue, sliders);
}

export function getHeightValueAtWorldCoords(worldX, worldY, perlinHeight, heightScale, persistence, mapScale, waterLevel = null) {
    // full detail (multi-octave)
    const fine = getOctaveNoise(worldX, worldY, perlinHeight, heightScale, persistence, 10, mapScale);
    if (waterLevel == null) return fine; // backward-compat if any old call

    // coarse scaffold (single very low-frequency octave)
    const baseScale = heightScale * 2.5; // larger = smoother
    const coarse = sampleBaseHeight(worldX, worldY, perlinHeight, baseScale, mapScale);

    // fade detail out as we approach sea level (on either side)
    const distToSea = Math.abs(coarse - waterLevel);      // 0 at shoreline
    const mask = smoothStep(0.02, 0.12, distToSea);       // 0→coarse, 1→fine

    return coarse * (1 - mask) + fine * mask;
}

export function getMovementSpeedModifier(biome) {
    switch (biome) {
        case 'deepWater':
        case 'frozenDeepWater':
            return 0.4;
        case 'shallowWater':
        case 'frozenShallowWater':
            return 0.6;
        case 'jungle':
        case 'jungleHills':
        case 'swamp':
        case 'swampHills':
            return 0.7;
        case 'snowyMountains':
        case 'taigaMountains':
        case 'snowyTaigaMountains':
        case 'mountain':
        case 'forestMountains':
            return 0.5;
        // rivers now set per-pixel in draw using a dynamic override; keep a safe default:
        case 'frozenRiver':
            return 0.3;
        case 'marshRiver':
            return 0.35;
        case 'mountainRiver':
            return 0.45;
        case 'lowlandRiver':
            return 0.4;
        case 'deltaRiver':
            return 0.4;
        default:
            return 1.0;
    }
}

export function getPixelLightness(x, y, heightValue, perlinHeight, sliders, sunVector) {
    const {heightScale, persistence, mapScale} = sliders;
    const h_x1 = getHeightValueAtWorldCoords(x + 1, y, perlinHeight, heightScale, persistence, mapScale, sliders.waterLevel);
    const h_y1 = getHeightValueAtWorldCoords(x, y + 1, perlinHeight, heightScale, persistence, mapScale, sliders.waterLevel);
    const normalX = ((heightValue - h_x1) * 20) / mapScale;
    const normalY = ((heightValue - h_y1) * 20) / mapScale;
    const dotProduct = normalX * sunVector[0] + normalY * sunVector[1];
    const lighting = 1.0 + dotProduct * 0.5;
    return Math.max(0.6, Math.min(1.4, lighting));
}

export function getTimeOfDayInfo(timeOfDay) {
    const nightTint = [0.45, 0.5, 0.75], sunriseTint = [1.0, 0.75, 0.6], dayTint = [1.0, 1.0, 1.0];
    let tint;
    if (timeOfDay < 0.25) tint = lerpColor(nightTint, sunriseTint, timeOfDay / 0.25); else if (timeOfDay < 0.5) tint = lerpColor(sunriseTint, dayTint, (timeOfDay - 0.25) / 0.25); else if (timeOfDay < 0.75) tint = lerpColor(dayTint, sunriseTint, (timeOfDay - 0.5) / 0.25); else tint = lerpColor(sunriseTint, nightTint, (timeOfDay - 0.75) / 0.25);
    const lightLevel = 0.2 + (Math.max(0, Math.sin(timeOfDay * Math.PI * 2)) * 0.8);
    return {lightLevel, tint};
}

export function getTreePlacementRadius(biome, sliders) {
    const multiplier = sliders.treeDensityMultiplier || 1;
    let baseRadius = 0;
    switch (biome) {
        case 'forest':
        case 'jungle':
        case 'taiga':
            baseRadius = 4;
            break;
        case 'forestHills':
        case 'jungleHills':
        case 'taigaHills':
            baseRadius = 5;
            break;
        case 'swamp':
            baseRadius = 7;
            break;
        case 'plain':
            baseRadius = 9;
            break;
        case 'savanna':
            baseRadius = 12;
            break;
        default:
            return 0; // No trees in other biomes
    }
    return Math.max(1, baseRadius / multiplier);
}

export function getFishPlacementRadius(biome, sliders) {
    const multiplier = sliders.fishDensityMultiplier || 1;
    if (multiplier === 0) return 0;
    if (biome.includes('Water') || /river/i.test(biome)) {
        let base = Math.max(2, 10 / multiplier);
        if (/deltaRiver|marshRiver/i.test(biome)) base = Math.max(2, 8 / multiplier); // a bit denser
        return base;
    }
    return 0;
}

export function getAbsoluteHeight(worldX, worldY, perlin, sliders, cache) {
    const key = `${worldX},${worldY}`;
    if (cache && cache.has(key)) return cache.get(key);

    const {waterLevel} = sliders;
    const heightValue = getHeightValueAtWorldCoords(worldX, worldY, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
    const landHeight = (heightValue - waterLevel) / (1 - waterLevel);
    const h = heightValue < waterLevel ? (1 - (waterLevel - heightValue) / waterLevel) * 128 : 128 + landHeight * 127;

    if (cache) cache.set(key, h);
    return h;
}

export function getSunVectorFromSlider() {
    const el = document.getElementById('sunDirSlider');
    const deg = el ? parseFloat(el.value) : 0;        // fallback 0° if slider missing
    const rad = (deg * Math.PI) / 180;
    // Keep previous lighting convention (same sign/orientation as before):
    return [-Math.cos(rad), -Math.sin(rad)];
}

// --- Water helpers & river flow sampling (global) ---
export function isWaterLikeBiomeName(b) {
    return b && (b.includes('Water') || /river/i.test(b));
}

// Pick a tiny local flow vector from riverHints for world coords (wx, wy)
export function getRiverFlowAt(wx, wy, chunk) {
    if (!chunk || !chunk.riverHints || !chunk.riverHints.length) return {x: 0, y: 0};
    const cx = Math.floor(wx / CHUNK_SIZE), cy = Math.floor(wy / CHUNK_SIZE);
    const lx = Math.round(wx - cx * CHUNK_SIZE);
    const ly = Math.round(wy - cy * CHUNK_SIZE);
    let best = null, bestD = 2;
    for (const h of chunk.riverHints) {
        const d = Math.abs(h.x - lx) + Math.abs(h.y - ly);
        if (d < bestD) {
            bestD = d;
            best = h;
            if (d === 0) break;
        }
    }
    return best && best.flow ? best.flow : {x: 0, y: 0};
}

export function updateWind(dt, windTime, perlin) {
    if (!perlin) return; // safety in case called very early
    windTime += Math.max(0.001, dt);
    // slowly rotate wind direction using low-frequency noise
    const turnNoise = (perlin.temperature.noise(windTime * 0.02, 0) - 0.5) * 0.25;
    Wind.baseAngle += turnNoise * dt;
    // weather baseline
    const weatherBase = Weather.type === '🌧️' ? 0.9 : Weather.type === '❄️' ? 0.6 : 0.5;
    // long wave variability (breeze rises/falls)
    const slow = perlin.moisture.noise(windTime * 0.05, 7.3); // 0..1
    // gusts (spiky)
    const gustRaw = perlin.object.noise(windTime * 0.6, 13.7); // 0..1
    const gust = Math.max(0, gustRaw - 0.65) * 2.2;
    Wind.targetSpeed = weatherBase * (0.5 + 0.7 * slow) + gust;
    // ease current speed toward target
    const ease = 0.8;
    Wind.speed += (Wind.targetSpeed - Wind.speed) * Math.min(1, ease * dt);
}

export function getHeightGrad(wx, wy, perlin, sliders) {
    // finite difference on your continuous height field
    const hC = getHeightValueAtWorldCoords(wx, wy, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
    const hX = getHeightValueAtWorldCoords(wx + 1, wy, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
    const hY = getHeightValueAtWorldCoords(wx, wy + 1, perlin.height, sliders.heightScale, sliders.persistence, sliders.mapScale, sliders.waterLevel);
    // gradient points "uphill"; flow is opposite
    return {fx: hC - hX, fy: hC - hY}; // flow ~ downhill vector
}

export function getChunk(cx, cy) {
    return chunkCache.get(`${cx},${cy}`);
}

export function getBiomeIndexFromCache(wx, wy) {
    const cx = Math.floor(wx / CHUNK_SIZE), cy = Math.floor(wy / CHUNK_SIZE);
    const chunk = getChunk(cx, cy);
    if (!chunk || !chunk.biomeIdx) return -1;
    const lx = wx - cx * CHUNK_SIZE, ly = wy - cy * CHUNK_SIZE;
    if (lx < 0 || ly < 0 || lx >= CHUNK_SIZE || ly >= CHUNK_SIZE) return -1;
    return chunk.biomeIdx[ly * CHUNK_SIZE + lx];
}

export function isWaterLikeAt(wx, wy, perlin, sliders) {
    const idx = getBiomeIndexFromCache(wx, wy);
    if (idx >= 0) return !!BIOME_IS_WATERLIKE[idx];
    // fallback (rare)
    return isWaterLikeBiomeName(getBiomeAtWorldCoords(wx, wy, perlin, sliders));
}

export function updateNpc(npc, dt, chunk, lightLevel, perlin, sliders, timeOfDay) {
    // simple day plan: work → market → home; night = home
    const t = timeOfDay;                // 0..1
    const isNight = lightLevel < 0.30;

    // target (tx, ty)
    let tx = npc.homeX, ty = npc.homeY;
    if (!isNight) {
        if (t > 0.45 && t < 0.55) {       // short “market hour”
            tx = npc.cx;
            ty = npc.cy;
        } else {
            tx = npc.workX;
            ty = npc.workY; // normal work time
            if (Weather.type === '🌧️' && npc.role === 'farmer') { // farmers hide from rain
                tx = npc.cx;
                ty = npc.cy;
            }
        }
    }

    // head toward target with tiny wander
    npc.phase = (npc.phase || 0) + dt * 1.2;
    const jitterX = Math.cos(npc.phase * 2.3) * 0.05;
    const jitterY = Math.sin(npc.phase * 1.7) * 0.05;

    let vx = (tx - npc.x) + jitterX;
    let vy = (ty - npc.y) + jitterY;
    const m = Math.hypot(vx, vy) || 1e-6;
    vx /= m;
    vy /= m;

    const speed = (npc.speed || 1.0) * (Weather.type === '❄️' ? 0.85 : 1.0);
    let nx = npc.x + vx * speed * dt;
    let ny = npc.y + vy * speed * dt;

    // keep out of water
    if (!isWaterLikeAt(Math.round(nx), Math.round(ny), perlin, sliders)) {
        npc.x = nx;
        npc.y = ny;
    }
}

export function manageCache(player) {
    if (chunkCache.size <= MAX_CACHE_SIZE) return;
    const playerChunkX = Math.floor(player.x / CHUNK_SIZE), playerChunkY = Math.floor(player.y / CHUNK_SIZE);
    let farthestKey = null, maxDistSq = -1;
    for (const key of chunkCache.keys()) {
        const [cx, cy] = key.split(',').map(Number);
        const distSq = (cx - playerChunkX) ** 2 + (cy - playerChunkY) ** 2;
        if (distSq > maxDistSq) {
            maxDistSq = distSq;
            farthestKey = key;
        }
    }
    if (farthestKey) {
        chunkCache.delete(farthestKey);
    }
}

export function getFloatingPlacementRadius(biome, sliders) {
    if (biome.includes('Water') || /river/i.test(biome)) return Math.max(3, 14 / Math.max(0.2, sliders.fishDensityMultiplier));
    return 0;
}

export function pointInDiamond(mx, my, cx, cy, tw, th) {
    // diamond centered at (cx, cy) with width tw and height th
    const dx = Math.abs(mx - cx);
    const dy = Math.abs(my - cy);
    return (dx / (tw * 0.5) + dy / (th * 0.5)) <= 1;
}
