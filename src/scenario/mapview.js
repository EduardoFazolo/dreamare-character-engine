// Draws the world map: soft biome colours that fade into each other at the borders, little glyphs for what
// grows there, region names, and outlines for the hovered / selected region.
import { mapColor } from './biomes.js';
import { regionCells, centroid } from './world.js';
import { hash2 } from './util.js';

export const CELL = 10; // canvas pixels per map cell

let paper = null;
function paperPattern(ctx) {
  if (paper) return paper;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = '#1b1820'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) { const v = 20 + Math.random() * 18; g.fillStyle = `rgba(${v + 8},${v + 4},${v + 12},0.5)`; g.fillRect(Math.random() * 128 | 0, Math.random() * 128 | 0, 1, 1); }
  paper = ctx.createPattern(c, 'repeat');
  return paper;
}

const shade = (c, k) => `rgb(${c.map((v) => Math.max(0, Math.min(255, v * k)) | 0).join(',')})`;

function glyph(g, kind, x, y, c) {
  g.strokeStyle = g.fillStyle = c; g.lineWidth = 1;
  g.beginPath();
  switch (kind) {
    case 'pine': g.moveTo(x, y - 4); g.lineTo(x + 3, y + 2); g.lineTo(x - 3, y + 2); g.closePath(); g.fill(); break;
    case 'broadleaf': g.arc(x, y - 1, 2.6, 0, 7); g.fill(); g.fillRect(x - 0.5, y + 1, 1, 2); break;
    case 'birch': g.arc(x, y - 2, 1.8, 0, 7); g.fill(); g.fillRect(x - 0.5, y, 1, 3); break;
    case 'willow': g.arc(x, y - 1, 3, Math.PI, 0); g.fill(); g.moveTo(x - 3, y - 1); g.lineTo(x - 3, y + 2); g.moveTo(x + 3, y - 1); g.lineTo(x + 3, y + 2); g.stroke(); break;
    case 'mushroom': g.arc(x, y - 1, 3, Math.PI, 0); g.fill(); g.fillRect(x - 0.6, y - 1, 1.2, 3.5); break;
    case 'dead': g.moveTo(x, y + 3); g.lineTo(x, y - 2); g.lineTo(x - 2, y - 4); g.moveTo(x, y - 1); g.lineTo(x + 2, y - 3); g.stroke(); break;
    case 'house': g.fillRect(x - 2.5, y - 1, 5, 3.5); g.moveTo(x - 3.5, y - 1); g.lineTo(x, y - 4); g.lineTo(x + 3.5, y - 1); g.closePath(); g.fill(); break;
    case 'rock': g.arc(x, y, 1.4, 0, 7); g.fill(); break;
    case 'wave': g.moveTo(x - 4, y); g.quadraticCurveTo(x - 2, y - 2, x, y); g.quadraticCurveTo(x + 2, y + 2, x + 4, y); g.stroke(); break;
    case 'field': g.moveTo(x - 3, y - 2); g.lineTo(x + 3, y - 2); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.moveTo(x - 3, y + 2); g.lineTo(x + 3, y + 2); g.stroke(); break;
    case 'tower': g.moveTo(x, y - 5); g.lineTo(x + 2, y + 3); g.moveTo(x, y - 5); g.lineTo(x - 2, y + 3); g.stroke(); g.fillStyle = '#ff3a2a'; g.fillRect(x - 0.7, y - 6.5, 1.4, 1.4); break;
  }
}

function outline(g, world, id, color, width, dash = []) {
  g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath();
  for (const [x, y] of regionCells(world, id)) {
    const X = x * CELL, Y = y * CELL, own = (a, b) => (a >= 0 && b >= 0 && a < world.w && b < world.h ? world.cells[b * world.w + a] : -9) === id;
    if (!own(x, y - 1)) { g.moveTo(X, Y); g.lineTo(X + CELL, Y); }
    if (!own(x, y + 1)) { g.moveTo(X, Y + CELL); g.lineTo(X + CELL, Y + CELL); }
    if (!own(x - 1, y)) { g.moveTo(X, Y); g.lineTo(X, Y + CELL); }
    if (!own(x + 1, y)) { g.moveTo(X + CELL, Y); g.lineTo(X + CELL, Y + CELL); }
  }
  g.stroke(); g.setLineDash([]);
}

