import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { UAParser } from 'ua-parser-js';
import * as geoip from 'geoip-lite';
import * as crypto from 'node:crypto';
import { DeviceHeaders, DeviceInfo, ParsedDeviceInfo } from '../../types';

@Injectable()
export class DeviceService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(DeviceService.name);
  }

  generateDeviceInfo(deviceHeaders: DeviceHeaders): DeviceInfo {
    const parsedUserAgent = this.parseUserAgent(deviceHeaders);
    const deviceFingerprint = this.generateDeviceFingerprint(parsedUserAgent);

    return { ...parsedUserAgent, deviceFingerprint };
  }

  /**
   * Which platform this is, preferring what the client said and falling back to the user agent.
   *
   * `x-client-platform` has historically carried `mobile` or `web`, which does not distinguish the
   * two app stores — so "mobile" is resolved from the operating system the user agent reports.
   * Once the apps send `IOS`/`ANDROID` directly (mobile M6) the header is believed as sent, and
   * this fallback simply stops being reached.
   */
  private resolvePlatform(
    clientPlatform: string | null | undefined,
    os: string,
  ): ParsedDeviceInfo['devicePlatform'] {
    const declared = (clientPlatform ?? '').trim().toUpperCase();

    if (declared === 'IOS' || declared === 'ANDROID' || declared === 'WEB') return declared;

    const platform = os.toLowerCase();

    if (platform.includes('ios') || platform.includes('mac os')) return 'IOS';
    if (platform.includes('android')) return 'ANDROID';

    return 'WEB';
  }

  private generateDeviceFingerprint(parsedUserAgent: ParsedDeviceInfo) {
    const fingerprintString = `${parsedUserAgent.browser}|${parsedUserAgent.os}|${parsedUserAgent.deviceType}|${parsedUserAgent.deviceId}`;

    return this.hash(fingerprintString);
  }

  /** SHA-256 hash wrapper */
  private hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private normalizeIp(ip: string): string {
    if (!ip || ip === '::1') return '127.0.0.1';

    return ip.replace(/^::ffff:/i, '');
  }

  /** Extract device info from request headers */
  private parseUserAgent(deviceHeaders: DeviceHeaders): ParsedDeviceInfo {
    const fallbackDeviceName = this.generateFallbackDeviceName(deviceHeaders.userAgent);
    const { userAgent, ipAddress, timezone, deviceId, deviceName, appVersion } = deviceHeaders;
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser().name || 'unknown';
    const os = parser.getOS().name || 'unknown';
    const osVersion = parser.getOS().version || null;
    const rawType = parser.getDevice().type as DeviceInfo['deviceType'];
    const deviceType: DeviceInfo['deviceType'] = rawType || 'desktop';
    const cleanedIp = this.normalizeIp(ipAddress);
    const resolvedTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Get location from IP with error handling
    let location = 'unknown location';

    try {
      const geo = geoip.lookup(cleanedIp);

      if (geo) {
        location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
      }
    } catch (error) {
      this.logger.warn(`Failed to lookup IP location: ${(error as Error).message}`);
    }

    return {
      browser,
      os,
      osVersion,
      devicePlatform: this.resolvePlatform(deviceHeaders.clientPlatform, os),
      deviceType,
      fullIp: cleanedIp,
      timezone: resolvedTimezone,
      userAgent,
      location,
      deviceId,
      deviceName: deviceName || fallbackDeviceName,
      appVersion,
    };
  }

  private generateFallbackDeviceName(userAgent: string): string {
    const parser = new UAParser(userAgent);
    const { model, type, vendor } = parser.getDevice();
    const { name: osName } = parser.getOS();
    const { name: browserName } = parser.getBrowser();

    const parts: string[] = [];

    if (vendor) parts.push(vendor); // e.g., Apple, Samsung
    if (model) parts.push(model); // e.g., iPhone, SM-G991B
    if (!model && type) parts.push(type); // fallback: mobile, tablet, desktop
    if (!vendor && osName) parts.push(osName); // fallback to OS if no vendor
    if (browserName) parts.push(`(${browserName})`);

    return parts.join(' ') || 'Unknown Device';
  }
}
