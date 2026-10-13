// Confetti burst shown when a picture is finished. Draws on its own full-screen canvas, then removes it.

const COLORS = ["#ff4d73", "#ffb84d", "#ffe14d", "#3ecf8e", "#4da3ff", "#a66bff", "#ff7ad9"];

export function launchConfetti(duration = 3200) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:30";
  document.body.append(c);
  const dpr = devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);

  // two bursts from the lower corners, shooting up and inwards
  const pieces = [];
  for (let i = 0; i < 160; i++) {
    const left = i % 2 === 0;
    const angle = (left ? -1 : -2.14) + (Math.random() - 0.5) * 0.7; // radians, up-right / up-left
    const speed = 9 + Math.random() * 9;
    pieces.push({
      x: left ? 0 : W,
      y: H * 0.85,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 6,
      spin: Math.random() * 6,
      spinSpeed: (Math.random() - 0.5) * 0.4,
      color: COLORS[i % COLORS.length],
    });
  }
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.min(1, (duration - t) / 600);
    for (const p of pieces) {
      p.vy += 0.32; // gravity
      p.vx *= 0.985; // air drag
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += p.spinSpeed;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.scale(1, Math.cos(p.spin * 2)); // flutter
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
}
