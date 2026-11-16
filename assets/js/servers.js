import uPlot from 'uplot'

import { RelativeScale } from './scale'
import { formatNumber, formatTimestampSeconds, formatDate, formatMinecraftServerAddress, formatMinecraftVersions, formatRatio, escapeHtml, safeCssColor, readableSeriesColor } from './util'
import { uPlotTooltipPlugin } from './plugins'
import { isLegacyDesign } from './design'

import MISSING_FAVICON from 'url:../images/missing_favicon.svg'

// Week over week changes smaller than this are not shown
const TREND_THRESHOLD = 0.03

const FAVORITE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.75l1.64 3.32 3.66.53-2.65 2.58.63 3.65L8 10.1l-3.28 1.73.63-3.65L2.7 5.6l3.66-.53L8 1.75z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

export class ServerRegistry {
  constructor (app) {
    this._app = app
    this._serverIdsByName = []
    this._serverDataById = []
    this._registeredServers = []
    this._searchQuery = ''
  }

  assignServers (servers) {
    for (let i = 0; i < servers.length; i++) {
      const data = servers[i]
      this._serverIdsByName[data.name] = i
      this._serverDataById[i] = data
    }
  }

  createServerRegistration (serverId) {
    const serverData = this._serverDataById[serverId]
    const serverRegistration = new ServerRegistration(this._app, serverId, serverData)
    this._registeredServers[serverId] = serverRegistration
    return serverRegistration
  }

  getServerRegistration (serverKey) {
    if (typeof serverKey === 'string') {
      const serverId = this._serverIdsByName[serverKey]
      return this._registeredServers[serverId]
    } else if (typeof serverKey === 'number') {
      return this._registeredServers[serverKey]
    }
  }

  getServerRegistrations = () => Object.values(this._registeredServers)

  setSearchQuery (query) {
    this._searchQuery = String(query || '').trim().toLowerCase()
    this.applySearch()
  }

  applySearch () {
    const query = this._searchQuery
    let visible = 0
    const servers = this.getServerRegistrations()

    for (const server of servers) {
      const element = document.getElementById(`container_${server.serverId}`)
      if (!element) continue

      const address = formatMinecraftServerAddress(server.data.ip, server.data.port).toLowerCase()
      const match = query.length === 0 ||
        server.data.name.toLowerCase().indexOf(query) !== -1 ||
        address.indexOf(query) !== -1

      element.classList.toggle('is-filtered', !match)
      if (match) visible++
    }

    const empty = document.getElementById('server-empty')
    if (empty) empty.hidden = !(servers.length > 0 && visible === 0)

    const emptyQuery = document.getElementById('server-empty-query')
    if (emptyQuery) emptyQuery.innerText = query

    this.updateFavoritesDivider()
  }

  updateFavoritesDivider () {
    const divider = document.getElementById('favorites-divider')
    if (!divider) return

    let favorite = false
    let other = false

    for (const server of this.getServerRegistrations()) {
      const element = document.getElementById(`container_${server.serverId}`)
      if (!element || element.classList.contains('is-filtered')) continue
      if (server.isFavorite) favorite = true
      else other = true
    }

    divider.classList.toggle('is-hidden', !(favorite && other))
  }

  // Ranks and week-over-week change, so servers can be compared at a glance
  updateStandings () {
    if (isLegacyDesign()) return

    const servers = this.getServerRegistrations()
    const online = servers.filter(server => !server.isOffline && server.playerCount > 0)
    const total = online.reduce((sum, server) => sum + server.playerCount, 0)

    online.sort((a, b) => b.playerCount - a.playerCount)
    const playerRanks = new Map()
    online.forEach((server, index) => playerRanks.set(server, index + 1))

    // The rank column follows the Record sort too, so the numbers always count down the list in order
    let shownRanks = playerRanks
    const list = document.getElementById('server-list')
    if (list && list.dataset.sort === 'record') {
      shownRanks = new Map()
      servers
        .filter(server => server.lastRecordData)
        .sort((a, b) => b.lastRecordData.playerCount - a.lastRecordData.playerCount)
        .forEach((server, index) => shownRanks.set(server, index + 1))
    }

    const now = Date.now() / 1000

    for (const server of servers) {
      const lastWeek = this._app.graphDisplayManager.getLastWeekPlayerCount(server.serverId, now)
      server.updateStanding(shownRanks.get(server), playerRanks.get(server), total, lastWeek)
    }
  }

