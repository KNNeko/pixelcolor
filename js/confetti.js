// Confetti when a picture is finished: bursts from the two lower corners and a shower from the top. Draws
// on its own full-screen canvas, then removes it.

const COLORS = ["#ff4d73", "#ffb84d", "#ffe14d", "#3ecf8e", "#4da3ff", "#a66bff", "#ff7ad9"];
const BURST = 300; // pieces shot from the lower corners
const SHOWER = 220; // pieces falling from the top, spread over the first SHOWER_MS
const SHOWER_MS = 1600;

/** Starts the confetti; returns a function that takes it away early. */
export function launchConfetti(duration = 4600) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:30";
  document.body.append(c);
  const dpr = devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext("2d");

  const pieces = [];
  const piece = (x, y, vx, vy, delay, i) =>
    pieces.push({
      x,
      y,
      vx,
      vy,
      delay, // ms before it appears
      size: 6 + Math.random() * 6,
      spin: Math.random() * 6,
      spinSpeed: (Math.random() - 0.5) * 0.4,
      color: COLORS[i % COLORS.length],
    });
  // speeds in CSS px per 1/60 s
  for (let i = 0; i < BURST; i++) {
    const left = i % 2 === 0;
    const angle = (left ? -1.05 : -2.09) + (Math.random() - 0.5) * 0.75; // radians: up-right / up-left
    const speed = 10 + Math.random() * 11;
    piece(left ? 0 : W, H * 0.88, Math.cos(angle) * speed, Math.sin(angle) * speed, Math.random() * 250, i);
  }
  for (let i = 0; i < SHOWER; i++)
    piece(
      Math.random() * W,
      -20 - Math.random() * 60,
      (Math.random() - 0.5) * 3,
      1 + Math.random() * 2,
      Math.random() * SHOWER_MS,
      i,
    );

  const start = performance.now();
  let last = start;
  let stopped = false;
  const frame = (now) => {
    if (stopped) return;
    const t = now - start;
    // moves are scaled by the frame time: a slow phone shows fewer frames, not slower confetti
    const k = Math.min(3, (now - last) / 16.7);
    last = now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.globalAlpha = Math.max(0, Math.min(1, (duration - t) / 700));
    for (const p of pieces) {
      if (p.delay > t) continue;
      p.vy += 0.3 * k; // gravity
      const drag = 0.985 ** k; // air
      p.vx *= drag;
      p.vy = Math.min(p.vy * drag, 7); // falling flat pieces flutter down slowly
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.spin += p.spinSpeed * k;
      if (p.y > H + 20) continue;
      const cos = Math.cos(p.spin);
      const sin = Math.sin(p.spin);
      const flutter = Math.cos(p.spin * 2);
      ctx.setTransform(cos * dpr, sin * dpr, -sin * flutter * dpr, cos * flutter * dpr, p.x * dpr, p.y * dpr);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    }
    if (t < duration) requestAnimationFrame(frame);
    else c.remove();
  };
  requestAnimationFrame(frame);
  return () => {
    stopped = true;
    c.remove();
  };
}
