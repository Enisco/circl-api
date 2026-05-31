export class NotificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

export class TemplateValidationError extends NotificationError {
  constructor(message: string, provider?: string) {
    super(message, 'TEMPLATE_VALIDATION_ERROR', provider);
    this.name = 'TemplateValidationError';
  }
}

export class ProviderError extends NotificationError {
  constructor(message: string, provider: string, originalError?: Error) {
    super(message, 'PROVIDER_ERROR', provider, originalError);
    this.name = 'ProviderError';
  }
}