  resizeSparklines () {
    for (const server of this.getServerRegistrations()) {
      server.requestResize()
    }
  }

  reset () {
    for (const server of this.getServerRegistrations()) {
      if (server._plotInstance) {
        server._plotInstance.destroy()
        server._plotInstance = undefined
      }
    }

    this._serverIdsByName = []
    this._serverDataById = []
    this._registeredServers = []

    // Reset modified DOM structures
    document.getElementById('server-list').innerHTML = ''

    const empty = document.getElementById('server-empty')
    if (empty) empty.hidden = true
  }
}

export class ServerRegistration {
  playerCount = 0
  isVisible = true
  isFavorite = false
  isOffline = false
  rankIndex
  lastRecordData
  lastPeakData

  constructor (app, serverId, data) {
    this._app = app
    this.serverId = serverId
    this.data = data

    // The new design draws on a dark card, so colours too dark to see there are lightened
    if (!isLegacyDesign()) this.data.color = readableSeriesColor(data.color)
    this._graphData = [[], []]
    this._failedSequentialPings = 0
  }

  getGraphDataIndex () {
    return this.serverId + 1
  }

  addGraphPoints (points, timestampPoints) {
    this._graphData = [
      timestampPoints.slice(),
      points
    ]
  }

  buildPlotInstance () {
    if (isLegacyDesign()) {
      this.buildLegacyPlotInstance()
      return
    }

    const element = document.getElementById(`chart_${this.serverId}`)
    const width = element.clientWidth || 140

    this._plotInstance = new uPlot({
      height: 32,
      width,
      padding: [4, 0, 4, 0],
      cursor: {
        show: false
      },
      select: {
        show: false
      },
      series: [
        {},
        {
          stroke: safeCssColor(this.data.color),
          width: 1.5,
          spanGaps: true,
          points: {
            show: false
          }
        }
      ],
      axes: [
        { show: false },
        { show: false }
      ],
      scales: {
        y: {
          auto: false,
          range: () => {
            const values = this._graphData[1]
            let min
            let max
            let found = false

            for (let i = 0; i < values.length; i++) {
              const value = values[i]
              if (typeof value !== 'number') continue
              if (!found) {
                min = max = value
                found = true
              } else if (value < min) {
                min = value
              } else if (value > max) {
                max = value
              }
            }

            if (!found) return [0, 1]
            if (min === max) return [Math.max(0, min - 1), max + 1]
            const pad = (max - min) * 0.12
            return [Math.max(0, min - pad), max + pad]
          }
        }
      },
      legend: {
        show: false
      }
    }, this._graphData, element)
  }

