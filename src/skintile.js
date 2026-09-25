// Bare-skin tile (neck, hands, skull): the face's skin tone with a soft, fine mottle. 64 px, periodic
// value noise (seamless when repeated), +-4%: a coarse 16 px tile read as blocky checkers next to the
// photo face. Deterministic.
export function paintSkinTile(canvas, [r, g, b]) {
  const N = 64;
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d'), img = ctx.createImageData(N, N);
  const hash = (x, y, s) => ((Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453) % 1 + 1) % 1;
  const noise = (x, y, period, s) => { // periodic bilinear value noise, smoothstepped
    const fx = (x / N) * period, fy = (y / N) * period, ix = Math.floor(fx), iy = Math.floor(fy);
    const u = fx - ix, v = fy - iy, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const h = (a, b) => hash(((a % period) + period) % period, ((b % period) + period) % period, s);
    return (h(ix, iy) * (1 - su) + h(ix + 1, iy) * su) * (1 - sv) + (h(ix, iy + 1) * (1 - su) + h(ix + 1, iy + 1) * su) * sv;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const n = 0.96 + 0.05 * noise(x, y, 8, 1) + 0.03 * noise(x, y, 16, 2);
    const o = (y * N + x) * 4;
    img.data[o] = Math.min(255, r * n * 255); img.data[o + 1] = Math.min(255, g * n * 255); img.data[o + 2] = Math.min(255, b * n * 255); img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
