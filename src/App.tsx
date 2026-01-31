import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startPoseRunner,
  stopPoseRunner,
} from './pose/poseRunner'
import type { FrameQualityHint } from './pose/frameQuality'
import './App.css'

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

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

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
        setBaseline({ hipY, torsoY })
        setGoodTimeMs(CALIBRATION_DURATION_MS)
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
      onError: (msg) => {
        setError(msg)
        setIsRunning(false)
        setPhase('idle')
        phaseRef.current = 'idle'
      },
    })
  }, [handleCalibrationFrame])

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
  }, [])

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
        <div className="baseline-locked" role="status">
          <span className="baseline-locked-label">Baseline locked</span>
          {baseline != null && (
            <div className="debug-panel">
              <span>hipY: {baseline.hipY.toFixed(3)}</span>
              <span>torsoY: {baseline.torsoY.toFixed(3)}</span>
            </div>
          )}
        </div>
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
