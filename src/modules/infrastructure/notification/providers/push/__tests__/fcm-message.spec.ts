import { FcmService } from '../fcm.service';

/** `buildMessage` is private; the shape it produces is the contract with APNs and FCM. */
const build = (data?: Record<string, string>) =>
  (
    FcmService.prototype as unknown as {
      buildMessage: (t: string, b: string, d?: Record<string, string>) => Record<string, never>;
    }
  ).buildMessage.call({}, 'Title', 'Body', data) as {
    apns: { headers?: Record<string, string>; payload: { aps: { badge?: number } } };
    android: { collapseKey?: string };
    data?: Record<string, string>;
  };

describe('the push message', () => {
  it('sets the iOS icon badge from the count the caller sent', () => {
    expect(build({ badge: '6' }).apns.payload.aps.badge).toBe(6);
  });

  it('shows zero when zero is what is waiting, rather than treating it as missing', () => {
    // The difference matters: 0 clears the icon badge, absent leaves whatever was there.
    expect(build({ badge: '0' }).apns.payload.aps.badge).toBe(0);
  });

  it('omits the badge entirely when there is no usable count', () => {
    // Never a fallback of 1: an invented count looks exactly like a real one.
    expect(build({}).apns.payload.aps.badge).toBeUndefined();
    expect(build({ badge: 'not a number' }).apns.payload.aps.badge).toBeUndefined();
    expect(build().apns.payload.aps.badge).toBeUndefined();
  });

  it('collapses on both platforms, not just Android', () => {
    const message = build({ collapseKey: 'cnv_9', badge: '2' });

    expect(message.android.collapseKey).toBe('cnv_9');
    expect(message.apns.headers?.['apns-collapse-id']).toBe('cnv_9');
  });

  it('truncates a collapse id to the 64 bytes APNs allows', () => {
    const long = 'x'.repeat(120);

    expect(build({ collapseKey: long }).apns.headers?.['apns-collapse-id']).toHaveLength(64);
  });

  it('sends no collapse header when there is nothing to collapse', () => {
    expect(build({ badge: '1' }).apns.headers).toBeUndefined();
  });

  it('stringifies the data payload, because FCM only carries strings', () => {
    const message = build({ badge: '3', targetId: 'upd_1' } as Record<string, string>);

    expect(message.data).toEqual({ badge: '3', targetId: 'upd_1' });
  });
});
