import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ReactDto } from '../message.dto';

const accepts = (emoji: string): boolean =>
  validateSync(plainToInstance(ReactDto, { emoji })).length === 0;

describe('ReactDto.emoji', () => {
  it('takes one emoji as the keyboard produced it', () => {
    expect(accepts('👍')).toBe(true);
    expect(accepts('❤️')).toBe(true);
    expect(accepts('🙏')).toBe(true);
  });

  it('keeps a skin tone and a ZWJ sequence, which are one emoji each', () => {
    // `👍🏾` is two code points and one emoji; a family is several and still one.
    expect(accepts('👍🏾')).toBe(true);
    expect(accepts('👩‍👩‍👧')).toBe(true);
    // A subdivision flag is seven code points and 28 bytes, and still one emoji.
    expect(accepts('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe(true);
  });

  it('refuses anything that is not a single emoji, or the chips become a text field', () => {
    expect(accepts('abc')).toBe(false);
    expect(accepts('👍👍')).toBe(false);
    expect(accepts('a')).toBe(false);
    expect(accepts('')).toBe(false);
    // One grapheme, past the byte cap, which is the bound against a pathological ZWJ chain.
    expect(accepts('👩‍👩‍👩‍👩‍👩‍👩‍👩‍👩')).toBe(false);
  });
});
