import { ACCEPTANCE_CAP, OFFER_TTL_HOURS, titleFrom } from '../service-request-offer.service';

/**
 * The two numbers and the one string that the rest of the feature is written around.
 *
 * The cap and the window are asserted because they are quoted in three other places — the Swagger
 * description, the member's screen and the message a refused professional reads — and a change to
 * either is a product decision rather than a tuning knob.
 */
describe('service request offers', () => {
  it('caps acceptances at three, which is a promise to the member', () => {
    expect(ACCEPTANCE_CAP).toBe(3);
  });

  it('lets an unanswered offer stand for 72 hours', () => {
    expect(OFFER_TTL_HOURS).toBe(72);
  });

  describe('the thread title, drawn from the member’s own words', () => {
    it('uses the first sentence where there is one', () => {
      expect(titleFrom('My landlord kept my deposit. I want to challenge it.')).toBe(
        'My landlord kept my deposit',
      );
    });

    it('takes the whole thing when it is short and unpunctuated', () => {
      expect(titleFrom('Blocked drain')).toBe('Blocked drain');
    });

    /** A title that stops mid-word reads as a bug rather than as a summary. */
    it('cuts long ones on a word boundary', () => {
      const title = titleFrom(
        'I need somebody who can look at a tenancy agreement and tell me whether the break clause means what I think it means',
      );

      expect(title.endsWith('…')).toBe(true);
      expect(title.length).toBeLessThanOrEqual(61);
      expect(title).not.toMatch(/\s…$/);
      // Whole words only: the character before the ellipsis is the end of one.
      expect(title.slice(0, -1).split(' ').pop()).toBeTruthy();
    });

    it('survives a description that is one very long word', () => {
      const title = titleFrom('x'.repeat(200));

      expect(title.length).toBeLessThanOrEqual(61);
    });

    it('falls back to the whole description when the first clause is empty', () => {
      expect(titleFrom('. Something after a stray full stop')).toBe(
        '. Something after a stray full stop',
      );
    });

    it('treats a newline as the end of the title', () => {
      expect(titleFrom('Help with my visa\nI am on a spouse route and the deadline is close')).toBe(
        'Help with my visa',
      );
    });
  });
});
