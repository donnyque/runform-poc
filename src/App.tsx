import { useCallback, useRef, useState } from 'react'
import {
  startPoseRunner,
  stopPoseRunner,
} from './pose/poseRunner'
import './App.css'

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [poseDetected, setPoseDetected] = useState(false)

  const handleStart = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      setError('Video eller canvas ikke tilgængeligt.')
      return
    }

    setError(null)
    setIsRunning(true)

    await startPoseRunner(video, canvas, {
      onStatus: (f, p) => {
        setFps(f)
        setPoseDetected(p)
      },
      onError: (msg) => {
        setError(msg)
        setIsRunning(false)
      },
    })
  }, [])

  const handleStop = useCallback(async () => {
    await stopPoseRunner()
    setIsRunning(false)
    setError(null)
    setFps(0)
    setPoseDetected(false)
  }, [])

  return (
    <div className="app" ref={containerRef}>
      <header className="header">
        <h1>RunForm PoC</h1>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <strong>Fejl:</strong> {error}
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
        {!isRunning && (
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
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn-start"
          onClick={handleStart}
          disabled={isRunning}
        >
          Start
        </button>
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
