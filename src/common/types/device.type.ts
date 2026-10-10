export enum ClientPlatform {
  MOBILE = 'mobile',
  WEB = 'web',
}

export interface DeviceHeaders {
  userAgent: string;
  ipAddress: string;
  deviceId: string;
  deviceName: string;
  timezone: string;
  appVersion: string;
  clientPlatform: ClientPlatform;
  sessionId: string;
}

export interface ParsedDeviceInfo {
  browser: string; // e.g. "Chrome"
  os: string; // e.g. "Windows"
  /**
   * `IOS`, `ANDROID` or `WEB`, which is what the analytics group by.
   *
   * Separate from `os`, which is a free string from a user-agent parser and has spelled the same
   * platform several ways. Taken from `x-client-platform` where the client sends something usable,
   * and from the user agent otherwise — the apps only began sending `IOS`/`ANDROID` with mobile
   * M6, and a column that is null for every release before that is not worth grouping by.
   */
  devicePlatform: 'IOS' | 'ANDROID' | 'WEB';
  osVersion: string | null;
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  fullIp: string; // e.g. "192.168.1.1"
  timezone: string; // e.g. "Africa/Lagos"
  userAgent: string; // e.g. "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  location: string; // e.g. "Lagos, Nigeria"
  deviceId: string;
  deviceName: string;
  appVersion: string;
}

export interface DeviceInfo extends ParsedDeviceInfo {
  deviceFingerprint: string;
}
