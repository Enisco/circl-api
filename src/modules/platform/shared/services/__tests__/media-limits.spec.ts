import { MediaPurpose, MediaType } from '@prisma/client';
import {
  ITEM_MEDIA_RULES,
  POST_MEDIA_RULES,
  MAX_SELLING_VIDEO_BYTES,
  MAX_SELLING_VIDEO_MS,
  MAX_VIDEO_BYTES,
  MediaService,
  SERVICE_MEDIA_RULES,
} from '../media.service';
import { TAXONOMY_LIMITS } from '../../../taxonomy/services/taxonomy-catalogue.service';
import { SERVICE_LIMITS } from '../../../professionals/dtos/service.dto';

/**
 * The limits the client is **told** are the limits the server **holds**.
 *
 * `GET /taxonomy` serves a `limits` object so a number can change without an app release, and the
 * form enforces it. That only works while the two agree: a served ceiling the API does not apply is
 * worse than no ceiling, because the form refuses at fifty megabytes and the API quietly takes
 * ninety, and nobody can say what the product's rule actually is. v2 shipped four numbers for
 * media (§3.5, §9.2) and three of them were served without being enforced — ten service files
 * together, fifty megabytes of video, sixty seconds of it.
 *
 * Asserted against the published object rather than against literals, so changing the number in one
 * place and not the other fails here rather than in somebody's upload.
 */
describe('the published media limits', () => {
  it('caps a product or service video at the megabytes `limits` advertises', () => {
    expect(MediaService.maxBytesFor(MediaType.VIDEO, MediaPurpose.COMMERCE)).toBe(
      TAXONOMY_LIMITS.maxVideoBytes,
    );
    expect(MediaService.maxBytesFor(MediaType.VIDEO, MediaPurpose.PROFESSIONAL)).toBe(
      TAXONOMY_LIMITS.maxVideoBytes,
    );
    expect(MAX_SELLING_VIDEO_BYTES).toBe(TAXONOMY_LIMITS.maxVideoBytes);
  });

  /**
   * A story is watched once by somebody who chose to open it; a product video loads in a grid. The
   * looser cap is deliberate, and this is here so that tightening the selling rule cannot quietly
   * tighten Connect with it.
   */
  it('leaves Connect and the community on the cap they shipped with', () => {
    expect(MediaService.maxBytesFor(MediaType.VIDEO, MediaPurpose.CONNECT)).toBe(MAX_VIDEO_BYTES);
    expect(MediaService.maxBytesFor(MediaType.VIDEO, MediaPurpose.COMMUNITY)).toBe(MAX_VIDEO_BYTES);
    expect(MediaService.maxBytesFor(MediaType.VIDEO)).toBe(MAX_VIDEO_BYTES);
  });

  it('holds the service page to ten files together, which is what `maxServiceMedia` says', () => {
    expect(SERVICE_MEDIA_RULES.maxTotal).toBe(TAXONOMY_LIMITS.maxServiceMedia);
    expect(SERVICE_MEDIA_RULES.maxVideos).toBe(TAXONOMY_LIMITS.maxServiceVideos);
  });

  it('holds a product to the photos it always had, plus the videos v2 added', () => {
    expect(ITEM_MEDIA_RULES.maxImages).toBe(TAXONOMY_LIMITS.maxItemPhotos);
    expect(ITEM_MEDIA_RULES.maxVideos).toBe(TAXONOMY_LIMITS.maxItemVideos);
  });

  /**
   * §8 lists the codes the app branches on, and `MEDIA_LIMIT_REACHED` is the one for these two
   * surfaces. The platform's own `MEDIA_LIMIT_EXCEEDED` stays the default everywhere else, because
   * the community and Connect clients already branch on it.
   */
  it('refuses a v2 limit with the code the client branches on', () => {
    expect(SERVICE_MEDIA_RULES.limitCode).toBe('MEDIA_LIMIT_REACHED');
    expect(ITEM_MEDIA_RULES.limitCode).toBe('MEDIA_LIMIT_REACHED');
    expect(POST_MEDIA_RULES.limitCode).toBeUndefined();
  });

  /**
   * Not media, and here anyway: it is the same failure, which is a number the form enforces and the
   * server also enforces from somewhere else. circl-mobile was holding thirty of its own because
   * `limits` did not carry it.
   */
  it('serves the services-per-listing cap the write actually refuses on', () => {
    expect(TAXONOMY_LIMITS.maxServicesPerListing).toBe(SERVICE_LIMITS.perListing);
  });

  it('carries the sixty seconds into both sets of rules', () => {
    expect(MAX_SELLING_VIDEO_MS).toBe(TAXONOMY_LIMITS.maxVideoSeconds * 1000);
    expect(SERVICE_MEDIA_RULES.maxDurationMs).toBe(MAX_SELLING_VIDEO_MS);
    expect(ITEM_MEDIA_RULES.maxDurationMs).toBe(MAX_SELLING_VIDEO_MS);
  });
});
