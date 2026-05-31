export interface EmailTemplateData {
  greeting: string;
  userName: string;
  closingMessage: string;
  signature: string;
  tagline: string;
  [key: string]: any;
}

export interface EmailTemplate {
  name: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailAttachment {
  content: string; // Base64 encoded content
  filename: string;
  contentType: string;
}
