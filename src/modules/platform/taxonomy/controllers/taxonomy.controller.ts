import { Controller, Get, Header, HttpCode, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { Public } from '@/common';
import { TaxonomyCatalogueService } from '../services/taxonomy-catalogue.service';

@Controller('taxonomy')
@ApiTags('Taxonomy')
export class TaxonomyController {
  constructor(private readonly catalogue: TaxonomyCatalogueService) {}

  /**
   * Public and cacheable (0.8). Every enumerated list the app renders, in one
   * call, so wording lives in one place and a rewording needs no app release.
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary: 'Every enumerated list the app renders',
    description:
      'Codes, labels, sort order and active flags for every taxonomy in the product, plus the ' +
      'city list. Served with an ETag; send If-None-Match to get a 304.',
  })
  @ApiOkResponse({ description: 'The full taxonomy catalogue.' })
  async get(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const data = await this.catalogue.build();

    // The version stamp is what changes when anything in here changes, so it is
    // the natural ETag. Hashed so it is opaque and quote-safe.
    const etag = `"${createHash('sha1').update(data.version).digest('hex')}"`;

    response.setHeader('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    return { data, message: 'Taxonomy loaded' };
  }
}
