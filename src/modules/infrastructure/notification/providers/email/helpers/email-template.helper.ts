import {
  ACCOUNT_BLOCKED,
  ACCOUNT_CREATED,
  ACCOUNT_VERIFIED,
  USER_FORGOT_PASSWORD,
  USER_LOGIN_OTP,
} from '@/common';
import { NotificationEvent } from '../../../interfaces';
import {
  accountBlockedTemplate,
  accountVerificationTemplate,
  forgotPasswordTemplate,
  loginOtpTemplate,
  welcomeTemplate,
} from '../views';
import { EmailTemplateData } from '../views/interfaces';

export const getTemplateForEvent = (eventName: string) => {
  switch (eventName) {
    case ACCOUNT_CREATED:
      return accountVerificationTemplate;
    case ACCOUNT_BLOCKED:
      return accountBlockedTemplate;
    case USER_LOGIN_OTP:
      return loginOtpTemplate;
    case ACCOUNT_VERIFIED:
      return welcomeTemplate;
    case USER_FORGOT_PASSWORD:
      return forgotPasswordTemplate;
    default:
      throw new Error(`No template found for event: ${eventName}`);
  }
};

/**
 * Preview text is the text that is displayed in the email preview.
 */
export const getDefaultTemplateData = (userName: string): EmailTemplateData => ({
  previewText: '',
  greeting: 'Hi', // this is the greeting message in the email, e.g Hi, Hello, Dear, etc.
  userName, // the name of the email recipient
  closingMessage: 'Warm Regards,', // this is the closing message in the email
  signature: 'Circl Support Team', // this is the signature of the email, can be the company name or a person's name, etc.
  tagline: '', // this can be the company tagline or a short description, designation etc.
});

export const getTemplateData = (event: NotificationEvent): EmailTemplateData => {
  const defaultTemplateData = getDefaultTemplateData(event.userName);

  switch (event.eventName) {
    case ACCOUNT_CREATED:
      return {
        ...defaultTemplateData,
        previewText: '',
        code: event.verificationCode,
      };
    case ACCOUNT_VERIFIED:
      return {
        ...defaultTemplateData,
        previewText: 'Welcome!',
      };
    case USER_LOGIN_OTP:
      return {
        ...defaultTemplateData,
        code: event.loginCode,
      };
    case ACCOUNT_BLOCKED:
      return {
        ...defaultTemplateData,
        previewText: 'Your account has been temporarily blocked',
      };
    case USER_FORGOT_PASSWORD:
      return {
        ...defaultTemplateData,
        previewText: 'Your password reset code',
        code: event.resetCode,
      };
    default:
      return defaultTemplateData;
  }
};
