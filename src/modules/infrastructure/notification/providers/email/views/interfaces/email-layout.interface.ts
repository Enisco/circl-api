export interface EmailLayout {
  name: string;
  html: string;
  text?: string;
}

export interface EmailLayoutData {
  userName: string;
  supportEmail: string;
  currentYear: number;
  userFrontendUrl: string;
  content: string;
}
