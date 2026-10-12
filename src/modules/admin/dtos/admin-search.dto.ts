import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The command palette's query (§5.27).
 *
 * In a body rather than a query string, which is the point of the endpoint being a `POST`: the
 * value is a name, an email address or a username, and §2.6 keeps member identifiers out of URLs —
 * out of the access log, the browser history and the `Referer` of the next request.
 *
 * Two characters minimum. One letter matches a good share of the platform, and a palette that
 * returns five arbitrary members on every keystroke is slower to use than no palette at all.
 */
export class AdminSearchDto {
  @ApiProperty({ description: 'A name, username, email address, or an id.', minLength: 2 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  q!: string;
}
