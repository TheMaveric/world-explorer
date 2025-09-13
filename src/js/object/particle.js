export class Particle {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.life = 1;
        this.size = Math.random() * 2 + 1;
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = -Math.random() * 0.5;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.life -= 0.05;
    }
}