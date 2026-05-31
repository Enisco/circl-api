import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const MIN_AGE = 13;

@ValidatorConstraint({ name: 'isValidBirthDate', async: false })
class IsValidBirthDateConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    if (!value) return true; // let @IsISO8601 catch missing/malformed values

    const date = new Date(value);

    if (isNaN(date.getTime())) return false;

    const now = new Date();

    if (date >= now) return false; // must be in the past

    const age = now.getFullYear() - date.getFullYear();
    const hadBirthday =
      now.getMonth() > date.getMonth() ||
      (now.getMonth() === date.getMonth() && now.getDate() >= date.getDate());

    return (hadBirthday ? age : age - 1) >= MIN_AGE;
  }

  defaultMessage(): string {
    return `Date of birth must be a past date and the user must be at least ${MIN_AGE} years old`;
  }
}

export function IsValidBirthDate(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsValidBirthDateConstraint,
    });
  };
}
