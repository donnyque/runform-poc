/**
 * Screen Wake Lock API – keep screen on during calibrating/tracking.
 * Fails silently if API is not supported; errors logged with console.warn.
 */

export type WakeLockSentinelLike = {
  release(): Promise<void>
  addEventListener(type: string, listener: () => void): void
}

function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/**
 * Request screen wake lock. Returns sentinel on success; store it and pass to release().
 * Returns null if unsupported or on error (errors logged with console.warn).
 */
export async function requestScreenWakeLock(): Promise<WakeLockSentinelLike | null> {
  if (!isSupported()) return null
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
  }
  try {
    const sentinel = await nav.wakeLock!.request('screen')
    return sentinel
  } catch (e) {
    console.warn('Wake Lock request failed:', e)
    return null
  }
}

/**
 * Release wake lock. Calls onReleased when done (or on error).
 */
export function releaseScreenWakeLock(
  sentinel: WakeLockSentinelLike | null,
  onReleased: () => void
): void {
  if (!sentinel) {
    onReleased()
    return
  }
  try {
    sentinel.release().then(onReleased).catch((e) => {
      console.warn('Wake Lock release failed:', e)
      onReleased()
    })
  } catch (e) {
    console.warn('Wake Lock release failed:', e)
    onReleased()
  }
}
