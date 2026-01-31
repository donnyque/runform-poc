/**
 * RunForm PoC – Session summary computation and insights (Fase D).
 */

export type SessionSample = {
  t: number
  cadence: number
  voProxy: number
  quality: number
}

export type SessionSummary = {
  id: string
  dateISO: string
  durationSec: number
  totalDurationSec: number
  activeDurationSec: number
  cadenceAvg: number
  cadenceMin: number
  cadenceMax: number
  stabilityStdDev: number
  voMedian: number
  voPeak: number
  qualityAvg: number
  qualityMin: number
  reliability: 'High' | 'Medium' | 'Low'
  insights: string[]
  note: string
  /** Cadence per sample (for sparkline). */
  cadenceSamples?: number[]
  /** Quality per sample (for sparkline). */
  qualitySamples?: number[]
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  const sq = arr.map((x) => (x - m) ** 2)
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / (arr.length - 1))
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]!
}

export function computeSummary(
  samples: SessionSample[],
  _startTimeMs: number,
  _endTimeMs: number,
  totalDurationSec: number,
  activeDurationSec: number
): Omit<SessionSummary, 'id' | 'dateISO' | 'insights' | 'note'> {
  const durationSec = activeDurationSec
  const cadenceValues = samples.map((s) => s.cadence).filter((v) => v >= 0)
  const voValues = samples.map((s) => s.voProxy).filter((v) => v >= 0)
  const qualityValues = samples.map((s) => s.quality).filter((v) => v >= 0)

  const cadenceAvg = cadenceValues.length
    ? Math.round(mean(cadenceValues) * 10) / 10
    : 0
  const cadenceMin =
    cadenceValues.length > 0 ? Math.round(Math.min(...cadenceValues) * 10) / 10 : 0
  const cadenceMax =
    cadenceValues.length > 0 ? Math.round(Math.max(...cadenceValues) * 10) / 10 : 0
  const stabilityStdDev =
    cadenceValues.length >= 2
      ? Math.round(stddev(cadenceValues) * 10) / 10
      : 0
  const voMedian =
    voValues.length > 0 ? Math.round(median(voValues) * 1000) / 1000 : 0
  const voPeak =
    voValues.length > 0 ? Math.round(Math.max(...voValues) * 1000) / 1000 : 0
  const qualityAvg = qualityValues.length
    ? Math.round(mean(qualityValues) * 10) / 10
    : 0
  const qualityMin =
    qualityValues.length > 0 ? Math.round(Math.min(...qualityValues) * 10) / 10 : 0

  let reliability: 'High' | 'Medium' | 'Low' = 'Low'
  if (qualityAvg >= 75 && qualityMin >= 55) reliability = 'High'
  else if (qualityAvg >= 60) reliability = 'Medium'

  return {
    durationSec,
    totalDurationSec,
    activeDurationSec,
    cadenceAvg,
    cadenceMin,
    cadenceMax,
    stabilityStdDev,
    voMedian,
    voPeak,
    qualityAvg,
    qualityMin,
    reliability,
  }
}

export function generateInsights(
  s: Omit<SessionSummary, 'id' | 'dateISO' | 'insights' | 'note'>,
  voValues: number[]
): string[] {
  const lines: string[] = []

  if (s.reliability === 'Low') {
    lines.push(
      'Målingen var lidt usikker. Næste gang: mere lys og hele kroppen i frame.'
    )
  }
  if (s.stabilityStdDev <= 3 && s.cadenceAvg > 0) {
    lines.push('Du holdt en meget jævn rytme.')
  }
  if (s.stabilityStdDev > 6 && s.cadenceAvg > 0) {
    lines.push('Din rytme svingede en del. Prøv at finde en mere stabil cadence.')
  }
  if (s.cadenceAvg > 0 && s.cadenceAvg < 155) {
    lines.push(
      'Du løb med relativt lav cadence. Du kan eksperimentere med lidt kortere skridt.'
    )
  }
  if (s.cadenceAvg > 175) {
    lines.push(
      'Du løb med relativt høj cadence. Godt hvis det føles afslappet og stabilt.'
    )
  }
  const voP70 = voValues.length > 0 ? percentile(voValues, 70) : 0
  const voHigh = voValues.length > 0 && s.voMedian > voP70
  if (voHigh) {
    lines.push(
      'Der var en del vertikal bevægelse. Prøv at holde overkroppen lidt mere rolig.'
    )
  }
  if ((lines.length === 0 || (lines.length < 4 && !voHigh)) && lines.length < 4) {
    lines.push(
      'God base. Gem denne som reference og se om du kan gøre den endnu mere stabil næste gang.'
    )
  }

  return lines.slice(0, 4)
}

const SESSIONS_STORAGE_KEY = 'runform-poc-sessions'
const MAX_SESSIONS = 30

export function loadSessions(): SessionSummary[] {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SessionSummary[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((s) => ({
      ...s,
      totalDurationSec: s.totalDurationSec ?? s.durationSec,
      activeDurationSec: s.activeDurationSec ?? s.durationSec,
    }))
  } catch {
    return []
  }
}

export function saveSessions(sessions: SessionSummary[]): void {
  try {
    const trimmed = sessions.slice(0, MAX_SESSIONS)
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // ignore
  }
}

export function addSession(
  summary: Omit<SessionSummary, 'id' | 'note'>,
  note: string = ''
): SessionSummary {
  if (!('totalDurationSec' in summary) || typeof summary.totalDurationSec !== 'number') {
    (summary as SessionSummary).totalDurationSec = summary.durationSec
  }
  if (!('activeDurationSec' in summary) || typeof summary.activeDurationSec !== 'number') {
    (summary as SessionSummary).activeDurationSec = summary.durationSec
  }
  const session: SessionSummary = {
    ...summary,
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    note: note.trim(),
  }
  const sessions = loadSessions()
  sessions.unshift(session)
  saveSessions(sessions)
  return session
}

export function updateSessionNote(id: string, note: string): void {
  const sessions = loadSessions()
  const i = sessions.findIndex((s) => s.id === id)
  if (i >= 0) {
    sessions[i] = { ...sessions[i]!, note: note.trim() }
    saveSessions(sessions)
  }
}

export function deleteSession(id: string): void {
  const sessions = loadSessions().filter((s) => s.id !== id)
  saveSessions(sessions)
}

/** Fallback summary when Stop is pressed but no tracking samples (e.g. stopped right after calibrating). */
export function createEmptySummary(totalDurationSec = 0, activeDurationSec = 0): SessionSummary {
  const dateISO = new Date().toISOString()
  return {
    id: `empty-${Date.now()}`,
    dateISO,
    durationSec: activeDurationSec,
    totalDurationSec,
    activeDurationSec,
    cadenceAvg: 0,
    cadenceMin: 0,
    cadenceMax: 0,
    stabilityStdDev: 0,
    voMedian: 0,
    voPeak: 0,
    qualityAvg: 0,
    qualityMin: 0,
    reliability: 'Low',
    insights: ['Ingen tracking-data fra denne session. Start og stop igen efter lidt tracking for at se nøgletal.'],
    note: '',
    cadenceSamples: [],
    qualitySamples: [],
  }
}
