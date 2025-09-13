export function setupMobileControls() {
    if (!('ontouchstart' in window)) return;
    DOMElements.mobileControls.classList.remove('hidden');
    let joystickTouchId = null;
    DOMElements.joystick.addEventListener('touchstart', (e) => {
        if (joystickTouchId === null) joystickTouchId = e.changedTouches[0].identifier;
    }, {passive: true});
    window.addEventListener('touchmove', (e) => {
        for (let touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                const rect = DOMElements.joystick.getBoundingClientRect(), size = rect.width,
                    handleSize = DOMElements.joystickHandle.clientWidth, maxDist = (size - handleSize) / 2;
                let dx = touch.clientX - (rect.left + size / 2), dy = touch.clientY - (rect.top + size / 2);
                const dist = Math.hypot(dx, dy);
                if (dist > maxDist) {
                    dx = (dx / dist) * maxDist;
                    dy = (dy / dist) * maxDist;
                }
                DOMElements.joystickHandle.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
                keys['w'] = dy / maxDist < -0.2;
                keys['s'] = dy / maxDist > 0.2;
                keys['a'] = dx / maxDist < -0.2;
                keys['d'] = dx / maxDist > 0.2;
                break;
            }
        }
    }, {passive: true});
    window.addEventListener('touchend', (e) => {
        for (let touch of e.changedTouches) {
            if (touch.identifier === joystickTouchId) {
                joystickTouchId = null;
                DOMElements.joystickHandle.style.transform = `translate(-50%, -50%)`;
                keys['w'] = keys['s'] = keys['a'] = keys['d'] = false;
                break;
            }
        }
    });
}