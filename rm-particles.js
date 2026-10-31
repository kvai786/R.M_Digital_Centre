(function () {
    "use strict";
    const canvas = document.getElementById("hero-particles");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const LINK_DISTANCE = 120;
    let width = 0;
    let height = 0;
    let dots = [];
    let frame = 0;

    function resize() {
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        // Fewer dots on small screens keeps it light on phones.
        const count = Math.max(18, Math.min(60, Math.round(width / 24)));
        dots = Array.from({ length: count }, function () {
            return {
                x: Math.random() * width, y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
            };
        });
    }

    function draw() {
        context.clearRect(0, 0, width, height);
        for (const dot of dots) {
            dot.x += dot.vx;
            dot.y += dot.vy;
            if (dot.x < 0 || dot.x > width) dot.vx *= -1;
            if (dot.y < 0 || dot.y > height) dot.vy *= -1;
        }
        for (let i = 0; i < dots.length; i += 1) {
            for (let j = i + 1; j < dots.length; j += 1) {
                const dx = dots[i].x - dots[j].x;
                const dy = dots[i].y - dots[j].y;
                const distance = Math.hypot(dx, dy);
                if (distance < LINK_DISTANCE) {
                    context.strokeStyle = "rgba(56, 189, 248," + (0.28 * (1 - distance / LINK_DISTANCE)).toFixed(3) + ")";
                    context.lineWidth = 1;
                    context.beginPath();
                    context.moveTo(dots[i].x, dots[i].y);
                    context.lineTo(dots[j].x, dots[j].y);
                    context.stroke();
                }
            }
        }
        context.fillStyle = "rgba(186, 230, 253, 0.85)";
        for (const dot of dots) {
            context.beginPath();
            context.arc(dot.x, dot.y, 1.6, 0, Math.PI * 2);
            context.fill();
        }
        frame = window.requestAnimationFrame(draw);
    }

    function start() {
        if (!frame) frame = window.requestAnimationFrame(draw);
    }

    function stop() {
        window.cancelAnimationFrame(frame);
        frame = 0;
    }

    resize();
    window.addEventListener("resize", resize);
    // No work while the tab is hidden.
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    start();
})();
