import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startPoseRunner,
  stopPoseRunner,
  pausePoseRunner,
  resumePoseRunner,
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
import { Sparkline } from './Sparkline'
import { affiliateLinks, recordAffiliateClick, type AffiliateLinkId } from './affiliatelinks'
import { saveFeedback, hasFeedbackForSession } from './feedback'
import './App.css'

export type ViewMode = 'live' | 'summary' | 'history'

const METRICS_UPDATE_INTERVAL_MS = 500

const RELIABILITY_LABEL: Record<'High' | 'Medium' | 'Low', string> = {
  High: 'Høj',
  Medium: 'Mellem',
  Low: 'Lav',
}

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
  const sessionStartTimeRef = useRef<number>(0)
  const activeStartMsRef = useRef<number>(0)
  const activeAccumMsRef = useRef<number>(0)
  const wakeLockSentinelRef = useRef<WakeLockSentinelLike | null>(null)
  const isRunningRef = useRef(false)
  const sessionSamplesRef = useRef<SessionSample[]>([])
  const frameQualityRef = useRef<number | null>(null)
  const lastGoodCadenceRef = useRef<number | null>(null)
  const pausedRef = useRef(false)

  const [isRunning, setIsRunning] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [totalTimeMs, setTotalTimeMs] = useState(0)
  const [activeTimeMs, setActiveTimeMs] = useState(0)
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
  const [view, setView] = useState<ViewMode>('live')
  const [currentSummary, setCurrentSummary] = useState<SessionSummary | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [summaryNote, setSummaryNote] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>(() => loadSessions())
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null)
  const [legalModal, setLegalModal] = useState<null | 'disclaimer' | 'terms' | 'privacy' | 'coc'>(null)
  const [shareLinkFeedback, setShareLinkFeedback] = useState<string | null>(null)
  const [feedbackSubmittedSessionId, setFeedbackSubmittedSessionId] = useState<string | null>(null)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

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
    const needLock = isRunning && (phase === 'calibrating' || (phase === 'tracking' && !paused))
    if (!needLock) releaseWakeLock()
  }, [isRunning, phase, paused, releaseWakeLock])

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const ph = phaseRef.current
      const needLock = isRunningRef.current && (ph === 'calibrating' || (ph === 'tracking' && !pausedRef.current))
      if (needLock && !wakeLockSentinelRef.current) requestWakeLock()
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
        const now = performance.now()
        trackingStartTimeRef.current = now
        activeStartMsRef.current = now
        activeAccumMsRef.current = 0
        setPhase('tracking')
        phaseRef.current = 'tracking'
        setPaused(false)
        setActiveTimeMs(0)
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
    setPaused(false)
    sessionStartTimeRef.current = performance.now()
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
    activeAccumMsRef.current = 0
    setTotalTimeMs(0)
    setActiveTimeMs(0)

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

  const handlePause = useCallback(() => {
    const now = performance.now()
    activeAccumMsRef.current += now - activeStartMsRef.current
    pausePoseRunner()
    setPaused(true)
  }, [])

  const handleResume = useCallback(() => {
    activeStartMsRef.current = performance.now()
    resumePoseRunner()
    setPaused(false)
    requestWakeLock()
  }, [requestWakeLock])

  const handleStop = useCallback(async () => {
    const endTime = performance.now()
    const startTime = trackingStartTimeRef.current
    const samples = [...sessionSamplesRef.current]
    const totalDurationMs = endTime - sessionStartTimeRef.current
    const activeDurationMs =
      activeAccumMsRef.current +
      (pausedRef.current ? 0 : endTime - activeStartMsRef.current)
    const totalDurationSec = Math.round(totalDurationMs / 1000)
    const activeDurationSec = Math.round(activeDurationMs / 1000)

    await stopPoseRunner()
    releaseWakeLock()
    setIsRunning(false)
    setPaused(false)
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
    metricsSessionRef.current = null
    lastGoodCadenceRef.current = null
    displayedMessageRef.current = null
    sessionSamplesRef.current = []

    if (samples.length > 0) {
      const base = computeSummary(
        samples,
        startTime,
        endTime,
        totalDurationSec,
        activeDurationSec
      )
      const voValues = samples.map((s) => s.voProxy)
      const insights = generateInsights(base, voValues)
      const dateISO = new Date().toISOString()
      const saved = addSession(
        {
          ...base,
          dateISO,
          insights,
          cadenceSamples: samples.map((s) => s.cadence),
          qualitySamples: samples.map((s) => s.quality),
        },
        ''
      )
      setCurrentSummary(saved)
      setSummaryNote(saved.note)
      setSessions(loadSessions())
    } else {
      setCurrentSummary(createEmptySummary(totalDurationSec, activeDurationSec))
      setSummaryNote('')
    }
    setSelectedSessionId(null)
    setView('summary')
  }, [releaseWakeLock])

  useEffect(() => {
    if (!isRunning) return
    const interval = setInterval(() => {
      const now = performance.now()
      setTotalTimeMs(Math.max(0, now - sessionStartTimeRef.current))
      if (phaseRef.current === 'tracking') {
        const active =
          activeAccumMsRef.current +
          (pausedRef.current ? 0 : now - activeStartMsRef.current)
        setActiveTimeMs(Math.max(0, active))
      } else {
        setActiveTimeMs(0)
      }
    }, 500)
    return () => clearInterval(interval)
  }, [isRunning])

  useEffect(() => {
    if (phase !== 'tracking' || !metricsSessionRef.current) return
    const interval = setInterval(() => {
      const now = performance.now()
      const session = metricsSessionRef.current
      if (session && !pausedRef.current) {
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

  const displayedSummaryRef = useRef<SessionSummary | null>(null)

  const handleCopySummary = useCallback(() => {
    if (!displayedSummaryRef.current) return
    const s = displayedSummaryRef.current
    const total = s.totalDurationSec ?? s.durationSec
    const active = s.activeDurationSec ?? s.durationSec
    const formatD = (sec: number) => {
      const m = Math.floor(sec / 60)
      const ss = sec % 60
      return `${m}:${String(ss).padStart(2, '0')}`
    }
    const formatDate = (dateISO: string) => {
      const d = new Date(dateISO)
      return d.toLocaleDateString('da-DK', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    const lines = [
      `Session: ${formatDate(s.dateISO)}`,
      `Total tid: ${formatD(total)} · Aktiv tid: ${formatD(active)}`,
      `Kadence: ${s.cadenceAvg} spm · Stabilitet: ${s.stabilityStdDev} · VO proxy: ${s.voMedian.toFixed(3)} · Pålidelighed: ${RELIABILITY_LABEL[s.reliability]}`,
      'Indsigt:',
      ...s.insights.map((line) => `  · ${line}`),
    ]
    if (s.note.trim()) lines.push(`Note: ${s.note.trim()}`)
    const text = lines.join('\n')
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyFeedback('Kopieret!')
        setTimeout(() => setCopyFeedback(null), 2000)
      },
      () => setCopyFeedback('Kunne ikke kopiere')
    )
  }, [])

  const displayedSummary: SessionSummary | null =
    view === 'summary'
      ? selectedSessionId
        ? sessions.find((s) => s.id === selectedSessionId) ?? currentSummary
        : currentSummary
      : null

  displayedSummaryRef.current = displayedSummary

  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.dateISO).getTime() - new Date(a.dateISO).getTime()
  )
  const currentIndex = displayedSummary
    ? sortedSessions.findIndex((s) => s.id === displayedSummary.id)
    : -1
  const previousSession: SessionSummary | null =
    currentIndex >= 0 && currentIndex < sortedSessions.length - 1
      ? sortedSessions[currentIndex + 1] ?? null
      : null

  const compareDeltas =
    displayedSummary && previousSession
      ? {
          cadence: displayedSummary.cadenceAvg - previousSession.cadenceAvg,
          stability: displayedSummary.stabilityStdDev - previousSession.stabilityStdDev,
          vo: displayedSummary.voMedian - previousSession.voMedian,
        }
      : null

  const handleAffiliateClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, linkId: AffiliateLinkId) => {
    e.preventDefault()
    console.log('Affiliate click:', linkId)
    recordAffiliateClick(linkId)
  }, [])

  const handleShareLink = useCallback(() => {
    if (typeof navigator?.clipboard?.writeText !== 'function') return
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setShareLinkFeedback('Link kopieret')
        setTimeout(() => setShareLinkFeedback(null), 2000)
      },
      () => {}
    )
  }, [])

  const handleFeedback = useCallback((value: 'up' | 'down', sessionId: string, metrics: { cadenceAvg: number; stabilityStdDev: number; voMedian: number; reliability: string }) => {
    saveFeedback({
      timestamp: new Date().toISOString(),
      sessionId,
      value,
      metrics: {
        cadenceAvg: metrics.cadenceAvg,
        stabilityStdDev: metrics.stabilityStdDev,
        voMedian: metrics.voMedian,
        reliability: metrics.reliability,
      },
    })
    setFeedbackSubmittedSessionId(sessionId)
  }, [])

  const handleExportJson = useCallback(() => {
    const s = displayedSummaryRef.current
    if (!s) return
    const json = JSON.stringify(s, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `runform-session-${s.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const calibrationSecondsRemaining = Math.max(
    0,
    5 - Math.floor(goodTimeMs / 1000)
  )
  const calibrationProgress = goodTimeMs / CALIBRATION_DURATION_MS

  const totalMm = Math.floor(totalTimeMs / 60_000)
  const totalSs = Math.floor((totalTimeMs % 60_000) / 1000)
  const totalTimeLabel = `${String(totalMm).padStart(2, '0')}:${String(totalSs).padStart(2, '0')}`
  const activeMm = Math.floor(activeTimeMs / 60_000)
  const activeSs = Math.floor((activeTimeMs % 60_000) / 1000)
  const activeTimeLabel = `${String(activeMm).padStart(2, '0')}:${String(activeSs).padStart(2, '0')}`

  const statusChipLabel =
    view === 'summary'
      ? 'SUMMARY'
      : view === 'history'
        ? 'HISTORY'
        : phase === 'calibrating'
          ? 'CALIBRATING'
          : phase === 'tracking' && paused
            ? 'PAUSED'
            : phase === 'tracking'
              ? 'TRACKING'
              : 'IDLE'

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
        <div className="header-row">
          <h1>RunForm PoC</h1>
          <span className="status-chip" role="status" aria-label={`Status: ${statusChipLabel}`}>
            {statusChipLabel}
          </span>
        </div>
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
                  <span className="history-item-meta">
                    {formatDuration(s.totalDurationSec ?? s.durationSec)} · {s.cadenceAvg} spm · {RELIABILITY_LABEL[s.reliability]}
                  </span>
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
              {formatSessionDate(displayedSummary.dateISO)}
            </p>
            <div className="summary-times">
              <span>Total tid: {formatDuration(displayedSummary.totalDurationSec ?? displayedSummary.durationSec)}</span>
              <span>Aktiv tid: {formatDuration(displayedSummary.activeDurationSec ?? displayedSummary.durationSec)}</span>
              {(displayedSummary.totalDurationSec ?? 0) > (displayedSummary.activeDurationSec ?? 0) && (
                <span>Pause tid: {formatDuration((displayedSummary.totalDurationSec ?? 0) - (displayedSummary.activeDurationSec ?? 0))}</span>
              )}
            </div>
            <h2 className="summary-section-title">Nøgletal</h2>
            <div className="summary-stats summary-stats-with-tooltips">
              <span>Kadence (spm): {displayedSummary.cadenceAvg}</span>
              <span className="stat-with-info">
                Stabilitet (spm): {displayedSummary.stabilityStdDev}
                <button
                  type="button"
                  className="info-icon"
                  aria-label="Forklaring"
                  title="Måler hvor meget kadencen svinger. Lavere = mere stabil."
                  onClick={(e) => { e.preventDefault(); setActiveTooltipId(activeTooltipId === 'stability' ? null : 'stability'); }}
                >
                  <span aria-hidden>ⓘ</span>
                </button>
                {activeTooltipId === 'stability' && (
                  <span className="tooltip-bubble" role="tooltip">Måler hvor meget kadencen svinger. Lavere = mere stabil.</span>
                )}
              </span>
              <span className="stat-with-info">
                VO proxy (relativ): {displayedSummary.voMedian.toFixed(3)}
                <button
                  type="button"
                  className="info-icon"
                  aria-label="Forklaring"
                  title="Relativ måling baseret på video. Ikke cm. Lavere = mindre hop."
                  onClick={(e) => { e.preventDefault(); setActiveTooltipId(activeTooltipId === 'vo' ? null : 'vo'); }}
                >
                  <span aria-hidden>ⓘ</span>
                </button>
                {activeTooltipId === 'vo' && (
                  <span className="tooltip-bubble" role="tooltip">Relativ måling baseret på video. Ikke cm. Lavere = mindre hop.</span>
                )}
              </span>
              <span className="stat-with-info">
                Pålidelighed: {RELIABILITY_LABEL[displayedSummary.reliability]}
                <button
                  type="button"
                  className="info-icon"
                  aria-label="Forklaring"
                  title="Baseret på lys og hvor godt kroppen var i billedet."
                  onClick={(e) => { e.preventDefault(); setActiveTooltipId(activeTooltipId === 'reliability' ? null : 'reliability'); }}
                >
                  <span aria-hidden>ⓘ</span>
                </button>
                {activeTooltipId === 'reliability' && (
                  <span className="tooltip-bubble" role="tooltip">Baseret på lys og hvor godt kroppen var i billedet.</span>
                )}
              </span>
            </div>
            <div className="summary-sparklines">
              <div className="sparkline-block">
                <span className="sparkline-label">Kadence</span>
                <Sparkline
                  data={displayedSummary.cadenceSamples ?? []}
                  width={100}
                  height={28}
                  className="sparkline-canvas"
                />
              </div>
              <div className="sparkline-block">
                <span className="sparkline-label">Kvalitet</span>
                <Sparkline
                  data={displayedSummary.qualitySamples ?? []}
                  width={100}
                  height={28}
                  className="sparkline-canvas"
                />
              </div>
            </div>
            {compareDeltas && (
              <div className="summary-compare" role="region" aria-label="Sammenligning med forrige session">
                <span className="summary-compare-title">Sammenlignet med forrige</span>
                <div className="summary-compare-rows">
                  <span className="compare-row">
                    Kadence {compareDeltas.cadence >= 0 ? '↑' : '↓'} {Math.abs(compareDeltas.cadence).toFixed(1)} spm
                  </span>
                  <span className="compare-row">
                    Stabilitet {compareDeltas.stability <= 0 ? '↓' : '↑'} {Math.abs(compareDeltas.stability).toFixed(1)}
                  </span>
                  <span className="compare-row">
                    VO proxy {compareDeltas.vo <= 0 ? '↓' : '↑'} {Math.abs(compareDeltas.vo).toFixed(3)}
                  </span>
                </div>
              </div>
            )}
            <h2 className="summary-section-title">Indsigt</h2>
            <ul className="summary-insights">
              {displayedSummary.insights.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>

            <section className="affiliate-section" aria-label="Forslag til udstyr">
              <h2 className="summary-section-title">Udstyr, der kan passe til din løbestil</h2>
              <p className="affiliate-subtitle">Generelle forslag baseret på din session</p>
              <div className="affiliate-cards">
                {(displayedSummary.cadenceAvg < 155 || displayedSummary.voMedian >= 0.015) && (
                  <a
                    href={affiliateLinks.liiteguard.tights}
                    className="affiliate-card"
                    onClick={(e) => handleAffiliateClick(e, 'liiteguard.tights')}
                  >
                    <span className="affiliate-card-title">Komfort og støtte til løb</span>
                    <span className="affiliate-card-text">Mere støtte og komfort kan føles mere afslappet</span>
                  </a>
                )}
                {displayedSummary.stabilityStdDev <= 4 && (
                  <a
                    href={affiliateLinks.liiteguard.socks}
                    className="affiliate-card"
                    onClick={(e) => handleAffiliateClick(e, 'liiteguard.socks')}
                  >
                    <span className="affiliate-card-title">Let og fleksibelt løbetøj</span>
                    <span className="affiliate-card-text">Stabil rytme passer ofte godt til let udstyr</span>
                  </a>
                )}
                <a
                  href={affiliateLinks.workwalk.shoes}
                  className="affiliate-card"
                  onClick={(e) => handleAffiliateClick(e, 'workwalk.shoes')}
                >
                  <span className="affiliate-card-title">Komfort før og efter løb</span>
                  <span className="affiliate-card-text">Behageligt fodtøj kan være rart i hverdagen</span>
                </a>
              </div>
            </section>

            <section className="summary-share-feedback" aria-label="Del og feedback">
              <div className="share-feedback-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-share-link"
                  onClick={handleShareLink}
                >
                  Del link
                </button>
                {shareLinkFeedback && (
                  <span className="share-link-confirm" role="status">
                    {shareLinkFeedback}
                  </span>
                )}
              </div>
              <div className="feedback-block">
                <p className="feedback-question">Var denne analyse nyttig?</p>
                {(feedbackSubmittedSessionId === displayedSummary.id || hasFeedbackForSession(displayedSummary.id)) ? (
                  <p className="feedback-thanks">Tak for feedback</p>
                ) : (
                  <div className="feedback-buttons">
                    <button
                      type="button"
                      className="btn btn-feedback btn-feedback-up"
                      onClick={() => handleFeedback('up', displayedSummary.id, {
                        cadenceAvg: displayedSummary.cadenceAvg,
                        stabilityStdDev: displayedSummary.stabilityStdDev,
                        voMedian: displayedSummary.voMedian,
                        reliability: displayedSummary.reliability,
                      })}
                      aria-label="Ja, nyttig"
                    >
                      👍 Ja
                    </button>
                    <button
                      type="button"
                      className="btn btn-feedback btn-feedback-down"
                      onClick={() => handleFeedback('down', displayedSummary.id, {
                        cadenceAvg: displayedSummary.cadenceAvg,
                        stabilityStdDev: displayedSummary.stabilityStdDev,
                        voMedian: displayedSummary.voMedian,
                        reliability: displayedSummary.reliability,
                      })}
                      aria-label="Nej, ikke nyttig"
                    >
                      👎 Nej
                    </button>
                  </div>
                )}
              </div>
            </section>

            <p className="summary-disclaimer">
              Prototype til generel løbe-feedback.{' '}
              <button type="button" className="link-inline" onClick={() => setLegalModal('disclaimer')}>
                Se Disclaimer
              </button>
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
            <div className="summary-copy-export">
              <button type="button" className="btn btn-secondary btn-copy-export" onClick={handleCopySummary}>
                {copyFeedback ?? 'Kopier summary'}
              </button>
              <button type="button" className="btn btn-secondary btn-copy-export" onClick={handleExportJson}>
                Eksport JSON
              </button>
            </div>
            <div className="summary-actions">
              <button type="button" className="btn btn-secondary" onClick={handleNewSession}>
                Ny session
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleBackToLive}>
                Tilbage
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
                  Tilbage
                </button>
              </div>
            </section>
          )}

          <details className="history-accordion">
            <summary className="history-accordion-summary">Seneste sessioner</summary>
            <ul className="history-list">
              {sessions.slice(0, 10).map((s) => (
                <li key={s.id} className="history-item">
                  <button
                    type="button"
                    className="history-item-btn"
                    onClick={() => handleOpenHistorySession(s.id)}
                  >
                    <span className="history-item-date">{formatSessionDate(s.dateISO)}</span>
                    <span className="history-item-meta">
                      {formatDuration(s.totalDurationSec ?? s.durationSec)} · {s.cadenceAvg} spm · {RELIABILITY_LABEL[s.reliability]}
                    </span>
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
          </details>
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

      {view === 'live' && (phase === 'tracking' || paused) && (
        <>
          <div className="baseline-locked baseline-locked-minimal" role="status">
            <span className="baseline-locked-label">
              {paused ? 'Pauset' : 'Baseline locked'}
            </span>
          </div>
          <div className="metrics-panel metrics-panel-minimal" role="region" aria-label="Live">
            <div className="metrics-minimal metrics-minimal-times">
              <span className="metric-value">{totalTimeLabel}</span>
              <span className="metric-label">Total tid</span>
              <span className="metric-value">{activeTimeLabel}</span>
              <span className="metric-label">Aktiv tid</span>
              <span className="metric-value">
                {(metricsSnapshot?.cadence ?? 0) >= 80
                  ? (metricsSnapshot?.cadence ?? '–')
                  : (lastGoodCadenceRef.current ?? metricsSnapshot?.cadence ?? '–')}
              </span>
              <span className="metric-label">
                Kadence (spm)
                {(metricsSnapshot?.cadence ?? 0) > 0 && (metricsSnapshot?.cadence ?? 0) < 80 && (
                  <span className="metric-low-confidence"> (usikker)</span>
                )}
              </span>
            </div>
          </div>
        </>
      )}

      {view === 'live' && isRunning && phase === 'calibrating' && (
        <div className="metrics-panel metrics-panel-minimal" role="region">
          <div className="metrics-minimal">
            <span className="metric-value">{totalTimeLabel}</span>
            <span className="metric-label">Total tid</span>
            <span className="metric-value">0:00</span>
            <span className="metric-label">Aktiv tid</span>
          </div>
        </div>
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
          {phase === 'idle' && (
            <button
              type="button"
              className="btn btn-start"
              onClick={handleStart}
            >
              Start
            </button>
          )}
          {phase === 'calibrating' && (
            <button
              type="button"
              className="btn btn-stop"
              onClick={handleStop}
            >
              Stop (abort)
            </button>
          )}
          {phase === 'tracking' && !paused && (
            <>
              <button
                type="button"
                className="btn btn-pause"
                onClick={handlePause}
              >
                Pause
              </button>
              <button
                type="button"
                className="btn btn-stop"
                onClick={handleStop}
              >
                Stop og se resultat
              </button>
            </>
          )}
          {phase === 'tracking' && paused && (
            <>
              <button
                type="button"
                className="btn btn-start"
                onClick={handleResume}
              >
                Fortsæt
              </button>
              <button
                type="button"
                className="btn btn-stop"
                onClick={handleStop}
              >
                Stop og se resultat
              </button>
            </>
          )}
        </div>
      )}
      <footer className="app-footer">
        <span className="footer-links">
          <button type="button" className="link-footer" onClick={() => setLegalModal('disclaimer')}>
            Disclaimer
          </button>
          <span className="footer-sep" aria-hidden> · </span>
          <button type="button" className="link-footer" onClick={() => setLegalModal('terms')}>
            Vilkår
          </button>
          <span className="footer-sep" aria-hidden> · </span>
          <button type="button" className="link-footer" onClick={() => setLegalModal('privacy')}>
            Privatliv
          </button>
          <span className="footer-sep" aria-hidden> · </span>
          <button type="button" className="link-footer" onClick={() => setLegalModal('coc')}>
            Code of Conduct
          </button>
        </span>
        <button
          type="button"
          className="link-footer"
          onClick={openOnboarding}
          aria-label="Vis opsætningsvejledning"
        >
          Vis opsætningsvejledning
        </button>
      </footer>

      {legalModal && (
        <div
          className="legal-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="legal-modal-title"
          onClick={() => setLegalModal(null)}
        >
          <div
            className="legal-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="legal-modal-title" className="legal-modal-title">
              {legalModal === 'disclaimer' && 'Disclaimer'}
              {legalModal === 'terms' && 'Vilkår for brug'}
              {legalModal === 'privacy' && 'Privatliv'}
              {legalModal === 'coc' && 'Code of Conduct'}
            </h2>
            <button
              type="button"
              className="legal-modal-close"
              onClick={() => setLegalModal(null)}
              aria-label="Luk"
            >
              ✕
            </button>
            <div className="legal-modal-content">
              {legalModal === 'disclaimer' && (
                <>
                  <p>RunForm er en prototype, der giver generel, ikke-personlig feedback baseret på videoanalyse.</p>
                  <p>Oplysninger og resultater fra RunForm er ikke medicinsk rådgivning, udgør ingen diagnose og må ikke bruges som grundlag for behandling, skadeforebyggelse eller sundhedsmæssige beslutninger.</p>
                  <p>Brug af RunForm sker på eget ansvar. Resultater kan variere afhængigt af lys, kameravinkel, afstand og brugerens bevægelse.</p>
                </>
              )}
              {legalModal === 'terms' && (
                <>
                  <p>Ved at bruge RunForm accepterer du følgende:</p>
                  <ul>
                    <li>RunForm leveres &apos;som den er&apos; uden garanti for nøjagtighed eller tilgængelighed.</li>
                    <li>Du er selv ansvarlig for, hvordan du bruger feedback og resultater.</li>
                    <li>RunForm kan ændres, pauses eller fjernes uden varsel.</li>
                    <li>Misbrug eller forsøg på at omgå systemets begrænsninger er ikke tilladt.</li>
                  </ul>
                </>
              )}
              {legalModal === 'privacy' && (
                <>
                  <p>RunForm respekterer dit privatliv.</p>
                  <ul>
                    <li>Video behandles udelukkende lokalt i din browser og uploades ikke.</li>
                    <li>Sessioner gemmes lokalt på din enhed (localStorage).</li>
                    <li>Der indsamles ingen personhenførbare data, medmindre du aktivt indtaster dem.</li>
                    <li>Der anvendes ikke cookies til sporing eller annoncering.</li>
                  </ul>
                </>
              )}
              {legalModal === 'coc' && (
                <>
                  <p>RunForm skal bruges respektfuldt.</p>
                  <ul>
                    <li>Brug kun appen på dig selv eller med samtykke.</li>
                    <li>Ingen chikane, misbrug eller forsøg på at udnytte systemet.</li>
                    <li>Respektér, at RunForm er et teknisk værktøj – ikke en vurdering af menneskers kroppe eller værd.</li>
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
