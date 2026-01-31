/**
 * RunForm PoC – Sparkline: draws a simple line chart in canvas.
 * Auto-scales min/max, no axis labels.
 */

import { useEffect, useRef } from 'react'

export type SparklineProps = {
  data: number[]
  width?: number
  height?: number
  className?: string
  strokeStyle?: string
}

const DEFAULT_WIDTH = 120
const DEFAULT_HEIGHT = 32
const PADDING = 2

export function Sparkline({
  data,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  className = '',
  strokeStyle = 'currentColor',
}: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || data.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio ?? 1
    const w = width * dpr
    const h = height * dpr
    canvas.width = w
    canvas.height = h
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    const chartLeft = PADDING * dpr
    const chartRight = w - PADDING * dpr
    const chartTop = PADDING * dpr
    const chartBottom = h - PADDING * dpr
    const chartW = chartRight - chartLeft
    const chartH = chartBottom - chartTop

    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = strokeStyle
    ctx.lineWidth = Math.max(1, dpr * 1.2)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()

    const stepX = chartW / (data.length - 1)
    for (let i = 0; i < data.length; i++) {
      const x = chartLeft + i * stepX
      const y = chartBottom - ((data[i]! - min) / range) * chartH
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [data, width, height, strokeStyle])

  if (data.length < 2) {
    return (
      <div
        className={className}
        style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--sparkline-empty, #64748b)' }}
        aria-hidden
      >
        –
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={width}
      height={height}
      style={{ display: 'block', maxWidth: '100%' }}
      aria-hidden
    />
  )
}
