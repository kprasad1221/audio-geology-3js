// ─────────────────────────────────────────────────────────────────────────────
//  Interface geology: static SVG, drawn once (and again only on resize).
//
//  erode()    layered, eroded profiles along one side of a panel — sediment
//             bands that read as a cut stone edge. Content sits on an even inset.
//  engrave()  faint contour engravings for the page: real contour lines of a
//             small noise field, traced with marching squares.
//
//  Nothing here animates and none of it sits under text.
// ─────────────────────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i + seed * 101.3) * (1 - u) + hash(i + 1 + seed * 101.3) * u;
}
function fbm(x, seed) { return 0.58 * vnoise(x, seed) + 0.28 * vnoise(x * 2.3, seed + 7) + 0.14 * vnoise(x * 5.7, seed + 13); }
function vnoise2(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash(a * 57.0 + b * 113.0 + seed * 19.7);
  return (h(ix, iy) * (1 - ux) + h(ix + 1, iy) * ux) * (1 - uy) + (h(ix, iy + 1) * (1 - ux) + h(ix + 1, iy + 1) * ux) * uy;
}
function fbm2(x, y, seed) { return 0.55 * vnoise2(x, y, seed) + 0.3 * vnoise2(x * 2.1, y * 2.1, seed + 3) + 0.15 * vnoise2(x * 4.3, y * 4.3, seed + 9); }

// layers: [{ inset, amp, freq, fill, stroke? }] from the outermost to the face.
export function erode(el, { side = 'left', layers, seed = 1, lines = [] }) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'erosion'); svg.setAttribute('aria-hidden', 'true');
  el.prepend(svg);
  const draw = () => {
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    const along = side === 'left' ? h : w;
    const steps = Math.max(8, Math.ceil(along / 7));
    const profile = (L, s) => {
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const t = (k / steps) * along;
        const off = L.inset + L.amp * (fbm(t * L.freq / 100, seed + s) - 0.5) * 2;
        pts.push(side === 'left' ? [off, t] : [t, off]);
      }
      return pts;
    };
    let out = '';
    layers.forEach((L, i) => {
      const pts = profile(L, i * 0.37);
      const body = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
      const d = side === 'left' ? `M${w},0 L${body} L${w},${h} Z` : `M0,${h} L${body} L${w},${h} Z`;
      out += `<path d="${d}" style="fill:${L.fill}${L.stroke ? `;stroke:${L.stroke};stroke-width:1` : ''}"/>`;
    });
    // fine engraved lines parallel to the cut, inside the face
    lines.forEach((L, i) => {
      const pts = profile(L, 2.1 + i * 0.29);
      out += `<path d="M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')}" style="fill:none;stroke:${L.stroke};stroke-width:${L.width || 0.8};opacity:${L.opacity ?? 1}"/>`;
    });
    svg.innerHTML = out;
  };
  new ResizeObserver(draw).observe(el);
  draw();
}

// Contour engravings: marching squares on a 2D fbm field, levels every `step`.
export function engrave(svg, { seed = 4, cols = 112, rows = 70, levels = [0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.68] } = {}) {
  const W = 1600, H = 1000, cw = W / cols, ch = H / rows;
  const f = [];
  for (let j = 0; j <= rows; j++) { f[j] = []; for (let i = 0; i <= cols; i++) f[j][i] = fbm2(i * 0.055, j * 0.07, seed); }
  let d = '';
  const lerp = (a, b, l) => (l - a) / (b - a);
  for (const l of levels) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = f[j][i], b = f[j][i + 1], c = f[j + 1][i + 1], e = f[j + 1][i];
      const code = (a > l) | ((b > l) << 1) | ((c > l) << 2) | ((e > l) << 3);
      if (code === 0 || code === 15) continue;
      const x = i * cw, y = j * ch;
      const top = [x + cw * lerp(a, b, l), y], right = [x + cw, y + ch * lerp(b, c, l)];
      const bottom = [x + cw * lerp(e, c, l), y + ch], left = [x, y + ch * lerp(a, e, l)];
      const seg = {
        1: [left, top], 2: [top, right], 3: [left, right], 4: [right, bottom], 5: [left, top, right, bottom],
        6: [top, bottom], 7: [left, bottom], 8: [bottom, left], 9: [top, bottom], 10: [top, right, bottom, left],
        11: [right, bottom], 12: [right, left], 13: [top, right], 14: [left, top],
      }[code];
      for (let k = 0; k < seg.length; k += 2) d += `M${seg[k][0].toFixed(1)} ${seg[k][1].toFixed(1)}L${seg[k + 1][0].toFixed(1)} ${seg[k + 1][1].toFixed(1)}`;
    }
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.innerHTML = `<path d="${d}" style="fill:none;stroke:var(--engrave);stroke-width:1" vector-effect="non-scaling-stroke"/>`;
}
