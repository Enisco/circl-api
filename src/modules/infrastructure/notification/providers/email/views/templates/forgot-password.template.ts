import { EmailTemplate } from '../interfaces/email-template.interface';

export const forgotPasswordTemplate: EmailTemplate = {
  name: 'forgot-password',
  subject: 'Reset your password',
  html: `
    <tr>
      <td>
        <p>
          We received a request to reset your password for your <strong>Circl</strong> account. Please use the verification code below to authorize and proceed with your password reset.
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
          <strong>Security Tip: </strong>Never share your verification code with anyone.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          If you did not request a password reset, you can safely ignore this email.
        </p>
      </td>
    </tr>
  `,
};
