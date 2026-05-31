import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmailLayout,
  EmailLayoutData,
  EmailTemplate,
  EmailTemplateData,
  baseLayout,
} from '../views';
import Handlebars from 'handlebars';
import { htmlToText } from 'html-to-text';

@Injectable()
export class EmailTemplateRendererService {
  private readonly layouts: Map<string, EmailLayout> = new Map([['base', baseLayout]]);

  constructor(private readonly configService: ConfigService) {
    // Register Handlebars helpers
    Handlebars.registerHelper('if', function (conditional, options) {
      return conditional ? options.fn(this) : options.inverse(this);
    });

    Handlebars.registerHelper('eq', function (a, b) {
      return a === b;
    });
  }

  renderTemplate(template: EmailTemplate, data: EmailTemplateData): EmailTemplate {
    const layout = this.layouts.get('base')!;

    // render the inner template
    const compiledBody = Handlebars.compile(template.html);
    const renderedBodyHtml = compiledBody(data);

    // wrap it in the layout
    const layoutHtml = Handlebars.compile(layout.html);
    const finalHtml = layoutHtml({
      ...data,
      supportEmail: this.configService.get('SUPPORT_EMAIL'),
      currentYear: new Date().getFullYear(),
      userFrontendUrl: this.configService.get('CLIENT_URL'),
      content: renderedBodyHtml,
    } as EmailLayoutData);
    // generate the plain-text version automatically
    const finalText = htmlToText(finalHtml, {
      wordwrap: 130,
      selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }],
    });

    return {
      name: template.name,
      subject: template.subject,
      html: finalHtml,
      text: finalText,
    };
  }
}
