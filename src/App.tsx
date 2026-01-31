import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startPoseRunner,
  stopPoseRunner,
} from './pose/poseRunner'
import type { FrameQualityHint } from './pose/frameQuality'
import { MetricsSession, type MetricsSnapshot } from './pose/metrics'
import {
  requestScreenWakeLock,
  releaseScreenWakeLock,
  type WakeLockSentinelLike,
} from './wakeLock'
import {
  computeSummary,
  generateInsights,
  addSession,
  createEmptySummary,
  updateSessionNote,
  deleteSession,
  loadSessions,
  type SessionSummary,
  type SessionSample,
} from './sessionSummary'
import './App.css'

export type ViewMode = 'live' | 'summary' | 'history'

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
  const wakeLockSentinelRef = useRef<WakeLockSentinelLike | null>(null)
  const isRunningRef = useRef(false)
  const sessionSamplesRef = useRef<SessionSample[]>([])
  const frameQualityRef = useRef<number | null>(null)
  const lastGoodCadenceRef = useRef<number | null>(null)

  const [isRunning, setIsRunning] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
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
  const [view, setView] = useState<ViewMode>('live')
  const [currentSummary, setCurrentSummary] = useState<SessionSummary | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [summaryNote, setSummaryNote] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>(() => loadSessions())

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    isRunningRef.current = isRunning
  }, [isRunning])

  useEffect(() => {
    baselineRef.current = baseline
  }, [baseline])

  useEffect(() => {
    frameQualityRef.current = frameQuality
  }, [frameQuality])

  const requestWakeLock = useCallback(async () => {
    const s = await requestScreenWakeLock()
    if (s) {
      wakeLockSentinelRef.current = s
      setWakeLockActive(true)
      s.addEventListener('release', () => {
        wakeLockSentinelRef.current = null
        setWakeLockActive(false)
      })
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    releaseScreenWakeLock(wakeLockSentinelRef.current, () => {
      wakeLockSentinelRef.current = null
      setWakeLockActive(false)
    })
  }, [])

  useEffect(() => {
    const needLock = isRunning && (phase === 'calibrating' || phase === 'tracking')
    if (!needLock) releaseWakeLock()
  }, [isRunning, phase, releaseWakeLock])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (isRunningRef.current && (phaseRef.current === 'calibrating' || phaseRef.current === 'tracking') && !wakeLockSentinelRef.current) {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [requestWakeLock])

  useEffect(() => {
    return () => {
      releaseScreenWakeLock(wakeLockSentinelRef.current, () => {})
    }
  }, [])

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
      data: {
        ankleY: number
        kneeY: number
        ankleVis: number
        kneeVis: number
        ankleUsed: 'L' | 'R'
        midHipY: number
      },
      timestampMs: number
    ) => {
      if (phaseRef.current !== 'tracking') return
      const bl = baselineRef.current
      if (!bl) return
      metricsSessionRef.current?.update(
        data.ankleY,
        data.kneeY,
        data.ankleVis,
        data.kneeVis,
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

    requestWakeLock()
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
    sessionSamplesRef.current = []

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
    const endTime = performance.now()
    const startTime = trackingStartTimeRef.current
    const samples = [...sessionSamplesRef.current]

    await stopPoseRunner()
    releaseWakeLock()
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
    lastGoodCadenceRef.current = null
    displayedMessageRef.current = null
    sessionSamplesRef.current = []

    if (samples.length > 0) {
      const base = computeSummary(samples, startTime, endTime)
      const voValues = samples.map((s) => s.voProxy)
      const insights = generateInsights(base, voValues)
      const dateISO = new Date().toISOString()
      const saved = addSession(
        { ...base, dateISO, insights },
        ''
      )
      setCurrentSummary(saved)
      setSummaryNote(saved.note)
      setSessions(loadSessions())
    } else {
      setCurrentSummary(createEmptySummary())
      setSummaryNote('')
    }
    setSelectedSessionId(null)
    setView('summary')
  }, [releaseWakeLock])

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
    lastGoodCadenceRef.current = null
    setMetricsSnapshot(null)
    setTrackingTimeMs(0)
  }, [])

  useEffect(() => {
    if (phase !== 'tracking' || !metricsSessionRef.current) return
    const interval = setInterval(() => {
      const now = performance.now()
      const session = metricsSessionRef.current
      if (session) {
        const snap = session.getSnapshot(now)
        if (snap.cadence >= 80) lastGoodCadenceRef.current = snap.cadence
        setMetricsSnapshot(snap)
        sessionSamplesRef.current.push({
          t: now,
          cadence: snap.cadence,
          voProxy: snap.voProxy,
          quality: frameQualityRef.current ?? 0,
        })
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

  const handleNewSession = useCallback(() => {
    setView('live')
    setCurrentSummary(null)
    setSelectedSessionId(null)
    setSummaryNote('')
  }, [])

  const handleBackToLive = useCallback(() => {
    setView('live')
    setSelectedSessionId(null)
  }, [])

  const handleSaveNote = useCallback(() => {
    const id = selectedSessionId ?? currentSummary?.id
    if (id) {
      updateSessionNote(id, summaryNote)
      setSessions(loadSessions())
      setCurrentSummary((prev) => (prev?.id === id ? { ...prev, note: summaryNote } : prev))
    }
  }, [selectedSessionId, currentSummary?.id, summaryNote])

  const handleOpenHistorySession = useCallback((id: string) => {
    const session = loadSessions().find((s) => s.id === id)
    if (session) {
      setSelectedSessionId(id)
      setCurrentSummary(session)
      setSummaryNote(session.note)
      setView('summary')
    }
  }, [])

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id)
    setSessions(loadSessions())
    if (selectedSessionId === id) {
      setView('history')
      setCurrentSummary(null)
      setSelectedSessionId(null)
    } else if (currentSummary?.id === id) {
      setCurrentSummary(null)
      setView('live')
    }
  }, [selectedSessionId, currentSummary?.id])

  const displayedSummary: SessionSummary | null =
    view === 'summary'
      ? selectedSessionId
        ? sessions.find((s) => s.id === selectedSessionId) ?? currentSummary
        : currentSummary
      : null

  const calibrationSecondsRemaining = Math.max(
    0,
    5 - Math.floor(goodTimeMs / 1000)
  )
  const calibrationProgress = goodTimeMs / CALIBRATION_DURATION_MS

  const trackingMm = Math.floor(trackingTimeMs / 60_000)
  const trackingSs = Math.floor((trackingTimeMs % 60_000) / 1000)
  const trackingTimeLabel = `${String(trackingMm).padStart(2, '0')}:${String(trackingSs).padStart(2, '0')}`

  const formatSessionDate = (dateISO: string) => {
    const d = new Date(dateISO)
    return d.toLocaleDateString('da-DK', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="app" ref={containerRef}>
      <header className="header">
        <h1>RunForm PoC</h1>
        {view === 'live' && (
          <span className="wake-lock-status" role="status">
            Awake: {wakeLockActive ? 'on' : 'off'}
          </span>
        )}
        {view === 'live' && (
          <button
            type="button"
            className="link-header"
            onClick={() => {
              setView('history')
              setSessions(loadSessions())
            }}
          >
            Historik
          </button>
        )}
      </header>

      {view === 'history' && (
        <div className="summary-view">
          <h2 className="summary-section-title">Seneste sessioner</h2>
          <ul className="history-list">
            {sessions.slice(0, 10).map((s) => (
              <li key={s.id} className="history-item">
                <button
                  type="button"
                  className="history-item-btn"
                  onClick={() => handleOpenHistorySession(s.id)}
                >
                  <span className="history-item-date">{formatSessionDate(s.dateISO)}</span>
                  <span className="history-item-dur">{formatDuration(s.durationSec)}</span>
                </button>
                <button
                  type="button"
                  className="history-item-delete"
                  onClick={() => handleDeleteSession(s.id)}
                  aria-label="Slet session"
                >
                  Slet
                </button>
              </li>
            ))}
          </ul>
          {sessions.length === 0 && (
            <p className="history-empty">Ingen sessioner endnu.</p>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setView('live')}>
            Tilbage
          </button>
        </div>
      )}

      {view === 'summary' && (
        <div className="summary-view">
          <h2 className="summary-view-header">Summary</h2>
          {displayedSummary ? (
          <section className="summary-card">
            <h2 className="summary-section-title">Session</h2>
            <p className="summary-meta">
              {formatSessionDate(displayedSummary.dateISO)} · {formatDuration(displayedSummary.durationSec)}
            </p>
            <h2 className="summary-section-title">Nøgletal</h2>
            <div className="summary-stats">
              <span>Cadence: {displayedSummary.cadenceAvg} spm</span>
              <span>Stability: {displayedSummary.stabilityStdDev} spm</span>
              <span>VO proxy: {displayedSummary.voMedian.toFixed(3)} rel</span>
              <span>Pålidelighed: {displayedSummary.reliability}</span>
            </div>
            <h2 className="summary-section-title">Indsigt</h2>
            <ul className="summary-insights">
              {displayedSummary.insights.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            <p className="summary-disclaimer">
              Prototype. Kun generel feedback. Ingen diagnoser.
            </p>
            <label className="summary-note-label">
              Note
              <textarea
                className="summary-note-input"
                value={summaryNote}
                onChange={(e) => setSummaryNote(e.target.value)}
                placeholder="Valgfri note..."
                rows={2}
              />
            </label>
            <button type="button" className="btn btn-secondary btn-save-note" onClick={handleSaveNote}>
              Gem note
            </button>
            <div className="summary-actions">
              <button type="button" className="btn btn-secondary" onClick={handleNewSession}>
                Ny session
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleBackToLive}>
                Tilbage til live
              </button>
            </div>
          </section>
          ) : (
            <section className="summary-card summary-card-empty">
              <p className="summary-empty-message">Ingen måledata fra denne session.</p>
              <div className="summary-actions">
                <button type="button" className="btn btn-secondary" onClick={handleNewSession}>
                  Ny session
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleBackToLive}>
                  Tilbage til live
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      {view === 'live' && showOnboarding && (
        <div className="onboarding-overlay"  role="dialog" aria-labelledby="onboarding-title">
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

      {view === 'live' && error && (
        <div className="error-banner" role="alert">
          <strong>Fejl:</strong> {error}
        </div>
      )}

      {view === 'live' && phase === 'calibrating' && (
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

      {view === 'live' && phase === 'tracking' && (
        <>
          <div className="baseline-locked baseline-locked-minimal" role="status">
            <span className="baseline-locked-label">Baseline locked</span>
          </div>
          <div className="metrics-panel metrics-panel-minimal" role="region" aria-label="Live">
            <div className="metrics-minimal">
              <span className="metric-value">{trackingTimeLabel}</span>
              <span className="metric-label">Tid</span>
              <span className="metric-value">
                {(metricsSnapshot?.cadence ?? 0) >= 80
                  ? (metricsSnapshot?.cadence ?? '–')
                  : (lastGoodCadenceRef.current ?? metricsSnapshot?.cadence ?? '–')}
              </span>
              <span className="metric-label">
                Cadence spm
                {(metricsSnapshot?.cadence ?? 0) > 0 && (metricsSnapshot?.cadence ?? 0) < 80 && (
                  <span className="metric-low-confidence"> (low confidence)</span>
                )}
              </span>
            </div>
          </div>
        </>
      )}

      {view === 'live' && (
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
      )}

      {view === 'live' && (
        <details className="debug-accordion">
          <summary className="debug-accordion-summary">Debug / status</summary>
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
            <span className="status-item">
              stepsLast10s: {metricsSnapshot?.stepsLast10s ?? '–'}
            </span>
          </div>
        </details>
      )}

      {view === 'live' && hintMessage && (
        <div className="hint-message" role="status">
          {hintMessage}
        </div>
      )}

      {view === 'live' && (
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
      )}
      <footer className="app-footer">
        <button
          type="button"
          className="link-footer"
          onClick={openOnboarding}
          aria-label="Vis opsætningsvejledning"
        >
          Vis opsætningsvejledning
        </button>
        <p className="footer-disclaimer">Prototype. Kun generel feedback.</p>
      </footer>
    </div>
  )
}

export default App
