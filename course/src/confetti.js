// Lightweight, dependency-free confetti burst. Drops a full-screen canvas
// overlay, animates falling paper rectangles with gravity, then cleans itself
// up. Used to celebrate a workflow run that produced the expected output.
export function launchConfetti({ count = 160, duration = 2800 } = {}) {
  if (typeof document === "undefined") return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = () => window.innerWidth;
  const height = () => window.innerHeight;
  const resize = () => {
    canvas.width = width() * dpr;
    canvas.height = height() * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const colors = ["#444CE7", "#818cf8", "#B664FF", "#34d399", "#fbbf24", "#f78c6c"];
  const particles = Array.from({ length: count }, () => ({
    x: Math.random() * width(),
    y: -20 - Math.random() * height() * 0.35,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vx: -2 + Math.random() * 4,
    vy: 2 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vrot: -0.2 + Math.random() * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  let raf = 0;

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, width(), height());
    const fade = elapsed > duration - 700 ? Math.max(0, (duration - elapsed) / 700) : 1;
    for (const p of particles) {
      p.vy += 0.05; // gravity
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < duration) {
      raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.remove();
    }
  }

  raf = requestAnimationFrame(frame);
}
