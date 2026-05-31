import { EmailTemplate } from '../interfaces/email-template.interface';

export const accountVerificationTemplate: EmailTemplate = {
  name: 'account-verification',
  subject: 'Verify your email address',
  html: `
    <tr>
      <td>
        <p>
          To complete your registration with <strong>[company]</strong>, please use the verification code below.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <div class="code-box">{{code}}</div>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          For security reasons, this verification code will expire in 10 minutes.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          <strong>Security Tip: </strong>Never share your OTP with anyone. Nobody from [company] will ever ask you for your passcode.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          If you did not sign up for an account on [company], you can safely ignore this email.
        </p>
      </td>
    </tr>
  `,
};
