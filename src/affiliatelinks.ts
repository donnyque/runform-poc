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

const ID_TO_URL: Record<AffiliateLinkId, string> = {
  "liiteguard.tights": affiliateLinks.liiteguard.tights,
  "liiteguard.socks": affiliateLinks.liiteguard.socks,
  "fusion.apparel": affiliateLinks.fusion.apparel,
  "workwalk.treadmill": affiliateLinks.workwalk.treadmill,
};

/**
 * Returns the URL for an affiliate link id. Throws and logs if id is unknown.
 */
export function getAffiliateUrl(linkId: AffiliateLinkId): string {
  const url = ID_TO_URL[linkId];
  if (!url) {
    console.error("Unknown affiliate id:", linkId);
    throw new Error(`Unknown affiliate id: ${linkId}`);
  }
  return url;
}

/**
 * Returns the hostname of the affiliate URL for debug display (e.g. "partner-ads.com").
 */
export function getAffiliateDomain(linkId: AffiliateLinkId): string {
  try {
    return new URL(getAffiliateUrl(linkId)).hostname;
  } catch {
    return "";
  }
}

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

/**
 * Records click and opens affiliate URL in new tab. Falls back to same tab if popup blocked.
 */
export function openAffiliate(linkId: AffiliateLinkId): void {
  recordAffiliateClick(linkId);
  const url = getAffiliateUrl(linkId);
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (w == null) {
    window.location.href = url;
  }
}
