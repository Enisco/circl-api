import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { UAParser } from 'ua-parser-js';
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

  /**
   * Extract device info from request headers.
   *
   * Deliberately no IP-to-location. `geoip-lite` read its city tables into memory when it was
   * imported — ~140 MiB held for the life of the process, a quarter of a 512 MiB instance — to
   * build a `location` string that nothing ever read: the sessions screen returns null on purpose
   * (`session-list.service.ts`), no column stores it, and the fingerprint below is built from the
   * browser, OS, type and device id. If that screen ever wants a location, geoip-lite's
   * country-only tables cost ~20 MiB — delete `data/geoip-city*.dat` after install — and answer
   * "GB" rather than "London, England, GB".
   */
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

    return {
      browser,
      os,
      osVersion,
      devicePlatform: this.resolvePlatform(deviceHeaders.clientPlatform, os),
      deviceType,
      fullIp: cleanedIp,
      timezone: resolvedTimezone,
      userAgent,
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
