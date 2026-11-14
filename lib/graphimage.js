// Draws a shared graph view as a PNG for link previews (Discord, Slack, X...), which never run the page's JavaScript
const fs = require('fs')
const path = require('path')

const WIDTH = 1200
const HEIGHT = 630

// Plenty for a 1000px wide plot while keeping the SVG small
const MAX_POINTS = 600

// Busy views stay readable by drawing only the biggest servers
const MAX_PLOTTED_SERVERS = 10

// Design tokens from assets/css/main.css
const COLORS = {
  canvas: '#08090a',
  surface: '#141516',
  line: '#23252a',
  lineStrong: '#34343a',
  text: '#f7f8f8',
  textSecondary: '#d0d6e0',
  muted: '#8a8f98',
  tertiary: '#62666d'
}

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts', 'og')
const FONT_FILES = ['Inter_400Regular.ttf', 'Inter_600SemiBold.ttf'].map(file => path.join(FONT_DIR, file))
const FONT = 'Inter'

const LOGO_DATA_URI = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, '..', 'assets', 'images', 'logo.svg')).toString('base64')

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const X_TICK_STEPS = [5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]

function escapeXml (value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[char])
}

function formatNumber (value) {
  return Math.round(value).toLocaleString('en-US')
}

function pad (value) {
  return String(value).padStart(2, '0')
}

