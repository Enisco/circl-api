import { EmailTemplate } from '../interfaces/email-template.interface';

export const accountBlockedTemplate: EmailTemplate = {
  name: 'account-blocked',
  subject: 'Account Blocked',
  html: `
     <tr>
  <td>
    <p>Your account has been blocked because of several incorrect login attempts. This is a security precaution to protect your account.</p>
  </td>
</tr>
<tr>
  <td>
    <h3>How to regain access:</h3>
    <ol>
      <li>Wait for 15 minutes and then try logging in again. Your account should automatically unlock.</li>
      <li>If you need immediate assistance or you are still unable to log in after 15 minutes, please reach out to our support team</a>.</li>
    </ol>
  </td>
</tr>
    `,
};