export function drawMap(canvas, world, { selected = null, hover = null } = {}) {
  const W = world.w * CELL, H = world.h * CELL;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext('2d');
  g.fillStyle = paperPattern(g); g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(160,150,180,.10)'; // faint survey dots over unclaimed land
  for (let y = 2; y < world.h; y += 4) for (let x = 2; x < world.w; x += 4) g.fillRect(x * CELL, y * CELL, 1.5, 1.5);

  // biome colours: one pixel per cell, scaled up blurred so neighbouring regions fade into each other
  const small = document.createElement('canvas'); small.width = world.w; small.height = world.h;
  const sg = small.getContext('2d'), img = sg.createImageData(world.w, world.h), colors = new Map();
  for (const reg of world.regions) colors.set(reg.id, mapColor(reg.biome));
  world.cells.forEach((o, i) => { if (o < 0) return; const c = colors.get(o); img.data.set([c[0], c[1], c[2], 255], i * 4); });
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.save(); g.filter = 'blur(7px)'; g.globalAlpha = 0.55; g.drawImage(small, 0, 0, W, H); g.restore(); // soft shores into the unknown
  g.save(); g.filter = 'blur(2.5px)'; g.drawImage(small, 0, 0, W, H); g.restore();

  // glyphs: what grows / stands there, sprinkled deterministically per cell
  for (const reg of world.regions) {
    const b = reg.biome, c = colors.get(reg.id), ink = shade(c, 0.5), cells = regionCells(world, reg.id);
    const treeP = b.trees !== 'none' ? Math.min(0.55, b.treeDensity * 0.9 + 0.05) : 0;
    for (const [x, y] of cells) {
      const h = hash2(x, y, reg.seed), X = x * CELL + CELL / 2 + (hash2(y, x, reg.seed) - 0.5) * 4, Y = y * CELL + CELL / 2 + (hash2(x + 3, y, reg.seed) - 0.5) * 4;
      const edgeFree = b.water && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oy]) => { const xx = x + ox, yy = y + oy; return xx < 0 || yy < 0 || xx >= world.w || yy >= world.h || world.cells[yy * world.w + xx] === -1; });
      if (edgeFree && h < 0.7) glyph(g, 'wave', X, Y, shade([120, 150, 170], 0.9));
      else if (h < treeP) glyph(g, b.trees, X, Y, ink);
      else if (h < treeP + b.rocks * 0.15) glyph(g, 'rock', X, Y, ink);
      else if (b.fields > 0.05 && h > 0.93) glyph(g, 'field', X, Y, ink);
    }
    const [cx, cy] = centroid(world, reg.id);
    if (b.house || b.houses) for (let i = 0; i < 1 + Math.round(b.houses); i++) glyph(g, 'house', (cx + (i % 3) * 1.2 - 1) * CELL, (cy + 1.4 + Math.floor(i / 3)) * CELL, shade(c, 0.35));
    if (b.tower) glyph(g, 'tower', (cx + 2.2) * CELL, (cy - 1.5) * CELL, shade(c, 0.35));
  }

  // outlines and names
  for (const reg of world.regions) if (reg.locked) outline(g, world, reg.id, 'rgba(236,230,214,.35)', 1, [3, 3]);
  if (hover != null && hover !== selected) outline(g, world, hover, 'rgba(236,230,214,.6)', 1);
  if (selected != null) outline(g, world, selected, '#e0b04a', 2);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const labels = []; // placed label boxes: a label that would overlap one slides down/up until it doesn't
  const order = [...world.regions].sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : 0));
  for (const reg of order) {
    const [cx, cy] = centroid(world, reg.id), text = (reg.locked ? '⚿ ' : '') + reg.name;
    g.font = `italic ${reg.id === selected ? 15 : 13}px Georgia, "Times New Roman", serif`;
    const w = g.measureText(text).width + 6, h = 16, x = (cx + 0.5) * CELL;
    let y = (cy + 0.5) * CELL;
    for (let k = 1; k < 12 && labels.some((l) => Math.abs(l.x - x) < (l.w + w) / 2 && Math.abs(l.y - y) < h); k++) y = (cy + 0.5) * CELL + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * h;
    labels.push({ x, y, w });
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 4;
    g.fillStyle = reg.id === selected ? '#f4e4b0' : '#ece6d6';
    g.fillText(text, x, y);
    g.shadowBlur = 0;
  }
  if (!world.regions.length) {
    g.font = 'italic 18px Georgia, serif'; g.fillStyle = 'rgba(236,230,214,.55)';
    g.fillText('click anywhere to drop the first region', W / 2, H / 2);
  }
}

export function cellAt(canvas, world, e) {
  const rect = canvas.getBoundingClientRect();
  return [Math.floor(((e.clientX - rect.left) / rect.width) * world.w), Math.floor(((e.clientY - rect.top) / rect.height) * world.h)];
}
