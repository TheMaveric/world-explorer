import {getBiomeAtWorldCoords, seededRandom} from "../utils/utils.js";
import {CHUNK_SIZE} from "../constants/constants.js";
// =================================================================================
// POISSON DISK SAMPLING FOR OBJECT PLACEMENT
// =================================================================================

export const PoissonDisk = (() => {
    const GRID_CELL_SIZE = 4;
    const INV_CELL_SIZE = 1 / GRID_CELL_SIZE;
    const candidateCache = new Map();

    function getCandidate(cx, cy, perlin, sliders, seed, getRadiusFn) {
        const key = `${cx},${cy},${seed},${getRadiusFn.name},${sliders.treeDensityMultiplier},${sliders.fishDensityMultiplier}`;
        if (candidateCache.has(key)) return candidateCache.get(key);

        const cellRandom = seededRandom(cx * 9301 + cy * 49297 + seed);
        const pointX = (cx + cellRandom()) * GRID_CELL_SIZE;
        const pointY = (cy + cellRandom()) * GRID_CELL_SIZE;
        const biome = getBiomeAtWorldCoords(pointX, pointY, perlin, sliders);
        const radius = getRadiusFn(biome, sliders);

        const candidate = {x: pointX, y: pointY, r: radius, biome: biome};
        candidateCache.set(key, candidate);
        return candidate;
    }

    function generatePointsForChunk(chunkX, chunkY, perlin, sliders, seed, getRadiusFn, isValidBiomeFn, createObjectFn) {
        const points = [];
        const startX = chunkX * CHUNK_SIZE, startY = chunkY * CHUNK_SIZE;
        const endX = startX + CHUNK_SIZE, endY = startY + CHUNK_SIZE;

        const startCellX = Math.floor(startX * INV_CELL_SIZE), endCellX = Math.ceil(endX * INV_CELL_SIZE);
        const startCellY = Math.floor(startY * INV_CELL_SIZE), endCellY = Math.ceil(endY * INV_CELL_SIZE);

        for (let cy = startCellY; cy < endCellY; cy++) {
            for (let cx = startCellX; cx < endCellX; cx++) {
                const candidate = getCandidate(cx, cy, perlin, sliders, seed, getRadiusFn);

                if (candidate.r === 0 || !isValidBiomeFn(candidate.biome) || candidate.x < startX || candidate.x >= endX || candidate.y < startY || candidate.y >= endY) continue;

                let isValid = true;
                const checkCellRadius = Math.ceil(candidate.r * INV_CELL_SIZE);

                for (let j = -checkCellRadius; j <= checkCellRadius; j++) {
                    for (let i = -checkCellRadius; i <= checkCellRadius; i++) {
                        if (i === 0 && j === 0) continue;
                        const neighbor = getCandidate(cx + i, cy + j, perlin, sliders, seed, getRadiusFn);
                        if (neighbor.r === 0 || !isValidBiomeFn(neighbor.biome)) continue;

                        const distSq = (candidate.x - neighbor.x) ** 2 + (candidate.y - neighbor.y) ** 2;
                        if (distSq < neighbor.r * neighbor.r) {
                            if (candidate.r < neighbor.r || (candidate.r === neighbor.r && (candidate.x > neighbor.x || (candidate.x === neighbor.x && candidate.y > neighbor.y)))) {
                                isValid = false;
                                break;
                            }
                        }
                    }
                    if (!isValid) break;
                }

                if (isValid) {
                    points.push(createObjectFn(candidate));
                }
            }
        }
        return points;
    }

    function clearCache() {
        candidateCache.clear();
    }

    return {generatePointsForChunk, clearCache};
})();