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

    const left = x + offsetX
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
  return '#8a8f98'
}
