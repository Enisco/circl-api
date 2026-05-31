export class ErrorMessage {
  public static readonly GENERAL_ERROR =
    'An unexpected error occurred. Please try again later or contact support if the problem persists.';
  public static readonly INTERNAL_SERVER_ERROR: 'An unexpected error occurred. Please try again later or contact support if the problem persists.';
  public static readonly ACCESS_DENIED = 'Access denied';
  public static readonly UNAUTHORIZED = 'Unauthorized access. Please provide valid credentials';
  public static readonly NOT_AUTHORIZED = 'You are not authorized to access this resource';
  public static readonly NO_PERMISSION_FOR_ACTION = (action: string, resourceName: string) =>
    `You do not have permission to ${action} this ${resourceName}`;
  public static readonly INVALID_CREDENTIALS = 'The provided credentials are incorrect';
  public static readonly RESOURCE_NOT_FOUND = (resourceName: string) =>
    `No ${resourceName} was found with the provided information`;
  public static readonly RESOURCE_ALREADY_EXISTS = (resourceName: string) =>
    `${resourceName} with the provided information already exists`;
  public static readonly INVALID_CURRENT_PASSWORD = 'Invalid current password';
  public static readonly NO_REQUIRED_PERMISSIONS =
    'You do not have the required permissions to carry out this action';
  public static readonly INVALID_REFRESH_TOKEN = 'Invalid refresh token';
  public static readonly INVALID_VERIFICATION_CODE = 'Invalid verification code';
  public static readonly INVALID_RESET_TOKEN = 'Invalid password reset token';
  public static readonly EMAIL_NOT_VERIFIED =
    'Email not verified. Please verify your email before logging in.';
  public static readonly ACCOUNT_BLOCKED =
    'Account locked due to multiple failed login attempts. Please wait 15 minutes before trying again.';
  public static readonly FAILED_TO_CREATE = (resourceName: string) =>
    `Failed to create ${resourceName}`;
  public static readonly FAILED_TO_UPDATE = (resourceName: string) =>
    `Failed to update ${resourceName}`;
  public static readonly FAILED_TO_DELETE = (resourceName: string) =>
    `Failed to delete ${resourceName}`;
  public static readonly SESSION_EXPIRED = 'Session expired. Please log in again';
  public static readonly INVALID_SIGNUP_TOKEN = 'Invalid or malformed signup token';
  public static readonly SIGNUP_TOKEN_EXPIRED =
    'Signup token has expired. Please verify your email again';
  public static readonly INVALID_SOCIAL_TOKEN = 'Social identity token could not be verified';
  public static readonly SOCIAL_TOKEN_EXPIRED = 'Social identity token has expired';
  public static readonly SOCIAL_EMAIL_MISMATCH = 'Email in token does not match the provided email';
  public static readonly PASSWORD_SAME_AS_OLD =
    'Your new password cannot be a recently used password. Please choose a different password';
}