function formatTime (seconds) {
  const date = new Date(seconds * 1000)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function formatDay (seconds, withYear) {
  const date = new Date(seconds * 1000)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${withYear ? ` ${date.getUTCFullYear()}` : ''}`
}

// "14 Nov 2026, 10:13 – 13:13 UTC" or "12 Nov 10:13 – 14 Nov 13:13 UTC"
function formatWindow (from, to) {
  if (formatDay(from, true) === formatDay(to, true)) {
    return `${formatDay(from, true)}, ${formatTime(from)} – ${formatTime(to)} UTC`
  }
  return `${formatDay(from)} ${formatTime(from)} – ${formatDay(to)} ${formatTime(to)} UTC`
}

function lowerBound (values, target) {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid] < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

// Slices each server's in-memory graph to the window and keeps the max of each bucket, so peaks survive downsampling
function collectSeries (timestamps, resolved) {
  const start = lowerBound(timestamps, resolved.from)
  const end = lowerBound(timestamps, resolved.to + 1)
  const count = Math.max(0, end - start)
  const bucketSize = Math.max(1, Math.ceil(count / MAX_POINTS))

  const times = []
  for (let i = start; i < end; i += bucketSize) {
    times.push(timestamps[i])
  }

  const series = resolved.registrations.map(serverRegistration => {
    const graphData = serverRegistration.graphData || []
    const values = []
    let peak = null
    let latest = null

    for (let i = start; i < end; i += bucketSize) {
      let max = null
      for (let j = i; j < Math.min(i + bucketSize, end); j++) {
        const value = graphData[j]
        if (typeof value === 'number' && (max === null || value > max)) {
          max = value
        }
        if (typeof value === 'number') {
          latest = value
        }
      }
      values.push(max)
      if (max !== null && (peak === null || max > peak)) {
        peak = max
      }
    }

    return {
      name: serverRegistration.data.name,
      color: serverRegistration.data.color || COLORS.textSecondary,
      values,
      peak,
      latest
    }
  })

  return { times, series }
}

// 1, 2, 2.5 or 5 times a power of ten, giving 3 to 5 gridlines
function niceStep (max) {
  const rough = max / 4
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const step = [1, 2, 2.5, 5, 10].map(multiple => multiple * power).find(candidate => candidate >= rough)
  return Math.max(1, step)
}

function getYAxis (maxValue) {
  if (!(maxValue > 0)) {
    return { max: 10, ticks: [0, 5, 10] }
  }
  const step = niceStep(maxValue * 1.05)
  const max = Math.ceil((maxValue * 1.05) / step) * step
  const ticks = []
  for (let value = 0; value <= max + step / 2; value += step) {
    ticks.push(value)
  }
  return { max, ticks }
}

function getXTicks (from, to) {
  const span = to - from
  const step = X_TICK_STEPS.find(candidate => span / candidate <= 6) || Math.ceil(span / 6 / DAY) * DAY

  const ticks = []
  for (let tick = Math.ceil(from / step) * step; tick <= to; tick += step) {
    let label
    if (step >= DAY || (span > DAY && tick % DAY === 0)) {
      label = formatDay(tick)
    } else {
      label = formatTime(tick)
    }
    ticks.push({ time: tick, label })
  }
  return ticks
}

function truncate (text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

// Rough Inter advance width, good enough to lay out a legend without measuring
function estimateWidth (text, fontSize) {
  return text.length * fontSize * 0.56
}

function getTitle (resolved) {
  if (resolved.isAllServers) return 'All servers'
  const names = resolved.registrations.map(serverRegistration => serverRegistration.data.name)
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
}

function buildSvg (resolved, timestamps) {
  const { times, series } = collectSeries(timestamps, resolved)

  const ranked = series
    .filter(entry => entry.peak !== null)
    .sort((a, b) => b.peak - a.peak)
  const plotted = ranked.slice(0, MAX_PLOTTED_SERVERS)
  const isSingle = resolved.registrations.length === 1

  const plot = {
    left: 112,
    right: WIDTH - 56,
    top: 172,
    bottom: HEIGHT - 104
  }

  const yAxis = getYAxis(Math.max(0, ...plotted.map(entry => entry.peak)))
  const xScale = time => plot.left + (time - resolved.from) / Math.max(1, resolved.to - resolved.from) * (plot.right - plot.left)
  const yScale = value => plot.bottom - value / yAxis.max * (plot.bottom - plot.top)

  const parts = []

  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.canvas}"/>`)

  // Header
  parts.push(`<image href="${LOGO_DATA_URI}" x="56" y="48" width="44" height="44"/>`)
  parts.push(`<text x="116" y="82" font-family="${FONT}" font-weight="600" font-size="36" fill="${COLORS.text}">${escapeXml(truncate(getTitle(resolved), isSingle ? 30 : 40))}</text>`)
  parts.push(`<text x="56" y="130" font-family="${FONT}" font-size="22" fill="${COLORS.muted}">${escapeXml(formatWindow(resolved.from, resolved.to))}</text>`)

  if (isSingle && series[0] && series[0].peak !== null) {
    const stats = [['Peak', series[0].peak], ['Latest', series[0].latest]]
    let x = WIDTH - 56
    for (let i = stats.length - 1; i >= 0; i--) {
      const [label, value] = stats[i]
      if (value === null) continue
      parts.push(`<text x="${x}" y="82" text-anchor="end" font-family="${FONT}" font-weight="600" font-size="36" fill="${COLORS.text}">${formatNumber(value)}</text>`)
      parts.push(`<text x="${x}" y="130" text-anchor="end" font-family="${FONT}" font-size="22" fill="${COLORS.muted}">${label}</text>`)
      x -= Math.max(estimateWidth(formatNumber(value), 36), estimateWidth(label, 22)) + 48
    }
  } else {
    parts.push(`<text x="${WIDTH - 56}" y="82" text-anchor="end" font-family="${FONT}" font-weight="600" font-size="24" fill="${COLORS.textSecondary}">Minetrack</text>`)
  }

  // Gridlines and Y labels
  for (const tick of yAxis.ticks) {
    const y = yScale(tick).toFixed(1)
    parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${y}" y2="${y}" stroke="${tick === 0 ? COLORS.lineStrong : COLORS.line}" stroke-width="1"/>`)
    parts.push(`<text x="${plot.left - 16}" y="${y}" dy="7" text-anchor="end" font-family="${FONT}" font-size="20" fill="${COLORS.muted}">${formatNumber(tick)}</text>`)
  }

  // X labels
  for (const tick of getXTicks(resolved.from, resolved.to)) {
    const x = xScale(tick.time)
    if (x < plot.left + 24 || x > plot.right - 24) continue
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${plot.bottom}" y2="${plot.bottom + 8}" stroke="${COLORS.lineStrong}" stroke-width="1"/>`)
    parts.push(`<text x="${x.toFixed(1)}" y="${plot.bottom + 36}" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${COLORS.muted}">${escapeXml(tick.label)}</text>`)
  }

  if (plotted.length === 0) {
    parts.push(`<text x="${(plot.left + plot.right) / 2}" y="${(plot.top + plot.bottom) / 2}" text-anchor="middle" font-family="${FONT}" font-size="24" fill="${COLORS.muted}">No data for this time range</text>`)
  }

  // Lines, biggest server drawn last so it stays on top
  const strokeWidth = plotted.length <= 3 ? 3 : 2
  parts.push(`<clipPath id="plot"><rect x="${plot.left}" y="${plot.top - 4}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top + 4}"/></clipPath>`)
  parts.push('<g clip-path="url(#plot)">')

  plotted.slice().reverse().forEach((entry, index) => {
    // Each run of non-null values is its own segment so outages show as gaps
    const segments = []
    let current = []
    entry.values.forEach((value, i) => {
      if (value === null) {
        if (current.length) segments.push(current)
        current = []
      } else {
        current.push([xScale(times[i]), yScale(value)])
      }
    })
    if (current.length) segments.push(current)

    if (plotted.length === 1) {
      parts.push(`<linearGradient id="fill${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${escapeXml(entry.color)}" stop-opacity="0.28"/><stop offset="1" stop-color="${escapeXml(entry.color)}" stop-opacity="0"/></linearGradient>`)
      for (const segment of segments) {
        if (segment.length < 2) continue
        const area = segment.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')
        parts.push(`<path d="M${segment[0][0].toFixed(1)},${plot.bottom} L${area} L${segment[segment.length - 1][0].toFixed(1)},${plot.bottom} Z" fill="url(#fill${index})"/>`)
      }
    }

    const d = segments.map(segment => {
      // A lone point still needs a visible mark
      const points = segment.length === 1 ? [segment[0], [segment[0][0] + 1, segment[0][1]]] : segment
      return 'M' + points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')
    }).join(' ')

    if (d) {
      parts.push(`<path d="${d}" fill="none" stroke="${escapeXml(entry.color)}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`)
    }
  })

  parts.push('</g>')

  // Legend, sorted by peak, until the row is full
  if (!isSingle && plotted.length > 0) {
    const legendY = HEIGHT - 32
    const maxX = WIDTH - 56
    let x = plot.left
    let shown = 0

    for (const entry of ranked) {
      const name = truncate(entry.name, 18)
      const peak = formatNumber(entry.peak)
      const width = 22 + estimateWidth(name, 20) + 10 + estimateWidth(peak, 20) + 32
      const remaining = ranked.length - shown - 1
      const reserve = remaining > 0 ? 130 : 0
      if (x + width > maxX - reserve) break

      parts.push(`<circle cx="${(x + 7).toFixed(1)}" cy="${legendY - 7}" r="7" fill="${escapeXml(entry.color)}"/>`)
      parts.push(`<text x="${(x + 22).toFixed(1)}" y="${legendY}" font-family="${FONT}" font-size="20" fill="${COLORS.textSecondary}">${escapeXml(name)} <tspan fill="${COLORS.muted}">${peak}</tspan></text>`)
      x += width
      shown++
    }

    if (shown < ranked.length) {
      parts.push(`<text x="${x.toFixed(1)}" y="${legendY}" font-family="${FONT}" font-size="20" fill="${COLORS.muted}">+${ranked.length - shown} more</text>`)
    }
  } else if (isSingle) {
    parts.push(`<text x="${WIDTH - 56}" y="${HEIGHT - 32}" text-anchor="end" font-family="${FONT}" font-weight="600" font-size="20" fill="${COLORS.tertiary}">Minetrack</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join('')}</svg>`
}

function renderPng (resolved, timestamps) {
  // Required lazily so a missing native binary only breaks previews, never the site
  const { Resvg } = require('@resvg/resvg-js')

  const resvg = new Resvg(buildSvg(resolved, timestamps), {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: FONT
    }
  })

  return resvg.render().asPng()
}

// Text for the og:title / og:description tags
function describe (resolved, timestamps) {
  const { series } = collectSeries(timestamps, resolved)
  const title = `${getTitle(resolved)} · Minetrack`
  const window = formatWindow(resolved.from, resolved.to)

  if (resolved.registrations.length === 1) {
    const entry = series[0]
    const stats = entry && entry.peak !== null ? `Peak ${formatNumber(entry.peak)} players · ` : ''
    return { title: `${getTitle(resolved)} player count · Minetrack`, description: `${stats}${window}` }
  }

  const top = series
    .filter(entry => entry.peak !== null)
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 3)
    .map(entry => `${entry.name} ${formatNumber(entry.peak)}`)

  return {
    title,
    description: top.length ? `Peak players: ${top.join(', ')} · ${window}` : window
  }
}

module.exports = {
  WIDTH,
  HEIGHT,
  buildSvg,
  renderPng,
  describe,
  collectSeries,
  getYAxis,
  getXTicks,
  escapeXml
}
