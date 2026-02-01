/**
 * Affiliate links – udskift med rigtige URLs ved behov.
 */
export const affiliateLinks = {
  liiteguard: {
    tights: '#liiteguard-tights',
    socks: '#liiteguard-socks',
  },
  workwalk: {
    shoes: '#workwalk-shoes',
  },
} as const

export type AffiliateLinkId = 'liiteguard.tights' | 'liiteguard.socks' | 'workwalk.shoes'

const AFFILIATE_CLICKS_KEY = 'runform-poc-affiliate-clicks'

export function recordAffiliateClick(linkId: AffiliateLinkId): void {
  try {
    const raw = localStorage.getItem(AFFILIATE_CLICKS_KEY)
    const arr: { id: string; t: number }[] = raw ? JSON.parse(raw) : []
    arr.push({ id: linkId, t: Date.now() })
    localStorage.setItem(AFFILIATE_CLICKS_KEY, JSON.stringify(arr))
  } catch {
    // ignore
  }
}
