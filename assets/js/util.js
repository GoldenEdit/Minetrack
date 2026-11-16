export class Tooltip {
  constructor () {
    this._div = document.getElementById('tooltip')
  }

  set (x, y, offsetX, offsetY, html) {
    this._div.innerHTML = html

    // Assign display: block so that the offsetWidth is valid
    this._div.style.display = 'block'

    // Prevent the div from overflowing the page width
    const tooltipWidth = this._div.offsetWidth

    // 1.2 is a magic number used to pad the offset to ensure the tooltip
    // never gets close or surpasses the page's X width
    if (x + offsetX + (tooltipWidth * 1.2) > window.innerWidth) {
      x -= tooltipWidth
      offsetX *= -1
    }

    // On a phone the tooltip can be nearly as wide as the screen, so keep it fully on screen either way
    const maxLeft = window.pageXOffset + document.documentElement.clientWidth - tooltipWidth - 8
    const left = Math.max(window.pageXOffset + 8, Math.min(x + offsetX, maxLeft))
    let top = y + offsetY
    const tooltipHeight = this._div.offsetHeight

    if (top + tooltipHeight + 16 > window.innerHeight + window.pageYOffset) {
      top = y - tooltipHeight - Math.abs(offsetY)
    }
    if (top < window.pageYOffset + 8) top = window.pageYOffset + 8

    this._div.style.top = `${top}px`
    this._div.style.left = `${left}px`
  }

  hide = () => {
    this._div.style.display = 'none'
  }
}

export class Caption {
  constructor () {
    this._div = document.getElementById('status-text')
  }

  set (text) {
    this._div.innerText = text
    this._div.style.display = 'block'
  }

  hide () {
    this._div.style.display = 'none'
  }
}

// Minecraft Java Edition default server port: 25565
// Minecraft Bedrock Edition default server port: 19132
const MINECRAFT_DEFAULT_PORTS = [25565, 19132]

export function formatMinecraftServerAddress (ip, port) {
  if (port && !MINECRAFT_DEFAULT_PORTS.includes(port)) {
    return `${ip}:${port}`
  }
  return ip
}

// Detect gaps in versions by matching their indexes to knownVersions
export function formatMinecraftVersions (versions, knownVersions) {
  if (!versions || !versions.length || !knownVersions || !knownVersions.length) {
    return
  }

  let currentVersionGroup = []
  const versionGroups = []

  for (let i = 0; i < versions.length; i++) {
    // Look for value mismatch between the previous index
    // Require i > 0 since lastVersionIndex is undefined for i === 0
    if (i > 0 && versions[i] - versions[i - 1] !== 1) {
      versionGroups.push(currentVersionGroup)
      currentVersionGroup = []
    }

    currentVersionGroup.push(versions[i])
  }

  // Ensure the last versionGroup is always pushed
  if (currentVersionGroup.length > 0) {
    versionGroups.push(currentVersionGroup)
  }

  if (versionGroups.length === 0) {
    return
  }

  // Remap individual versionGroups values into named versions
  return versionGroups.map(versionGroup => {
    const startVersion = knownVersions[versionGroup[0]]

    if (versionGroup.length === 1) {
      // A versionGroup may contain a single version, only return its name
      // This is a cosmetic catch to avoid version labels like 1.0-1.0
      return startVersion
    } else {
      const endVersion = knownVersions[versionGroup[versionGroup.length - 1]]
      return `${startVersion}-${endVersion}`
    }
  }).join(', ')
}

export function formatTimestampSeconds (secs) {
  const date = new Date(0)
  date.setUTCSeconds(secs)
  return date.toLocaleTimeString()
}

// Formatters are built once because these run on every cursor move and every graph paint
const DAY_OPTIONS = { weekday: 'short', day: 'numeric', month: 'short' }
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, DAY_OPTIONS)
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const DAY_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { ...DAY_OPTIONS, hour: '2-digit', minute: '2-digit' })

export function formatDay (secs) {
  return DAY_FORMAT.format(secs * 1000)
}

export function formatTime (secs) {
  return TIME_FORMAT.format(secs * 1000)
}

export function formatDayTime (secs) {
  return DAY_TIME_FORMAT.format(secs * 1000)
}

export function formatDate (secs) {
  const date = new Date(0)
  date.setUTCSeconds(secs)
  return date.toLocaleDateString()
}

export function formatPercent (x, over) {
  const val = Math.round((x / over) * 100 * 10) / 10
  return `${val}%`
}

export function formatNumber (x) {
  if (typeof x !== 'number') {
    return '-'
  } else {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
}

export function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function safeCssColor (color) {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
    return color
  }
  return cssVar('--text-muted') || '#8a8f98'
}

// Reads a design token from :root, so canvas drawing uses the same colours as the stylesheet
export function cssVar (name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function relativeLuminance ([r, g, b]) {
  const channel = value => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function hslToRgb (h, s, l) {
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255))
}

function rgbToHsl ([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

// Lightens a server colour until it has at least 3:1 contrast against the graph card,
// so dark generated colours (deep blues, browns) stay visible. Hue is kept, so the colour still reads as the same server
export function readableSeriesColor (color, background = '#141516', minContrast = 3) {
  const hex = safeCssColor(color).slice(1)
  const full = hex.length <= 4 ? hex.slice(0, 3).split('').map(c => c + c).join('') : hex.slice(0, 6)
  const rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  const bg = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16))
  const bgLum = relativeLuminance(bg)
  const contrast = c => (relativeLuminance(c) + 0.05) / (bgLum + 0.05)

  if (contrast(rgb) >= minContrast) return '#' + full

  const [h, s] = rgbToHsl(rgb)
  let l = rgbToHsl(rgb)[2]
  let out = rgb
  while (l < 0.95 && contrast(out) < minContrast) {
    l += 0.02
    out = hslToRgb(h, s, l)
  }
  return '#' + out.map(v => v.toString(16).padStart(2, '0')).join('')
}

// 0.1234 -> "12%", 0.004 -> "0.4%", 0.00004 -> "<0.1%"
export function formatRatio (ratio) {
  const percent = ratio * 100
  if (percent > 0 && percent < 0.1) return '<0.1%'
  if (percent < 10) return `${Number(percent.toFixed(1))}%`
  return `${formatNumber(Math.round(percent))}%`
}