  requestResize () {
    if (!this._plotInstance) return

    if (this._resizeTimer) clearTimeout(this._resizeTimer)

    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = undefined
      this.resizePlot()
    }, 200)
  }

  buildLegacyPlotInstance () {
    const tickCount = 4

    this._plotInstance = new uPlot({
      plugins: [
        uPlotTooltipPlugin((pos, id) => {
          if (pos) {
            const playerCount = this._graphData[1][id]

            if (typeof playerCount !== 'number') {
              this._app.tooltip.hide()
            } else {
              this._app.tooltip.set(pos.left, pos.top, 10, 10, `${formatNumber(playerCount)} Players<br>${formatTimestampSeconds(this._graphData[0][id])}`)
            }
          } else {
            this._app.tooltip.hide()
          }
        })
      ],
      height: 100,
      width: 400,
      cursor: {
        y: false,
        drag: {
          setScale: false,
          x: false,
          y: false
        },
        sync: {
          key: 'minetrack-server',
          setSeries: true
        }
      },
      series: [
        {},
        {
          stroke: '#E9E581',
          width: 2,
          value: (_, raw) => `${formatNumber(raw)} Players`,
          spanGaps: true,
          points: {
            show: false
          }
        }
      ],
      axes: [
        {
          show: false
        },
        {
          ticks: {
            show: false
          },
          font: '14px "Open Sans", sans-serif',
          stroke: '#A3A3A3',
          size: 55,
          grid: {
            stroke: '#333',
            width: 1
          },
          split: () => {
            const { scaledMin, scaledMax, scale } = RelativeScale.scale(this._graphData[1], tickCount)
            const ticks = RelativeScale.generateTicks(scaledMin, scaledMax, scale)
            return ticks
          }
        }
      ],
      scales: {
        y: {
          auto: false,
          range: () => {
            const { scaledMin, scaledMax } = RelativeScale.scale(this._graphData[1], tickCount)
            return [scaledMin, scaledMax]
          }
        }
      },
      legend: {
        show: false
      }
    }, this._graphData, document.getElementById(`chart_${this.serverId}`))
  }

  resizePlot () {
    if (isLegacyDesign() || !this._plotInstance) return

    const element = document.getElementById(`chart_${this.serverId}`)
    if (!element) return

    const width = element.clientWidth
    if (width > 0) {
      this._plotInstance.setSize({ width, height: 32 })
    }
  }

  handlePing (payload, timestamp) {
    if (typeof payload.playerCount === 'number') {
      this.playerCount = payload.playerCount

      // Reset failed ping counter to ensure the next connection error
      // doesn't instantly retrigger a layout change
      this._failedSequentialPings = 0
    } else {
      // Attempt to retain a copy of the cached playerCount for up to N failed pings
      // This prevents minor connection issues from constantly reshuffling the layout
      if (++this._failedSequentialPings > 5) {
        this.playerCount = 0
      }
    }

    // Use payload.playerCount so nulls WILL be pushed into the graphing data
    this._graphData[0].push(timestamp)
    this._graphData[1].push(payload.playerCount)

    // Drop a batch of leading points instead of shifting one element on every ping.
    // Between trims the sparkline may hold up to 60 extra samples, then it snaps back to the configured length.
    const maxLength = this._app.publicConfig.serverGraphMaxLength
    if (this._graphData[0].length > maxLength + 60) {
      const extra = this._graphData[0].length - maxLength
      this._graphData[0].splice(0, extra)
      this._graphData[1].splice(0, extra)
    }

    // Redraw the plot instance
    if (this._plotInstance) {
      this._plotInstance.setData(this._graphData)
    }
  }

  updateServerRankIndex (rankIndex) {
    this.rankIndex = rankIndex

    // The new design ranks by player count in #updateStanding, whatever the list is sorted by
    if (!isLegacyDesign()) return

    const label = document.getElementById(`ranking_${this.serverId}`)
    if (label) label.innerText = `#${rankIndex + 1}`
  }

  updateStanding (shownRank, rank, total, lastWeek) {
    const rankElement = document.getElementById(`ranking_${this.serverId}`)
    const trendElement = document.getElementById(`trend_${this.serverId}`)
    const playersElement = document.getElementById(`player-count_${this.serverId}`)
    const live = typeof rank === 'number'

    if (rankElement) {
      const text = typeof shownRank === 'number' ? String(shownRank) : ''
      if (rankElement.innerText !== text) rankElement.innerText = text
    }

    if (playersElement) {
      if (live && total > 0) {
        playersElement.title = `#${rank} by players · ${formatRatio(this.playerCount / total)} of everyone online`
      } else {
        playersElement.removeAttribute('title')
      }
    }

    if (trendElement) {
      let html = ''
      let direction = ''

      // Small swings are noise at a glance, so only changes of a few percent or more get shown
      if (live && typeof lastWeek === 'number' && lastWeek > 0) {
        const change = (this.playerCount - lastWeek) / lastWeek

        if (Math.abs(change) >= TREND_THRESHOLD) {
          direction = change > 0 ? 'up' : 'down'
          html = `<span class="trend-arrow" aria-hidden="true">${change > 0 ? '▲' : '▼'}</span><span class="sr-only">${change > 0 ? 'Up' : 'Down'} </span>${formatRatio(Math.abs(change))}`
        }

        trendElement.title = `${formatNumber(lastWeek)} players at this time last week`
      } else {
        trendElement.removeAttribute('title')
      }

      if (trendElement.dataset.html !== html) {
        trendElement.dataset.html = html
        trendElement.innerHTML = html
      }
      trendElement.dataset.direction = direction
    }
  }

  _renderValue (prefix, handler) {
    const labelElement = document.getElementById(`${prefix}_${this.serverId}`)
    if (!labelElement) return

    labelElement.style.display = 'block'

    const valueElement = document.getElementById(`${prefix}-value_${this.serverId}`)
    const targetElement = valueElement || labelElement

    if (typeof handler === 'function') {
      handler(targetElement)
    } else {
      targetElement.innerText = handler
    }
  }

  _hideValue (prefix) {
    const element = document.getElementById(`${prefix}_${this.serverId}`)
    if (element) element.style.display = 'none'
  }

  updateServerStatus (ping, minecraftVersions) {
    if (isLegacyDesign()) {
      this.updateLegacyServerStatus(ping, minecraftVersions)
      return
    }

    if (ping.recordData) {
      this.lastRecordData = ping.recordData

      const valueElement = document.getElementById(`record-value_${this.serverId}`)

      if (valueElement) {
        valueElement.innerText = formatNumber(ping.recordData.playerCount)

        // The date is detail, so it lives in the tooltip rather than taking a line in every row
        if (ping.recordData.timestamp > 0) {
          valueElement.title = `Record set ${formatDate(ping.recordData.timestamp)} ${formatTimestampSeconds(ping.recordData.timestamp)}`
        } else {
          valueElement.removeAttribute('title')
        }
      }
    }

    const row = document.getElementById(`container_${this.serverId}`)
    const pill = document.getElementById(`offline_${this.serverId}`)
    const isWaiting = ping.error && ping.error.message === 'Pinging...'
    const isOffline = !isWaiting && (!!ping.error || typeof ping.playerCount !== 'number')

    this.isOffline = isOffline

    if (row) {
      row.classList.toggle('is-offline', isOffline)
      row.classList.toggle('is-waiting', !!isWaiting)
    }
    if (pill) pill.hidden = !isOffline

    if (isWaiting) {
      this._renderValue('player-count', '-')
    } else if (isOffline) {
      this._hideValue('player-count')
    } else {
      this._renderValue('player-count', formatNumber(ping.playerCount))
    }

    this._updateFavicon(ping.favicon)
  }

  updateLegacyServerStatus (ping, minecraftVersions) {
    if (ping.versions) {
      this._renderValue('version', formatMinecraftVersions(ping.versions, minecraftVersions[this.data.type]) || '')
    }

    if (ping.recordData) {
      this._renderValue('record', (element) => {
        if (ping.recordData.timestamp > 0) {
          element.innerText = `${formatNumber(ping.recordData.playerCount)} (${formatDate(ping.recordData.timestamp)})`
          element.title = `At ${formatDate(ping.recordData.timestamp)} ${formatTimestampSeconds(ping.recordData.timestamp)}`
        } else {
          element.innerText = formatNumber(ping.recordData.playerCount)
        }
      })

      this.lastRecordData = ping.recordData
    }

    if (ping.graphPeakData) {
      this._renderValue('peak', (element) => {
        element.innerText = formatNumber(ping.graphPeakData.playerCount)
        element.title = `At ${formatTimestampSeconds(ping.graphPeakData.timestamp)}`
      })

      this.lastPeakData = ping.graphPeakData
    }

    if (ping.error) {
      this._hideValue('player-count')
      this._renderValue('error', ping.error.message)
    } else if (typeof ping.playerCount !== 'number') {
      this._hideValue('player-count')
      this._renderValue('error', 'Failed to ping')
    } else if (typeof ping.playerCount === 'number') {
      this._hideValue('error')
      this._renderValue('player-count', formatNumber(ping.playerCount))
    }

    this._updateFavicon(ping.favicon)
  }

  // Favicons may be URLs. Rewriting an unchanged src makes the browser request it again.
  _updateFavicon (src) {
    if (!src) return

    const faviconElement = document.getElementById(`favicon_${this.serverId}`)
    if (faviconElement && faviconElement.getAttribute('src') !== src) {
      faviconElement.setAttribute('src', src)
    }
  }

  updateHighlightedValue (selectedCategory) {
    ['player-count', 'peak', 'record'].forEach((category) => {
      const labelElement = document.getElementById(`${category}_${this.serverId}`)
      const valueElement = document.getElementById(`${category}-value_${this.serverId}`)
      if (!labelElement || !valueElement) return

      if (selectedCategory && category === selectedCategory) {
        labelElement.setAttribute('class', 'server-highlighted-label')
        valueElement.setAttribute('class', 'server-highlighted-value')
      } else {
        labelElement.setAttribute('class', 'server-label')
        valueElement.setAttribute('class', 'server-value')
      }
    })
  }

  updateSeriesVisibility () {
    const row = document.getElementById(`container_${this.serverId}`)
    if (!row) return
    row.classList.toggle('is-series-off', !this.isVisible)

    // The row acts as a toggle for showing only the selected servers on the graph
    if (!isLegacyDesign()) {
      const selected = this._app.graphDisplayManager.isServerSelected(this)
      row.setAttribute('aria-pressed', selected ? 'true' : 'false')
    }
  }

  initServerStatus (latestPing) {
    if (isLegacyDesign()) {
      this.initLegacyServerStatus(latestPing)
      return
    }

    const serverElement = document.createElement('div')
    const address = escapeHtml(formatMinecraftServerAddress(this.data.ip, this.data.port))

    serverElement.id = `container_${this.serverId}`
    serverElement.className = 'server'
    serverElement.tabIndex = 0
    serverElement.setAttribute('role', 'button')
    serverElement.setAttribute('aria-pressed', 'false')
    // A short name, rather than every piece of text in the row read out in one go
    serverElement.setAttribute('aria-label', `Show ${this.data.name} on the graph`)
    serverElement.title = 'Click to show only this server on the graph'
    serverElement.style.setProperty('--server-color', safeCssColor(this.data.color))
    serverElement.innerHTML = `<span class="num server-rank" id="ranking_${this.serverId}"></span>
      <span class="server-avatar">
        <img class="server-favicon" src="${latestPing.favicon || MISSING_FAVICON}" id="favicon_${this.serverId}" alt="">
        <span class="status-dot"></span>
      </span>
      <div class="server-identity">
        <div class="server-title">
          <span class="server-name">${escapeHtml(this.data.name)}</span>
        </div>
        <button type="button" class="server-ip mono" id="copy-address_${this.serverId}" title="Copy address" aria-label="Copy address ${address}" aria-live="polite">${address}</button>
      </div>
      <div class="server-players">
        <div class="player-line">
          <span class="num player-count" id="player-count_${this.serverId}"><span id="player-count-value_${this.serverId}"></span></span>
          <span class="offline-pill" id="offline_${this.serverId}" hidden>offline</span>
        </div>
        <span class="num trend" id="trend_${this.serverId}"></span>
      </div>
      <div class="server-spark" id="chart_${this.serverId}"></div>
      <div class="server-record" id="record_${this.serverId}">
        <span class="num record-value" id="record-value_${this.serverId}">-</span>
      </div>
      <button type="button" class="${this._app.favoritesManager.getIconClass(this.isFavorite)}" id="favorite-toggle_${this.serverId}" aria-pressed="false" aria-label="Favourite ${escapeHtml(this.data.name)}" title="Favourite">${FAVORITE_ICON}</button>`

    document.getElementById('server-list').appendChild(serverElement)
  }

  initLegacyServerStatus (latestPing) {
    const serverElement = document.createElement('div')

    serverElement.id = `container_${this.serverId}`
    serverElement.innerHTML = `<div class="column column-favicon">
        <img class="server-favicon" src="${latestPing.favicon || MISSING_FAVICON}" id="favicon_${this.serverId}" title="${escapeHtml(this.data.name)}\n${escapeHtml(formatMinecraftServerAddress(this.data.ip, this.data.port))}">
        <span class="server-rank" id="ranking_${this.serverId}"></span>
      </div>
      <div class="column column-status">
        <h3 class="server-name"><span class="${this._app.favoritesManager.getIconClass(this.isFavorite)}" id="favorite-toggle_${this.serverId}"></span> ${escapeHtml(this.data.name)}</h3>
        <span class="server-error" id="error_${this.serverId}"></span>
        <span class="server-label" id="player-count_${this.serverId}">Players: <span class="server-value" id="player-count-value_${this.serverId}"></span></span>
        <span class="server-label" id="peak_${this.serverId}">${escapeHtml(this._app.publicConfig.graphDurationLabel)} Peak: <span class="server-value" id="peak-value_${this.serverId}">-</span></span>
        <span class="server-label" id="record_${this.serverId}">Record: <span class="server-value" id="record-value_${this.serverId}">-</span></span>
        <span class="server-label" id="version_${this.serverId}"></span>
      </div>
      <div class="column column-graph" id="chart_${this.serverId}"></div>`

    serverElement.setAttribute('class', 'server')
    document.getElementById('server-list').appendChild(serverElement)
  }

  copyAddress (element) {
    const address = formatMinecraftServerAddress(this.data.ip, this.data.port)

    const done = (copied) => {
      element.classList.toggle('is-copied', copied)
      element.classList.toggle('is-copy-failed', !copied)
      element.innerText = copied ? 'Copied!' : 'Copy failed'
      clearTimeout(this._copyTimer)
      this._copyTimer = setTimeout(() => {
        element.classList.remove('is-copied', 'is-copy-failed')
        element.innerText = address
      }, 1500)
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address).then(() => done(true), () => done(false))
    } else {
      done(false)
    }
  }

  initEventListeners () {
    const row = document.getElementById(`container_${this.serverId}`)
    const favorite = document.getElementById(`favorite-toggle_${this.serverId}`)

    favorite.addEventListener('click', (event) => {
      event.stopPropagation()
      this._app.favoritesManager.handleFavoriteButtonClick(this)
    }, false)

    if (isLegacyDesign()) return

    let isMouseOver = false

    const toggle = () => {
      this._app.graphDisplayManager.toggleServer(this)

      // Toggling can hide or show the hovered server, so its focus needs recomputing
      if (isMouseOver) this._app.graphDisplayManager.focusServer(this)
    }

    row.addEventListener('click', toggle, false)

    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    }, false)

    const copy = document.getElementById(`copy-address_${this.serverId}`)
    if (copy) {
      copy.addEventListener('click', (event) => {
        event.stopPropagation()
        this.copyAddress(copy)
      }, false)
    }

    // Touch has no hover out, so a tap would leave the other lines dimmed
    row.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return
      isMouseOver = true
      this._app.graphDisplayManager.focusServer(this)
    }, false)

    row.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return
      isMouseOver = false
      this._app.graphDisplayManager.focusServer(null)
    }, false)
  }
}
