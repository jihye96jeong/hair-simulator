import { koreaDay } from "./config.js";

// Reservation happens before await so simultaneous requests cannot bypass limits.
export class DailyQuota {
  constructor({ ipLimit, totalLimit, now = Date.now, disabled = false }) {
    Object.assign(this, { ipLimit, totalLimit, now, disabled });
    this.buckets = new Map();
  }
  reserve(ip) {
    if (this.disabled || this.ipLimit <= 0) {
      return { release: () => {} };
    }
    const day = koreaDay(this.now());
    for (const key of this.buckets.keys()) if (key !== day) this.buckets.delete(key);
    if (!this.buckets.has(day)) this.buckets.set(day, { total: 0, ips: new Map() });
    const bucket = this.buckets.get(day);
    const count = bucket.ips.get(ip) || 0;
    if (bucket.total >= this.totalLimit) return { status: 503, error: "잠시 후 다시 시도해 주세요." };
    if (count >= this.ipLimit) return { status: 429, error: "오늘 체험 횟수를 모두 사용했어요. 내일 다시 이용해 주세요." };
    bucket.total++;
    bucket.ips.set(ip, count + 1);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      bucket.total--;
      const remaining = bucket.ips.get(ip) - 1;
      if (remaining) bucket.ips.set(ip, remaining); else bucket.ips.delete(ip);
    } };
  }
}
