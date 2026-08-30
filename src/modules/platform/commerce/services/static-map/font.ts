/**
 * A 5x7 bitmap font covering exactly the characters in "© OpenStreetMap contributors".
 *
 * It exists so the OpenStreetMap attribution is burned into the tile rather than sent as a field
 * the client may or may not render. The ODbL requires the credit; making compliance depend on
 * somebody else's layout code is how it ends up missing.
 */
const GLYPHS: Record<string, string[]> = {
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
  '©': [' ### ', '#   #', '# ## ', '# #  ', '# ## ', '#   #', ' ### '],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #', '#   #', '#   #'],
  a: ['     ', '     ', ' ### ', '    #', ' ####', '#   #', ' ####'],
  b: ['#    ', '#    ', '#### ', '#   #', '#   #', '#   #', '#### '],
  c: ['     ', '     ', ' ### ', '#    ', '#    ', '#    ', ' ### '],
  e: ['     ', '     ', ' ### ', '#   #', '#####', '#    ', ' ### '],
  i: ['  #  ', '     ', ' ##  ', '  #  ', '  #  ', '  #  ', ' ### '],
  n: ['     ', '     ', '#### ', '#   #', '#   #', '#   #', '#   #'],
  o: ['     ', '     ', ' ### ', '#   #', '#   #', '#   #', ' ### '],
  p: ['     ', '     ', '#### ', '#   #', '#### ', '#    ', '#    '],
  r: ['     ', '     ', '# ## ', '##   ', '#    ', '#    ', '#    '],
  s: ['     ', '     ', ' ####', '#    ', ' ### ', '    #', '#### '],
  t: ['  #  ', '  #  ', '#####', '  #  ', '  #  ', '  #  ', '   ##'],
  u: ['     ', '     ', '#   #', '#   #', '#   #', '#   #', ' ####'],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** One blank column between characters. */
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export const textWidth = (text: string): number => text.length * GLYPH_ADVANCE - 1;

/** Calls back with each lit pixel, so the caller owns the raster and the colour. */
export const eachTextPixel = (
  text: string,
  originX: number,
  originY: number,
  plot: (x: number, y: number) => void,
): void => {
  for (const [index, character] of [...text].entries()) {
    const glyph = GLYPHS[character];

    // An unmapped character is skipped rather than drawn as a box: the attribution is fixed text,
    // so anything missing here is a bug in this file, not in the input.
    if (!glyph) continue;

    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (glyph[row][column] === '#') {
          plot(originX + index * GLYPH_ADVANCE + column, originY + row);
        }
      }
    }
  }
};
