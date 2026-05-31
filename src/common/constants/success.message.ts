export class SuccessMessage {
  public static readonly RESOURCE_CREATED = (resourceName: string) =>
    `${resourceName} created successfully`;
  public static readonly RESOURCE_FETCHED = (resourceName: string) =>
    `${resourceName} fetched successfully`;
  public static readonly RESOURCE_UPDATED = (resourceName: string) =>
    `${resourceName} updated successfully`;
  public static readonly RESOURCE_DELETED = (resourceName: string) =>
    `${resourceName} deleted successfully`;
  public static readonly ACTION_SUCCESSFUL = (action: string) => `${action} successfully`;
  public static readonly ACCOUNT_REGISTERED_SUCCESSFULLY = 'Account registered successfully';
  public static readonly VERIFICATION_EMAIL_SENT =
    'If this email exists, a verification code has been sent';
  public static readonly VERIFICATION_EMAIL_RESENT = 'Verification email resent';
  public static readonly EMAIL_VERIFIED_SUCCESSFULLY = 'Email verified successfully';
  public static readonly PASSWORD_RESET_EMAIL_SENT =
    'If a user with this email exists, a password reset link has been sent.';
  public static readonly PASSWORD_RESET_SUCCESSFUL = 'Password reset successfully';
  public static readonly PASSWORD_CHANGE_SUCCESSFUL = 'Password changed successfully';
  public static readonly LOGIN_OTP_SENT =
    'If an account with this email exists, a login code has been sent';
  public static readonly LOGIN_SUCCESSFUL = 'Login successful';
  public static readonly LOGOUT_SUCCESSFUL = 'Logout successful';
  public static readonly VALID_VERIFICATION_CODE = 'Code verified successfully';
  public static readonly PROFILE_UPDATED_SUCCESSFULLY = 'Profile updated successfully';
}
