import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startPoseRunner,
  stopPoseRunner,
} from './pose/poseRunner'
import type { FrameQualityHint } from './pose/frameQuality'
import { MetricsSession, type MetricsSnapshot } from './pose/metrics'
import './App.css'

const METRICS_UPDATE_INTERVAL_MS = 500

const ONBOARDING_STORAGE_KEY = 'runform-poc-onboarding-seen'
const MESSAGE_THROTTLE_MS = 2000
const CALIBRATION_DURATION_MS = 5000
const GOOD_TIME_UPDATE_INTERVAL_MS = 100

function getOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function setOnboardingSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1')
  } catch {
    // ignore
  }
}

function pickAutoCheckMessage(
  poseDetected: boolean,
  frameQuality: number | null,
  hint: FrameQualityHint | null
): string | null {
  if (!poseDetected) return 'Jeg kan ikke se dig – kom i billedet'
  if (!hint?.noseAndAnklesOk) return 'Prøv at få hele kroppen i billedet'
  if (frameQuality != null && frameQuality < 55)
    return 'Mere lys og/eller flyt dig lidt'
  const sw = hint?.shoulderWidthNormalized
  if (sw != null && sw > 0.35) return 'Gå lidt tilbage'
  if (sw != null && sw < 0.12) return 'Kom lidt tættere på'
  return null
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

export type Phase = 'idle' | 'calibrating' | 'tracking'

export type Baseline = {
  hipY: number
  torsoY: number
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastMessageTimeRef = useRef<number>(0)
  const displayedMessageRef = useRef<string | null>(null)
  const phaseRef = useRef<Phase>('idle')
  const goodTimeAccumulatedRef = useRef<number>(0)
  const lastGoodTimestampRef = useRef<number>(0)
  const samplesMidHipYRef = useRef<number[]>([])
  const samplesMidShoulderYRef = useRef<number[]>([])
  const lastGoodTimeStateUpdateRef = useRef<number>(0)
  const calibrationGoodFrameRef = useRef<boolean>(false)
  const baselineRef = useRef<Baseline | null>(null)
  const metricsSessionRef = useRef<MetricsSession | null>(null)
  const trackingStartTimeRef = useRef<number>(0)

  const [isRunning, setIsRunning] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [poseDetected, setPoseDetected] = useState(false)
  const [frameQuality, setFrameQuality] = useState<number | null>(null)
  const [hint, setHint] = useState<FrameQualityHint | null>(null)
  const [hintMessage, setHintMessage] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(() => !getOnboardingSeen())
  const [goodTimeMs, setGoodTimeMs] = useState(0)
  const [calibrationGoodFrame, setCalibrationGoodFrame] = useState(false)
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [metricsSnapshot, setMetricsSnapshot] = useState<MetricsSnapshot | null>(null)
  const [trackingTimeMs, setTrackingTimeMs] = useState(0)
  const [debugMetricsOpen, setDebugMetricsOpen] = useState(false)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    baselineRef.current = baseline
  }, [baseline])

  const updateHintMessage = useCallback(
    (desired: string | null, now: number) => {
      const current = displayedMessageRef.current
      const elapsed = now - lastMessageTimeRef.current
      if (desired === current) return
      if (desired == null) {
        setHintMessage(null)
        displayedMessageRef.current = null
        lastMessageTimeRef.current = now
        return
      }
      if (current != null && elapsed < MESSAGE_THROTTLE_MS) return
      setHintMessage(desired)
      displayedMessageRef.current = desired
      lastMessageTimeRef.current = now
    },
    []
  )

  useEffect(() => {
    if (!isRunning) {
      setHintMessage(null)
      displayedMessageRef.current = null
      return
    }
    const desired = pickAutoCheckMessage(poseDetected, frameQuality, hint)
    updateHintMessage(desired, performance.now())
  }, [isRunning, poseDetected, frameQuality, hint, updateHintMessage])

  const handleCalibrationFrame = useCallback(
    (
      data: { midHipY: number | null; midShoulderY: number | null; isGood: boolean },
      timestampMs: number
    ) => {
      if (phaseRef.current !== 'calibrating') return

      if (data.isGood !== calibrationGoodFrameRef.current) {
        calibrationGoodFrameRef.current = data.isGood
        setCalibrationGoodFrame(data.isGood)
      }

      if (!data.isGood || data.midHipY == null || data.midShoulderY == null)
        return

      if (lastGoodTimestampRef.current === 0) {
        lastGoodTimestampRef.current = timestampMs
      } else {
        const delta = timestampMs - lastGoodTimestampRef.current
        goodTimeAccumulatedRef.current += delta
        lastGoodTimestampRef.current = timestampMs
      }

      samplesMidHipYRef.current.push(data.midHipY)
      samplesMidShoulderYRef.current.push(data.midShoulderY)

      const now = timestampMs
      if (
        now - lastGoodTimeStateUpdateRef.current >= GOOD_TIME_UPDATE_INTERVAL_MS
      ) {
        lastGoodTimeStateUpdateRef.current = now
        const capped = Math.min(
          CALIBRATION_DURATION_MS,
          goodTimeAccumulatedRef.current
        )
        setGoodTimeMs(capped)
      }

      if (goodTimeAccumulatedRef.current >= CALIBRATION_DURATION_MS) {
        const hipY = mean(samplesMidHipYRef.current)
        const torsoY = mean(samplesMidShoulderYRef.current)
        const bl = { hipY, torsoY }
        setBaseline(bl)
        baselineRef.current = bl
        setGoodTimeMs(CALIBRATION_DURATION_MS)
        metricsSessionRef.current = new MetricsSession()
        trackingStartTimeRef.current = performance.now()
        setPhase('tracking')
        phaseRef.current = 'tracking'
        goodTimeAccumulatedRef.current = 0
        lastGoodTimestampRef.current = 0
        samplesMidHipYRef.current = []
        samplesMidShoulderYRef.current = []
      }
    },
    []
  )

  const handleTrackingFrame = useCallback(
    (
      data: { ankleY: number; ankleUsed: 'L' | 'R'; midHipY: number },
      timestampMs: number
    ) => {
      if (phaseRef.current !== 'tracking') return
      const bl = baselineRef.current
      if (!bl) return
      metricsSessionRef.current?.update(
        data.ankleY,
        data.ankleUsed,
        data.midHipY,
        bl.hipY,
        timestampMs
      )
    },
    []
  )

  const handleStart = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      setError('Video eller canvas ikke tilgængeligt.')
      return
    }

    setError(null)
    setIsRunning(true)
    setPhase('calibrating')
    phaseRef.current = 'calibrating'
    setGoodTimeMs(0)
    setBaseline(null)
    setCalibrationGoodFrame(false)
    calibrationGoodFrameRef.current = false
    goodTimeAccumulatedRef.current = 0
    lastGoodTimestampRef.current = 0
    samplesMidHipYRef.current = []
    samplesMidShoulderYRef.current = []
    lastGoodTimeStateUpdateRef.current = 0
    lastMessageTimeRef.current = 0
    displayedMessageRef.current = null
    setHintMessage(null)

    await startPoseRunner(video, canvas, {
      onStatus: (f, p, q, h) => {
        setFps(f)
        setPoseDetected(p)
        setFrameQuality(q)
        setHint(h ?? null)
      },
      onCalibrationFrame: handleCalibrationFrame,
      onTrackingFrame: handleTrackingFrame,
      onError: (msg) => {
        setError(msg)
        setIsRunning(false)
        setPhase('idle')
        phaseRef.current = 'idle'
      },
    })
  }, [handleCalibrationFrame, handleTrackingFrame])

  const handleStop = useCallback(async () => {
    await stopPoseRunner()
    setIsRunning(false)
    setPhase('idle')
    phaseRef.current = 'idle'
    setError(null)
    setFps(0)
    setPoseDetected(false)
    setFrameQuality(null)
    setHint(null)
    setHintMessage(null)
    setGoodTimeMs(0)
    setBaseline(null)
    baselineRef.current = null
    setMetricsSnapshot(null)
    setTrackingTimeMs(0)
    metricsSessionRef.current = null
    displayedMessageRef.current = null
  }, [])

  const handleRecalibrate = useCallback(() => {
    setPhase('calibrating')
    phaseRef.current = 'calibrating'
    setGoodTimeMs(0)
    setCalibrationGoodFrame(false)
    calibrationGoodFrameRef.current = false
    goodTimeAccumulatedRef.current = 0
    lastGoodTimestampRef.current = 0
    samplesMidHipYRef.current = []
    samplesMidShoulderYRef.current = []
    lastGoodTimeStateUpdateRef.current = 0
    metricsSessionRef.current = null
    setMetricsSnapshot(null)
    setTrackingTimeMs(0)
  }, [])

  useEffect(() => {
    if (phase !== 'tracking' || !metricsSessionRef.current) return
    const interval = setInterval(() => {
      const now = performance.now()
      const session = metricsSessionRef.current
      if (session) {
        setMetricsSnapshot(session.getSnapshot(now))
      }
      setTrackingTimeMs(Math.max(0, now - trackingStartTimeRef.current))
    }, METRICS_UPDATE_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [phase])

  const closeOnboardingAndStart = useCallback(() => {
    setOnboardingSeen()
    setShowOnboarding(false)
    handleStart()
  }, [handleStart])

  const openOnboarding = useCallback(() => {
    setShowOnboarding(true)
  }, [])

  const calibrationSecondsRemaining = Math.max(
    0,
    5 - Math.floor(goodTimeMs / 1000)
  )
  const calibrationProgress = goodTimeMs / CALIBRATION_DURATION_MS

  const trackingMm = Math.floor(trackingTimeMs / 60_000)
  const trackingSs = Math.floor((trackingTimeMs % 60_000) / 1000)
  const trackingTimeLabel = `${String(trackingMm).padStart(2, '0')}:${String(trackingSs).padStart(2, '0')}`

  return (
    <div className="app" ref={containerRef}>
      <header className="header">
        <h1>RunForm PoC</h1>
        <button
          type="button"
          className="link-setup"
          onClick={openOnboarding}
          aria-label="Vis opsætningsvejledning"
        >
          Vis opsætningsvejledning
        </button>
      </header>

      {showOnboarding && (
        <div className="onboarding-overlay" role="dialog" aria-labelledby="onboarding-title">
          <div className="onboarding-card">
            <h2 id="onboarding-title">Sådan får du bedst resultat</h2>
            <ul className="onboarding-list">
              <li>Placér telefonen stabilt (gulv, skammel eller stativ)</li>
              <li>Hele kroppen skal være i billedet (hoved til fødder)</li>
              <li>Ca. 2–3 meter afstand hvis muligt</li>
              <li>Godt lys forfra</li>
            </ul>
            <button
              type="button"
              className="btn btn-ok"
              onClick={closeOnboardingAndStart}
            >
              OK, start
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <strong>Fejl:</strong> {error}
        </div>
      )}

      {phase === 'calibrating' && (
        <div className="calibration-panel" role="status">
          <div className="calibration-countdown">
            {calibrationSecondsRemaining}
          </div>
          <div className="calibration-progress-wrap">
            <div
              className="calibration-progress-fill"
              style={{ width: `${calibrationProgress * 100}%` }}
            />
          </div>
          {!calibrationGoodFrame && (
            <p className="calibration-message">
              Hold still og få hele kroppen i billedet. Pose og kvalitet skal være god nok.
            </p>
          )}
        </div>
      )}

      {phase === 'tracking' && (
        <>
          <div className="baseline-locked" role="status">
            <span className="baseline-locked-label">Baseline locked</span>
            {baseline != null && (
              <div className="debug-panel">
                <span>hipY: {baseline.hipY.toFixed(3)}</span>
                <span>torsoY: {baseline.torsoY.toFixed(3)}</span>
              </div>
            )}
          </div>
          <div className="metrics-panel" role="region" aria-label="Målinger">
            <div className="metrics-row">
              <div className="metric-block">
                <span className="metric-value">{metricsSnapshot?.cadence ?? '–'}</span>
                <span className="metric-unit">spm</span>
                <span className="metric-label">Cadence</span>
              </div>
              <div className="metric-block">
                <span className="metric-value">{metricsSnapshot != null ? metricsSnapshot.voProxy.toFixed(3) : '–'}</span>
                <span className="metric-unit">rel</span>
                <span className="metric-label">VO proxy</span>
              </div>
              <div className="metric-block">
                <span className="metric-value">{metricsSnapshot?.stability ?? '–'}</span>
                <span className="metric-unit">spm</span>
                <span className="metric-label">Stability</span>
              </div>
            </div>
            <div className="metrics-tracking-time">
              <span className="metric-label">Tracking</span>
              <span className="metric-value">{trackingTimeLabel}</span>
            </div>
            <button
              type="button"
              className="debug-toggle"
              onClick={() => setDebugMetricsOpen((o) => !o)}
              aria-expanded={debugMetricsOpen}
            >
              {debugMetricsOpen ? 'Skjul debug' : 'Vis debug'}
            </button>
            {debugMetricsOpen && metricsSnapshot != null && (
              <div className="metrics-debug">
                <span>steps_last_10s: {metricsSnapshot.stepsLast10s}</span>
                <span>ankle: {metricsSnapshot.currentAnkle === 'L' ? 'L' : 'R'}</span>
              </div>
            )}
            <p className="metrics-disclaimer">Prototype. Kun generel feedback.</p>
          </div>
        </>
      )}

      <div className="preview-wrapper">
        <video
          ref={videoRef}
          className="preview-video"
          autoPlay
          playsInline
          muted
          style={{ display: isRunning ? 'block' : 'none' }}
        />
        <canvas
          ref={canvasRef}
          className="preview-canvas"
          style={{
            display: isRunning ? 'block' : 'none',
            pointerEvents: 'none',
          }}
        />
        {!isRunning && !showOnboarding && (
          <div className="preview-placeholder">
            <p>Tryk Start for at bruge frontkamera og pose-detektion</p>
          </div>
        )}
      </div>

      <div className="status">
        <span className="status-item">FPS: {fps}</span>
        <span className="status-item">
          Pose: {poseDetected ? 'ja' : 'nej'}
        </span>
        {frameQuality != null && (
          <span className="status-item">
            Frame quality: {frameQuality}/100
          </span>
        )}
      </div>

      {hintMessage && (
        <div className="hint-message" role="status">
          {hintMessage}
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn btn-start"
          onClick={handleStart}
          disabled={isRunning}
        >
          Start
        </button>
        {phase === 'tracking' && (
          <button
            type="button"
            className="btn btn-recalibrate"
            onClick={handleRecalibrate}
          >
            Recalibrate
          </button>
        )}
        <button
          type="button"
          className="btn btn-stop"
          onClick={handleStop}
          disabled={!isRunning}
        >
          Stop
        </button>
      </div>
    </div>
  )
}

export default App
