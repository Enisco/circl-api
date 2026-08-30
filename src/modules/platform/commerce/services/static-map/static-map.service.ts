import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { StorageProvider } from '../../../media/storage/storage.interface';
import { renderTiles } from './tiles';

/** The doc's dimensions: a strip above the address, not a square. */
export const MAP_WIDTH = 640;
export const MAP_HEIGHT = 220;
/** Close enough to read the street, far enough not to be a doorstep. */
export const MAP_ZOOM = 15;

const FETCH_TIMEOUT_MS = 8_000;

type Provider = 'osm' | 'mapbox' | 'google' | 'template' | 'none';

/**
 * A map image rendered server-side (G12).
 *
 * The reasoning is the one that put S3 signing on the server: if the client renders the tile it
 * has to hold the provider key, and a key in an app binary is a key that has leaked. So the
 * server fetches it once, writes it to the bucket like any other media, and hands back a signed
 * URL that expires.
 */
@Injectable()
export class StaticMapService {
  private readonly logger = new Logger(StaticMapService.name);
  private readonly provider: Provider;
  private readonly apiKey: string | null;
  private readonly template: string | null;
  private readonly tileTemplate: string;

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
    config: ConfigService,
  ) {
    this.apiKey = config.get<string>('MAP_API_KEY') || null;
    this.template = config.get<string>('MAP_STATIC_URL_TEMPLATE') || null;
    // Community tiles, so the feature works with no account. A deployment with real traffic should
    // set MAP_PROVIDER to one it pays for.
    this.tileTemplate =
      config.get<string>('MAP_TILE_URL_TEMPLATE') || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    this.provider = this.resolveProvider(config.get<string>('MAP_PROVIDER'));
  }

  get isConfigured(): boolean {
    return this.provider !== 'none';
  }

  /**
   * The key for a store's map, generating it on first use. Returns null when there is nothing to
   * draw or no provider to draw it with — the caller sends `staticMapUrl: null` and the client
   * renders its placeholder, which is the honest outcome.
   */
  async keyFor(store: {
    id: string;
    latitude: number | null;
    longitude: number | null;
    hidesExactAddress: boolean;
    staticMapKey: string | null;
  }): Promise<string | null> {
    // A store that hides its address gets no tile at all. An image centred on a doorstep is the
    // address however carefully the numbers beside it were rounded.
    if (store.hidesExactAddress) return null;
    if (store.latitude === null || store.longitude === null) return null;
    if (!this.isConfigured) return null;

    const key = this.keyName(store.id, store.latitude, store.longitude);

    // The key encodes the coordinates, so a store that moves gets a new one rather than serving
    // the old neighbourhood from cache.
    if (store.staticMapKey === key) return key;

    const bytes = await this.render(store.latitude, store.longitude);

    if (!bytes) return null;

    await this.storage.put(key, bytes, 'image/png');
    await this.database.store.update({ where: { id: store.id }, data: { staticMapKey: key } });

    if (store.staticMapKey && store.staticMapKey !== key) {
      await this.storage.delete(store.staticMapKey).catch(() => undefined);
    }

    return key;
  }

  /** Fire-and-forget backfill, so serving a store never waits on a map provider. */
  ensure(store: Parameters<StaticMapService['keyFor']>[0]): void {
    if (store.hidesExactAddress || !this.isConfigured) return;
    if (store.latitude === null || store.longitude === null) return;
    if (store.staticMapKey === this.keyName(store.id, store.latitude, store.longitude)) return;

    void this.keyFor(store).catch(error =>
      this.logger.warn(`Static map for store ${store.id} not built: ${(error as Error).message}`),
    );
  }

  private keyName(storeId: string, latitude: number, longitude: number): string {
    const stamp = createHash('sha256')
      .update(`${latitude.toFixed(5)},${longitude.toFixed(5)},${MAP_ZOOM},${MAP_WIDTH}x${MAP_HEIGHT}`)
      .digest('hex')
      .slice(0, 12);

    return `circl/maps/${storeId}/${stamp}.png`;
  }

  private async render(latitude: number, longitude: number): Promise<Buffer | null> {
    try {
      if (this.provider === 'osm') {
        return await renderTiles({
          latitude,
          longitude,
          zoom: MAP_ZOOM,
          width: MAP_WIDTH,
          height: MAP_HEIGHT,
          tileUrl: (z, x, y) =>
            this.tileTemplate
              .replace('{z}', String(z))
              .replace('{x}', String(x))
              .replace('{y}', String(y)),
          fetchTile: url => this.fetch(url),
        });
      }

      return await this.fetch(this.composedUrl(latitude, longitude));
    } catch (error) {
      this.logger.warn(`Static map render failed: ${(error as Error).message}`);

      return null;
    }
  }

  /** Providers that return the whole image in one request. */
  private composedUrl(latitude: number, longitude: number): string {
    const fill = (template: string) =>
      template
        .replace(/{lat}/g, String(latitude))
        .replace(/{lng}/g, String(longitude))
        .replace(/{zoom}/g, String(MAP_ZOOM))
        .replace(/{width}/g, String(MAP_WIDTH))
        .replace(/{height}/g, String(MAP_HEIGHT))
        .replace(/{key}/g, this.apiKey ?? '');

    if (this.provider === 'template' && this.template) return fill(this.template);

    if (this.provider === 'mapbox') {
      return fill(
        'https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/' +
          'pin-l+d63d2b({lng},{lat})/{lng},{lat},{zoom},0/{width}x{height}@2x' +
          '?access_token={key}&attribution=true&logo=true',
      );
    }

    return fill(
      'https://maps.googleapis.com/maps/api/staticmap' +
        '?center={lat},{lng}&zoom={zoom}&size={width}x{height}&scale=2' +
        '&markers=color:red%7C{lat},{lng}&key={key}',
    );
  }

  private async fetch(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Every OSM tile server asks for an identifying agent, and serves 403s without one.
      headers: { 'User-Agent': 'circl-api/1.0 (+https://circl.app)' },
    });

    if (!response.ok) throw new Error(`Map provider returned ${response.status}`);

    return Buffer.from(await response.arrayBuffer());
  }

  private resolveProvider(configured: string | undefined): Provider {
    const name = (configured ?? '').toLowerCase();

    if (name === 'none') return 'none';
    if (name === 'template') return this.template ? 'template' : this.warnUnset('template');
    if (name === 'mapbox') return this.apiKey ? 'mapbox' : this.warnUnset('mapbox');
    if (name === 'google') return this.apiKey ? 'google' : this.warnUnset('google');

    // Nothing configured falls back to community tiles, which need no account, so a fresh
    // checkout renders a map rather than a grey box.
    return 'osm';
  }

  private warnUnset(name: string): Provider {
    this.logger.warn(`MAP_PROVIDER=${name} needs a key or template; falling back to OSM tiles.`);

    return 'osm';
  }
}
