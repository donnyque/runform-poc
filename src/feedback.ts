/**
 * Session feedback – gemmes i localStorage. Let at udvide (fx sende til backend).
 */

const FEEDBACK_STORAGE_KEY = 'runform-poc-feedback'

export type FeedbackMetrics = {
  cadenceAvg: number
  stabilityStdDev: number
  voMedian: number
  reliability: string
}

export type FeedbackEntry = {
  timestamp: string
  sessionId: string
  value: 'up' | 'down'
  metrics: FeedbackMetrics
}

export function loadFeedback(): FeedbackEntry[] {
  try {
    const raw = localStorage.getItem(FEEDBACK_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as FeedbackEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveFeedback(entry: FeedbackEntry): void {
  try {
    const arr = loadFeedback()
    arr.push(entry)
    localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(arr))
  } catch {
    // ignore
  }
}

export function hasFeedbackForSession(sessionId: string): boolean {
  return loadFeedback().some((e) => e.sessionId === sessionId)
}
