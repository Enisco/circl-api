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
