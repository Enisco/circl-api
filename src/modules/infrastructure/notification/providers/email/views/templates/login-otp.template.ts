import { EmailTemplate } from '../interfaces/email-template.interface';

export const loginOtpTemplate: EmailTemplate = {
  name: 'login-otp',
  subject: 'Your login code',
  html: `
    <tr>
      <td>
        <p>
          Use the code below to sign in to your <strong>[company]</strong> account.
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
          This code expires in 10 minutes.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          <strong>Security Tip: </strong>Never share your login code with anyone. Nobody from [company] will ever ask you for it.
        </p>
      </td>
    </tr>
    <tr>
      <td>
        <p>
          If you did not request this code, you can safely ignore this email.
        </p>
      </td>
    </tr>
  `,
};
