import { EmailTemplate } from '../interfaces/email-template.interface';

export const welcomeTemplate: EmailTemplate = {
  name: 'welcome',
  subject: 'Welcome!',
  html: `
    <tr>
      <td>
        <p>
          We're thrilled to have you join our community. 
          Your account has been successfully verified and you're now
          ready to start your journey with us.
        </p>
      </td>
    </tr>
  `,
};
