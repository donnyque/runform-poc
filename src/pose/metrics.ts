/**
 * RunForm PoC – Metrics in tracking mode: cadence, VO proxy, stability.
 * Cadence = steps_per_minute (foot strikes); steps in last 10s → cadence = stepsLast10s * 6.
 */

const SMOOTH_SAMPLES = 5
const STEP_AMPLITUDE_THRESHOLD = 0.012
const STEP_COOLDOWN_MS = 280
const STEP_WINDOW_MS = 10_000
const VO_WINDOW_MS = 5_000
const CADENCE_SAMPLE_INTERVAL_MS = 500
const CADENCE_SAMPLE_WINDOW_MS = 30_000

/** Cadence = steps in last 10s * 6 (10s * 6 = 60s). */
const CADENCE_FACTOR = 6

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

export type MetricsSnapshot = {
  cadence: number
  voProxy: number
  stability: number
  stepsLast10s: number
  currentAnkle: 'L' | 'R'
}

export class MetricsSession {
  private stepSignalBuffer: number[] = []
  private prevSmoothedY: number = 0
  private direction: 'up' | 'down' | null = null
  private lastPeakY: number = 0
  private lastStepTime: number = 0
  private stepTimestamps: number[] = []
  private deviations: { t: number; v: number }[] = []
  private cadenceSamples: { t: number; cadence: number }[] = []
  private lastCadenceSampleTime: number = 0
  private currentAnkle: 'L' | 'R' = 'L'

  update(
    ankleY: number,
    kneeY: number,
    ankleVis: number,
    kneeVis: number,
    ankleUsed: 'L' | 'R',
    midHipY: number,
    baselineHipY: number,
    timestampMs: number
  ): void {
    this.currentAnkle = ankleUsed

    const stepY = ankleVis >= kneeVis ? ankleY : kneeY
    this.stepSignalBuffer.push(stepY)
    if (this.stepSignalBuffer.length > SMOOTH_SAMPLES) {
      this.stepSignalBuffer.shift()
    }
    const smoothedY = mean(this.stepSignalBuffer)
    const dy = smoothedY - this.prevSmoothedY

    if (dy > 0) {
      this.direction = 'up'
      this.lastPeakY = smoothedY
    } else if (dy < 0) {
      if (this.direction === 'up') {
        const amplitude = this.lastPeakY - smoothedY
        const cooldownOk = timestampMs - this.lastStepTime >= STEP_COOLDOWN_MS
        if (amplitude >= STEP_AMPLITUDE_THRESHOLD && cooldownOk) {
          this.stepTimestamps.push(timestampMs)
          this.lastStepTime = timestampMs
        }
      }
      this.direction = 'down'
    }

    this.prevSmoothedY = smoothedY

    const cutoffSteps = timestampMs - STEP_WINDOW_MS
    this.stepTimestamps = this.stepTimestamps.filter((t) => t >= cutoffSteps)

    const deviation = midHipY - baselineHipY
    this.deviations.push({ t: timestampMs, v: deviation })
    const cutoffVo = timestampMs - VO_WINDOW_MS
    this.deviations = this.deviations.filter((d) => d.t >= cutoffVo)

    if (timestampMs - this.lastCadenceSampleTime >= CADENCE_SAMPLE_INTERVAL_MS) {
      this.lastCadenceSampleTime = timestampMs
      const stepsIn10s = this.stepTimestamps.filter(
        (t) => t >= timestampMs - STEP_WINDOW_MS
      ).length
      const cadence = stepsIn10s * CADENCE_FACTOR
      this.cadenceSamples.push({ t: timestampMs, cadence })
      const cutoffCadence = timestampMs - CADENCE_SAMPLE_WINDOW_MS
      this.cadenceSamples = this.cadenceSamples.filter(
        (s) => s.t >= cutoffCadence
      )
    }
  }

  getSnapshot(timestampMs: number): MetricsSnapshot {
    const stepsIn10s = this.stepTimestamps.filter(
      (t) => t >= timestampMs - STEP_WINDOW_MS
    ).length
    const cadence = stepsIn10s * CADENCE_FACTOR

    const devs = this.deviations
      .filter((d) => d.t >= timestampMs - VO_WINDOW_MS)
      .map((d) => d.v)
    const voProxy =
      devs.length < 2 ? 0 : Math.max(...devs) - Math.min(...devs)

    const cadenceValues = this.cadenceSamples
      .filter((s) => s.t >= timestampMs - CADENCE_SAMPLE_WINDOW_MS)
      .map((s) => s.cadence)
    const stability = stddev(cadenceValues)

    return {
      cadence: Math.round(cadence * 10) / 10,
      voProxy: Math.round(voProxy * 1000) / 1000,
      stability: Math.round(stability * 10) / 10,
      stepsLast10s: stepsIn10s,
      currentAnkle: this.currentAnkle,
    }
  }

  reset(): void {
    this.stepSignalBuffer = []
    this.prevSmoothedY = 0
    this.direction = null
    this.lastPeakY = 0
    this.lastStepTime = 0
    this.stepTimestamps = []
    this.deviations = []
    this.cadenceSamples = []
    this.lastCadenceSampleTime = 0
  }
}
