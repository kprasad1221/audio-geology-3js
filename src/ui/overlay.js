// ─────────────────────────────────────────────────────────────────────────────
//  World overlay: survey labels and up to three leader annotations, placed at
//  the real projected positions of what they name. DOM + SVG, updated per frame
//  only while visible.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

export function createOverlay(els, camera) {
  const v = new THREE.Vector3();
  const pool = [];
  const NS = 'http://www.w3.org/2000/svg';

  function project(world, rect) {
    v.copy(world).project(camera);
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height, behind: v.z > 1 };
  }
  function label(i) {
    if (!pool[i]) { pool[i] = document.createElement('span'); els.labels.appendChild(pool[i]); }
    return pool[i];
  }

  // labels: [{ text, world, kind }]; leaders: [{ text, world, dx, dy }]
  function draw(labels, leaders) {
    const rect = els.overlay.getBoundingClientRect();
    let n = 0;
    for (const l of labels) {
      const p = project(l.world, rect);
      const s = label(n++);
      s.className = l.kind === 'axis' ? 'axis' : '';
      s.textContent = l.text;
      s.style.left = `${p.x}px`; s.style.top = `${p.y}px`;
      s.hidden = p.behind;
    }
    let svg = '';
    for (const l of leaders) {
      const p = project(l.world, rect);
      if (p.behind) continue;
      // keep labels on the open side of the viewport (the Inspect drawer sits on the right)
      const dx = p.x > rect.width * 0.5 ? -Math.abs(l.dx) - 120 : Math.abs(l.dx);
      const lx = Math.min(Math.max(p.x + dx, 12), rect.width - 140), ly = Math.min(Math.max(p.y + l.dy, 16), rect.height - 16);
      const ex = dx < 0 ? lx + 112 : lx - 4;
      svg += `<path d="M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)}"/>`;
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5"/>`;
      if (l.arrow) {
        const q = project(l.arrow, rect);
        const ang = Math.atan2(q.y - p.y, q.x - p.x), len = 34;
        const ex = p.x + Math.cos(ang) * len, ey = p.y + Math.sin(ang) * len;
        svg += `<path d="M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)} M${(ex - 7 * Math.cos(ang - 0.45)).toFixed(1)},${(ey - 7 * Math.sin(ang - 0.45)).toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)} L${(ex - 7 * Math.cos(ang + 0.45)).toFixed(1)},${(ey - 7 * Math.sin(ang + 0.45)).toFixed(1)}"/>`;
      }
      const s = label(n++);
      s.className = 'lead'; s.textContent = l.text; s.hidden = false;
      s.style.left = `${lx}px`; s.style.top = `${ly}px`;
    }
    for (let i = n; i < pool.length; i++) pool[i].hidden = true;
    els.leaders.innerHTML = svg;
  }
  function clear() { for (const s of pool) s.hidden = true; els.leaders.innerHTML = ''; }
  return { draw, clear };
}
