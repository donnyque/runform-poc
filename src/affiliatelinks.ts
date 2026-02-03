/**
 * Affiliate links – central konfiguration.
 * (Dummy links kan erstattes her, uden at ændre UI.)
 */
export const affiliateLinks = {
  liiteguard: {
    tights:
      "https://www.partner-ads.com/dk/klikbanner.php?partnerid=48329&bannerid=104295&htmlurl=https://liiteguard.dk/collections/lobetights",
    socks:
      "https://www.partner-ads.com/dk/klikbanner.php?partnerid=48329&bannerid=104295&htmlurl=https://liiteguard.dk/collections/loebestroemper",
  },
  workwalk: {
    treadmill:
      "https://www.partner-ads.com/dk/klikbanner.php?partnerid=48329&bannerid=112536",
  },
  fusion: {
    apparel:
      "https://www.partner-ads.com/dk/klikbanner.php?partnerid=48329&bannerid=113768&htmlurl=https://fusion.dk/collections/running",
  },
} as const;

export type AffiliateLinkId =
  | "liiteguard.tights"
  | "liiteguard.socks"
  | "workwalk.treadmill"
  | "fusion.apparel";

const AFFILIATE_CLICKS_KEY = "runform-poc-affiliate-clicks";

export function recordAffiliateClick(linkId: AffiliateLinkId): void {
  try {
    const raw = localStorage.getItem(AFFILIATE_CLICKS_KEY);
    const arr: { id: string; t: number }[] = raw ? JSON.parse(raw) : [];
    arr.push({ id: linkId, t: Date.now() });
    localStorage.setItem(AFFILIATE_CLICKS_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}
