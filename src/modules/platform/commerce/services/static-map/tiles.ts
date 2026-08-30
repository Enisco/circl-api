import { decodePng, encodePng, Raster } from './png';
import { eachTextPixel, GLYPH_HEIGHT, textWidth } from './font';

export const TILE_SIZE = 256;
const ATTRIBUTION = '© OpenStreetMap contributors';

/** Slippy-map projection (the standard used by every XYZ tile server). */
export const project = (latitude: number, longitude: number, zoom: number) => {
  const scale = TILE_SIZE * 2 ** zoom;
  const sinLatitude = Math.sin((latitude * Math.PI) / 180);

  return {
    x: ((longitude + 180) / 360) * scale,
    y:
      (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  };
};

/**
 * Fetches the tiles a viewport covers and composites them into one image, with a marker in the
 * middle and the attribution burned into the corner.
 *
 * Doing this here rather than in the app is the whole point: a client that renders its own tiles
 * has to ship a provider key, and a key in a binary is a key that has leaked.
 */
export const renderTiles = async (options: {
  latitude: number;
  longitude: number;
  zoom: number;
  width: number;
  height: number;
  tileUrl: (z: number, x: number, y: number) => string;
  fetchTile: (url: string) => Promise<Buffer>;
}): Promise<Buffer> => {
  const { latitude, longitude, zoom, width, height } = options;
  const centre = project(latitude, longitude, zoom);
  const left = centre.x - width / 2;
  const top = centre.y - height / 2;

  const firstTileX = Math.floor(left / TILE_SIZE);
  const firstTileY = Math.floor(top / TILE_SIZE);
  const lastTileX = Math.floor((left + width - 1) / TILE_SIZE);
  const lastTileY = Math.floor((top + height - 1) / TILE_SIZE);

  // A neutral ground, so a tile that fails to load leaves a blank rather than a black hole.
  const canvas: Raster = { width, height, data: Buffer.alloc(width * height * 3, 0xe8) };
  const span = 2 ** zoom;

  const jobs: Array<Promise<void>> = [];

  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      // Out of range vertically is genuinely nothing; horizontally the world wraps.
      if (tileY < 0 || tileY >= span) continue;

      const wrappedX = ((tileX % span) + span) % span;
      const offsetX = Math.round(tileX * TILE_SIZE - left);
      const offsetY = Math.round(tileY * TILE_SIZE - top);

      jobs.push(
        options
          .fetchTile(options.tileUrl(zoom, wrappedX, tileY))
          .then(bytes => blit(canvas, decodePng(bytes), offsetX, offsetY))
          // One missing tile is a grey square, not a failed map.
          .catch(() => undefined),
      );
    }
  }

  await Promise.all(jobs);

  drawMarker(canvas, Math.round(width / 2), Math.round(height / 2));
  drawAttribution(canvas);

  return encodePng(canvas);
};

/** Copies a tile onto the canvas, clipped to it. */
const blit = (canvas: Raster, tile: Raster, offsetX: number, offsetY: number): void => {
  for (let row = 0; row < tile.height; row += 1) {
    const y = offsetY + row;

    if (y < 0 || y >= canvas.height) continue;

    for (let column = 0; column < tile.width; column += 1) {
      const x = offsetX + column;

      if (x < 0 || x >= canvas.width) continue;

      const from = (row * tile.width + column) * 3;
      const to = (y * canvas.width + x) * 3;

      canvas.data[to] = tile.data[from];
      canvas.data[to + 1] = tile.data[from + 1];
      canvas.data[to + 2] = tile.data[from + 2];
    }
  }
};

const setPixel = (canvas: Raster, x: number, y: number, rgb: [number, number, number]): void => {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;

  const at = (y * canvas.width + x) * 3;

  canvas.data[at] = rgb[0];
  canvas.data[at + 1] = rgb[1];
  canvas.data[at + 2] = rgb[2];
};

/** A filled disc with a white ring, which reads at any tile brightness. */
const drawMarker = (canvas: Raster, centreX: number, centreY: number): void => {
  const outer = 9;
  const inner = 6;

  for (let dy = -outer; dy <= outer; dy += 1) {
    for (let dx = -outer; dx <= outer; dx += 1) {
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= inner) setPixel(canvas, centreX + dx, centreY + dy, [214, 61, 43]);
      else if (distance <= outer) setPixel(canvas, centreX + dx, centreY + dy, [255, 255, 255]);
    }
  }
};

/** Burned in rather than left to the client: the ODbL credit is not optional. */
const drawAttribution = (canvas: Raster): void => {
  const padding = 3;
  const boxWidth = textWidth(ATTRIBUTION) + padding * 2;
  const boxHeight = GLYPH_HEIGHT + padding * 2;
  const originX = canvas.width - boxWidth;
  const originY = canvas.height - boxHeight;

  for (let y = originY; y < canvas.height; y += 1) {
    for (let x = originX; x < canvas.width; x += 1) {
      const at = (y * canvas.width + x) * 3;

      // Washed towards white rather than painted over, so the map stays visible under it.
      canvas.data[at] = Math.round(canvas.data[at] * 0.25 + 255 * 0.75);
      canvas.data[at + 1] = Math.round(canvas.data[at + 1] * 0.25 + 255 * 0.75);
      canvas.data[at + 2] = Math.round(canvas.data[at + 2] * 0.25 + 255 * 0.75);
    }
  }

  eachTextPixel(ATTRIBUTION, originX + padding, originY + padding, (x, y) =>
    setPixel(canvas, x, y, [40, 40, 40]),
  );
};
