import { Controller, Get, Header, HttpCode, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '@/common';
import { TaxonomyCatalogueService } from '../services/taxonomy-catalogue.service';

@Controller('taxonomy')
@ApiTags('Taxonomy')
export class TaxonomyController {
  constructor(private readonly catalogue: TaxonomyCatalogueService) {}

  /** Public and cacheable (0.8). */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  // An hour, because the client asks once per launch and a label reworded in the portal is not
  // worth a round trip on every warm start. The ETag makes the ask free where it happens anyway.
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({
    summary: 'Every enumerated list the app renders',
    description:
      'Codes, labels, sort order and active flags for every taxonomy in the product, plus the ' +
      'city list, the limits the server enforces and the rule text behind the filters.\n\n' +
      '**`version` is a hash of the payload**, not a timestamp: it changes when and only when ' +
      'something in here changes, so a client can tell a real change from a no-op without ' +
      'diffing. It is also the ETag — send `If-None-Match` and an unchanged catalogue is a `304`.\n\n' +
      '**Deactivated terms are still sent**, marked `isActive: false`. A picker stops offering ' +
      'them; a record already filed under the code still resolves to a label rather than showing ' +
      'a blank or a raw code. Nothing is ever deleted from a vocabulary that has shipped.',
  })
  @ApiOkResponse({ description: 'The full taxonomy catalogue.' })
  async get(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const data = await this.catalogue.build();

    // The version IS a hash of the payload, so it is the ETag.
    const etag = `"${data.version}"`;

    response.setHeader('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    return { data, message: 'Taxonomy loaded' };
  }
}
