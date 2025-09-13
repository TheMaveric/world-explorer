import {seededRandom} from "../utils/utils.js";
// =================================================================================
// BIOME AND WORLD GENERATION
// =================================================================================
export class PerlinNoise {
    constructor(seed) {
        const random = seededRandom(seed);
        this.p = new Array(512);
        const permutation = new Array(256);
        for (let i = 0; i < 256; i++) {
            permutation[i] = i;
        }
        for (let i = 0; i < 255; i++) {
            const j = Math.floor(random() * (256 - i)) + i;
            [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
        }
        for (let i = 0; i < 256; i++) {
            this.p[i] = this.p[i + 256] = permutation[i];
        }
    }

    noise(x, y) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
        x -= Math.floor(x);
        y -= Math.floor(y);
        const u = this.fade(x), v = this.fade(y);
        const A = this.p[X] + Y, AA = this.p[A], AB = this.p[A + 1];
        const B = this.p[X + 1] + Y, BA = this.p[B], BB = this.p[B + 1];
        const res = this.lerp(v, this.lerp(u, this.grad(this.p[AA], x, y), this.grad(this.p[BA], x - 1, y)), this.lerp(u, this.grad(this.p[AB], x, y - 1), this.grad(this.p[BB], x - 1, y - 1)));
        return (res + 1.0) / 2.0;
    }

    fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    lerp(t, a, b) {
        return a + t * (b - a);
    }

    grad(hash, x, y) {
        const h = hash & 3;
        const u = h < 2 ? x : y, v = h < 2 ? y : x;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
}