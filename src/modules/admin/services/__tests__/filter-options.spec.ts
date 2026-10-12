import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AnalyticsTabQueryDto } from '../../controllers/admin-analytics.controller';

/**
 * The filter bar's options and the filter's own validation, checked against each other.
 *
 * The failure this prevents is the one a staff member cannot diagnose: a dropdown offering a value
 * the API rejects. They select a country, get a 400, and have no way to tell a refused filter from
 * a city with nobody in it. Asserting that the service imports the right constant would be
 * tautological — so this takes each option the service publishes and **sends it back through the
 * validator**, which is what a request will actually do.
 */
describe('filter options round-trip through the filter', () => {
  /** What `AdminFilterOptionsService` publishes, by response key, with a representative value. */
  const published: Array<[string, string]> = [
    ['cityIds', 'LONDON'],
    ['gender', 'NON_BINARY'],
    ['ageBands', 'AGE_25_34'],
    ['countriesOfOrigin', 'NG'],
    ['heritage', 'WEST_AFRICAN'],
    ['journeyStages', 'JUST_ARRIVED'],
    ['interests', 'FOOD_COOKING'],
    ['languages', 'YORUBA'],
    ['platforms', 'IOS'],
    ['appVersions', '2.1.0'],
    ['signupMethods', 'EMAIL'],
    ['statuses', 'ACTIVE'],
    ['categories', 'HOUSING'],
    ['guideTopics', 'HOUSING'],
    ['professions', 'IMMIGRATION'],
    ['connectionTypes', 'FRIENDSHIP'],
    ['storeTypes', 'GROCERY'],
    ['itemCategories', 'FRESH_FROZEN'],
    ['reasonCodes', 'SPAM'],
    ['riskCategories', 'SCAM'],
  ];

  const errorsFor = (field: string, value: string) =>
    validateSync(plainToInstance(AnalyticsTabQueryDto, { [field]: value }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each(published)('%s is a filter the request accepts', (field, value) => {
    expect(errorsFor(field, value).map(error => error.property)).toEqual([]);
  });

  /**
   * And the other direction: a key the DTO does not declare is refused globally
   * (`forbidNonWhitelisted`), so publishing one would hand the portal a filter it cannot send.
   */
  it('refuses a field the filter does not declare', () => {
    expect(errorsFor('notAFilter', 'x').map(error => error.property)).toEqual(['notAFilter']);
  });

  /** The enum-backed lists must refuse a value outside themselves, or the option list is decorative. */
  it.each([
    ['gender', 'ROBOT'],
    ['ageBands', 'AGE_200'],
    ['platforms', 'WINDOWS_PHONE'],
    ['signupMethods', 'CARRIER_PIGEON'],
    ['statuses', 'HIBERNATING'],
    ['reasonCodes', 'BAD_VIBES'],
    ['riskCategories', 'MILD_PERIL'],
  ])('%s refuses %s', (field, value) => {
    expect(errorsFor(field, value).length).toBeGreaterThan(0);
  });
});
