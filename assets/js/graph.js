import uPlot from 'uplot'

import { RelativeScale } from './scale'

import { formatNumber, formatTimestampSeconds, formatDay, formatTime, formatDayTime, escapeHtml, safeCssColor } from './util'
import { uPlotTooltipPlugin, uPlotRangeSelectPlugin, uPlotDayBoundariesPlugin } from './plugins'
import { parseSharedView, writeSharedViewToUrl, formatRange } from './share'

import { FAVORITE_SERVERS_STORAGE_KEY, compareFavoriteFirst } from './favorites'
import { isLegacyDesign } from './design'

const HIDDEN_SERVERS_STORAGE_KEY = 'minetrack_hidden_servers'
const SHOW_FAVORITES_STORAGE_KEY = 'minetrack_show_favorites'
const SHOW_HISTORY_STORAGE_KEY = 'minetrack_show_history'

const LAST_WEEK_REFRESH_MARGIN_SECONDS = 120
const LAST_WEEK_RETRY_DELAY = 30 * 1000

const HOUR = 60 * 60
const DAY = 24 * HOUR
const RANGE_PRESETS = [HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, 14 * DAY]
const DEFAULT_RANGE = 3 * DAY
const UNFOCUSED_ALPHA = 0.15
const LINE_WIDTH = 1.5
const FOCUSED_LINE_WIDTH = 2.5
const HISTORY_LINE_WIDTH = 1

export class GraphDisplayManager {
  constructor (app) {
    this._app = app
    this._graphData = []
    this._graphTimestamps = []
    this._hasLoadedSettings = false
    this._initEventListenersOnce = false
    this._showOnlyFavorites = false
    this._showHistory = true
    this._soloIds = new Set()
    this._lastWeekData = undefined
    this._lastWeekSeries = []
    this._lastWeekRequestedAt = undefined
    this._rangeSeconds = 0
    this._lockRange = false
    this._focusedId = null
    this._pendingFocusId = null
    this._focusFrame = undefined
    this._sharedView = undefined
    this._rangeMenuOpen = false
  }

  addGraphPoint (timestamp, playerCounts) {
    if (!this._hasLoadedSettings) {
      // _hasLoadedSettings is controlled by #setGraphData
      // It will only be true once the context has been loaded and initial payload received
      // #addGraphPoint should not be called prior to that since it means the data is racing
      // and the application has received updates prior to the initial state
      return
    }

    this._graphTimestamps.push(timestamp)

    for (let i = 0; i < playerCounts.length; i++) {
      this._graphData[i].push(playerCounts[i])
    }

    // Trim all data arrays to only the relevant portion
    // This keeps it in sync with backend data structures
    const graphMaxLength = this._app.publicConfig.graphMaxLength

    if (this._graphTimestamps.length > graphMaxLength) {
      this._graphTimestamps.splice(0, this._graphTimestamps.length - graphMaxLength)
    }

    for (const series of this._graphData) {
      if (series.length > graphMaxLength) {
        series.splice(0, series.length - graphMaxLength)
      }
    }

    if (this._showHistory) {
      this.refreshLastWeekGraphIfNeeded(timestamp)
    }

    this.updatePlotData()
  }

  // A preset window slides forward with new data, while a manual zoom stays where the user put it
  updatePlotData () {
    this._plotInstance.setData(this.getGraphData(), false)

    if (this._rangeSeconds) {
      this.applyRange()
    }
  }

  loadLocalStorage () {
    if (typeof localStorage !== 'undefined') {
      const showOnlyFavorites = localStorage.getItem(SHOW_FAVORITES_STORAGE_KEY)
      if (showOnlyFavorites) {
        this._showOnlyFavorites = true
      }

      this._showHistory = localStorage.getItem(SHOW_HISTORY_STORAGE_KEY) !== 'false'

      // If only favorites mode is active, use the stored favorite servers data instead
      let serverNames
      if (this._showOnlyFavorites) {
        serverNames = localStorage.getItem(FAVORITE_SERVERS_STORAGE_KEY)
      } else {
        serverNames = localStorage.getItem(HIDDEN_SERVERS_STORAGE_KEY)
      }

      if (serverNames) {
        serverNames = JSON.parse(serverNames)

        // Iterate over all active serverRegistrations
        // This merges saved state with current state to prevent desyncs
        for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
          // isVisible will be true if showOnlyFavorites && contained in FAVORITE_SERVERS_STORAGE_KEY
          // OR, if it is NOT contains within HIDDEN_SERVERS_STORAGE_KEY
          // Checks between FAVORITE/HIDDEN keys are mutually exclusive
          if (this._showOnlyFavorites) {
            serverRegistration.isVisible = serverNames.indexOf(serverRegistration.data.name) >= 0
          } else {
            serverRegistration.isVisible = serverNames.indexOf(serverRegistration.data.name) < 0
          }
        }
      }

      // A partial hidden set is a solo: those servers stay selected until the last one is cleared
      this._soloIds = new Set()

      if (!this._showOnlyFavorites) {
        const servers = this._app.serverRegistry.getServerRegistrations()
        const visibleIds = servers.filter(serverRegistration => serverRegistration.isVisible).map(serverRegistration => serverRegistration.serverId)

        if (visibleIds.length > 0 && visibleIds.length < servers.length) {
          this._soloIds = new Set(visibleIds)
        }
      }
    }

    this.loadSharedView()
  }

  // The address bar holds the whole view, so a missing param means its default rather than the saved setting.
  // Saved settings are left alone until the visitor changes something.
  loadSharedView () {
    this._sharedView = parseSharedView(location.search)

    if (!this._sharedView) return

    this._showHistory = this._sharedView.history !== false
    this._showOnlyFavorites = false

    const sharedNames = new Set(this._sharedView.servers || [])
    const servers = this._app.serverRegistry.getServerRegistrations()
    const sharedIds = new Set(servers
      .filter(serverRegistration => sharedNames.has(serverRegistration.data.name))
      .map(serverRegistration => serverRegistration.serverId))

    // Names that no longer exist are ignored, and with none left every server is shown
    const soloing = sharedIds.size > 0 && sharedIds.size < servers.length
    this._soloIds = soloing ? sharedIds : new Set()

    for (const serverRegistration of servers) {
      serverRegistration.isVisible = !soloing || sharedIds.has(serverRegistration.serverId)
    }
  }

  applyInitialRange () {
    const view = this._sharedView || {}
    const first = this._graphTimestamps[0]
    const last = this._graphTimestamps[this._graphTimestamps.length - 1]

    if (view.range) {
      this.setRange(Math.min(view.range, this.getFullRange()))
    } else if (view.from && view.to && view.to > first && view.from < last) {
      this.withRangeLock(() => {
        this._plotInstance.setScale('x', {
          min: Math.max(view.from, first),
          max: Math.min(view.to, last)
        })
      })
      this._rangeSeconds = this.isZoomed() ? 0 : this.getDefaultRange()
      this.updateRangeControls()
    } else {
      // Keeps the chosen preset across a reconnect, where a manual zoom falls back to the default.
      // Old links can also point at a window that has already scrolled out of the graph.
      this.setRange(this._rangeSeconds || this.getDefaultRange())
    }
  }

  endSharedView () {
    this._sharedView = undefined
  }

  updateUrl () {
    if (this._plotInstance) writeSharedViewToUrl(this.getShareView())
  }

  updateLocalStorage () {
    this.updateUrl()

    if (this._sharedView) return

    if (typeof localStorage !== 'undefined') {
      // Mutate the serverIds array into server names for storage use
      const serverNames = this._app.serverRegistry.getServerRegistrations()
        .filter(serverRegistration => !serverRegistration.isVisible)
        .map(serverRegistration => serverRegistration.data.name)

      // Only store if the array contains data, otherwise clear the item
      // If showOnlyFavorites is true, do NOT store serverNames since the state will be auto managed instead
      if (serverNames.length > 0 && !this._showOnlyFavorites) {
        localStorage.setItem(HIDDEN_SERVERS_STORAGE_KEY, JSON.stringify(serverNames))
      } else {
        localStorage.removeItem(HIDDEN_SERVERS_STORAGE_KEY)
      }

      // Only store SHOW_FAVORITES_STORAGE_KEY if true
      if (this._showOnlyFavorites) {
        localStorage.setItem(SHOW_FAVORITES_STORAGE_KEY, true)
      } else {
        localStorage.removeItem(SHOW_FAVORITES_STORAGE_KEY)
      }

      // History is shown by default, so only store the opt-out
      if (!this._showHistory) {
        localStorage.setItem(SHOW_HISTORY_STORAGE_KEY, false)
      } else {
        localStorage.removeItem(SHOW_HISTORY_STORAGE_KEY)
      }
    }
  }

  // Limited to the visible time window, so a short range is not flattened by a peak outside it
  getVisibleGraphData (startIndex, endIndex) {
    const visibleGraphData = []

    for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
      if (serverRegistration.isVisible) {
        visibleGraphData.push(this._graphData[serverRegistration.serverId].slice(startIndex, endIndex + 1))

        if (this._showHistory) {
          visibleGraphData.push(this._lastWeekSeries[serverRegistration.serverId].slice(startIndex, endIndex + 1))
        }
      }
    }

    return visibleGraphData
  }

  getPlotSize () {
    if (isLegacyDesign()) {
      return {
        width: Math.max(window.innerWidth, 800) * 0.9,
        height: 400
      }
    }

    const scroller = document.querySelector('.graph-scroll')
    const available = scroller ? scroller.clientWidth : 0
    const narrow = window.innerWidth < 768
    const fallback = Math.min(1048, window.innerWidth - 32)
    const width = narrow ? Math.max(available || 0, 720) : (available || fallback)

    return {
      width: Math.max(width, 320),
      height: narrow ? 220 : 300
    }
  }

  getGraphData () {
    this._lastWeekSeries = this.buildLastWeekSeries()

    return [
      this._graphTimestamps,
      ...this._graphData,
      ...this._lastWeekSeries
    ]
  }

  // Maps the last week buckets (already shifted forward a week by the backend)
  // onto the current graph timestamps, since uPlot requires every series to share the X axis
  buildLastWeekSeries () {
    if (!this._showHistory || !this._lastWeekData) {
      return this._graphData.map(() => Array(this._graphTimestamps.length).fill(null))
    }

    const { bucketStart, bucketSize, graphData } = this._lastWeekData

    return graphData.map(buckets => {
      const series = Array(this._graphTimestamps.length).fill(null)

      for (let i = 0; i < this._graphTimestamps.length; i++) {
        const bucket = Math.floor((this._graphTimestamps[i] - bucketStart) / bucketSize)

        if (bucket >= 0 && bucket < buckets.length) {
          series[i] = buckets[bucket]
        }
      }

      return series
    })
  }

  getLastWeekSeriesIndex (serverId) {
    return this._graphData.length + 1 + serverId
  }

  getGraphDataPoint (serverId, index) {
    const graphData = this._graphData[serverId]
    if (graphData && index < graphData.length && typeof graphData[index] === 'number') {
      return graphData[index]
    }
  }

  getClosestPlotSeriesIndex (idx) {
    let closestSeriesIndex = -1
    let closestSeriesDist = Number.MAX_VALUE

    const plotHeight = this._plotInstance.bbox.height / devicePixelRatio

    for (let i = 1; i < this._plotInstance.series.length; i++) {
      const series = this._plotInstance.series[i]

      if (!series.show) {
        continue
      }

      const point = this._plotInstance.data[i][idx]

      if (typeof point === 'number') {
        const scale = this._plotInstance.scales[series.scale]
        const posY = (1 - ((point - scale.min) / (scale.max - scale.min))) * plotHeight

        const dist = Math.abs(posY - this._plotInstance.cursor.top)

        if (dist < closestSeriesDist) {
          closestSeriesIndex = i
          closestSeriesDist = dist
        }
      }
    }

    return closestSeriesIndex
  }

  // Sits on the sample the tooltip is reading, so the highlighted row has a point on the graph
  showCursorDot (seriesIndex, idx) {
    const over = this._plotInstance.root.querySelector('.over')
    if (!this._cursorDot || this._cursorDot.parentNode !== over) {
      this._cursorDot = document.createElement('div')
      this._cursorDot.className = 'graph-cursor-dot'
      over.appendChild(this._cursorDot)
    }

    const value = seriesIndex > 0 ? this._plotInstance.data[seriesIndex][idx] : null
    if (typeof value !== 'number') {
      this.hideCursorDot()
      return
    }

    const x = this._plotInstance.valToPos(this._plotInstance.data[0][idx], 'x')
    const y = this._plotInstance.valToPos(value, 'y')
    this._cursorDot.style.display = 'block'
    this._cursorDot.style.transform = `translate(${x}px, ${y}px)`
    this._cursorDot.style.background = this._plotInstance.series[seriesIndex].stroke
  }

  hideCursorDot () {
    if (this._cursorDot) this._cursorDot.style.display = 'none'
  }

  buildPlotInstance (timestamps, data) {
    // Lazy load settings from localStorage, if any and if enabled
    if (!this._hasLoadedSettings) {
      this._hasLoadedSettings = true

      this.loadLocalStorage()
    }

    for (const playerCounts of data) {
      // Each playerCounts value corresponds to a ServerRegistration
      // Require each array is the length of timestamps, if not, pad at the start with null values to fit to length
      // This ensures newer ServerRegistrations do not left align due to a lower length
      const lengthDiff = timestamps.length - playerCounts.length

      if (lengthDiff > 0) {
        const padding = Array(lengthDiff).fill(null)

        playerCounts.unshift(...padding)
      }
    }

    this._graphTimestamps = timestamps
    this._graphData = data

    const legacy = isLegacyDesign()

    const series = this._app.serverRegistry.getServerRegistrations().map(serverRegistration => {
      return {
        stroke: safeCssColor(serverRegistration.data.color),
        width: legacy ? 2 : LINE_WIDTH,
        value: (_, raw) => `${formatNumber(raw)} Players`,
        show: serverRegistration.isVisible,
        spanGaps: true,
        points: {
          show: false
        }
      }
    })

    // Each server has a dashed history series, ordered after all live series (see #getLastWeekSeriesIndex)
    for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
      series.push({
        stroke: safeCssColor(serverRegistration.data.color),
        width: legacy ? 1.5 : HISTORY_LINE_WIDTH,
        dash: legacy ? [6, 5] : [4, 4],
        show: serverRegistration.isVisible && this._showHistory,
        spanGaps: true,
        points: {
          show: false
        }
      })
    }

    const tickCount = 10
    const maxFactor = 4

    // The axis splits are drawn right after the range is computed, so they reuse its step
    let yStep = 1
    const rangeYAxis = (u) => {
      const [startIndex, endIndex] = u.series[0].idxs
      const { scaledMin, scaledMax, scale } = RelativeScale.scaleMatrix(this.getVisibleGraphData(startIndex, endIndex), tickCount, maxFactor)
      yStep = scale
      return [scaledMin, scaledMax]
    }
    const splitYAxis = (u, min, max) => RelativeScale.generateTicks(min, max, yStep)

    // The initial scale is not a user zoom, so keep handleScaleChange from clearing a preset
    this._lockRange = true

    // eslint-disable-next-line new-cap
    this._plotInstance = new uPlot({
      plugins: [
        uPlotTooltipPlugin((pos, idx) => {
          if (pos) {
            const closestSeriesIndex = this.getClosestPlotSeriesIndex(idx)

            const text = legacy
              ? this.formatLegacyTooltip(idx, closestSeriesIndex)
              : this.formatTooltip(idx, closestSeriesIndex)

            this._app.tooltip.set(pos.left, pos.top, legacy ? 10 : 12, legacy ? 10 : 12, text)
            this.showCursorDot(closestSeriesIndex, idx)
          } else {
            this._app.tooltip.hide()
            this.hideCursorDot()
          }
        }),
        ...(legacy
          ? []
          : [
              uPlotRangeSelectPlugin(formatDayTime),
              uPlotDayBoundariesPlugin({
                lineColor: '#34343a',
                labelColor: '#62666d',
                fontFamily: '"JetBrains Mono", ui-monospace, monospace'
              })
            ])
      ],
      hooks: {
        setScale: [this.handleScaleChange]
      },
      ...this.getPlotSize(),
      cursor: legacy
        ? { y: false }
        : {
            drag: {
              y: false
            },
            points: {
              show: false
            }
          },
      series: [
        {
        },
        ...series
      ],
      axes: legacy
        ? [
            {
              font: '14px "Open Sans", sans-serif',
              stroke: '#FFF',
              grid: {
                show: false
              },
              space: 60
            },
            {
              font: '14px "Open Sans", sans-serif',
              stroke: '#FFF',
              size: 65,
              grid: {
                stroke: '#333',
                width: 1
              },
              split: splitYAxis
            }
          ]
        : [
            {
              font: '11px "JetBrains Mono", ui-monospace, monospace',
              stroke: '#62666d',
              grid: {
                show: false
              },
              ticks: {
                stroke: '#23252a',
                width: 1,
                size: 4
              },
              space: 72
            },
            {
              font: '11px "JetBrains Mono", ui-monospace, monospace',
              stroke: '#62666d',
              size: 56,
              ticks: {
                stroke: '#23252a',
                width: 1,
                size: 4
              },
              values: (_self, ticks) => ticks.map(raw => formatNumber(raw)),
              grid: {
                stroke: '#23252a',
                width: 1
              },
              split: splitYAxis
            }
          ],
      scales: {
        y: {
          auto: false,
          range: rangeYAxis
        }
      },
      legend: {
        show: false
      }
    }, this.getGraphData(), document.getElementById('big-graph'))

    this._lockRange = false

    if (legacy) {
      const settingsToggle = document.getElementById('settings-toggle')
      if (settingsToggle) settingsToggle.style.display = 'inline-block'
    } else {
      document.getElementById('big-graph-controls').style.display = 'flex'
      const listControls = document.getElementById('server-list-controls')
      if (listControls) listControls.hidden = false

      for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
        serverRegistration.updateSeriesVisibility()
      }

      this.updateControls()
    }

    this.updateHistoryButton()
    this.renderRangeControls()
    this.applyInitialRange()

    if (this._showHistory) {
      this.refreshLastWeekGraphIfNeeded(this._graphTimestamps[this._graphTimestamps.length - 1])
    }
  }

  getFullRange () {
    const configured = this._app.publicConfig.graphDuration
    if (configured > 0) return configured

    // A backend from before this field existed only has the timestamps it sent
    const span = this._graphTimestamps[this._graphTimestamps.length - 1] - this._graphTimestamps[0]
    return span > 0 ? span : DEFAULT_RANGE
  }

  // Never longer than the data the graph actually holds
  getDefaultRange () {
    return Math.min(DEFAULT_RANGE, this.getFullRange())
  }

  // Presets come from the configured graph length, and one longer than the data collected so far just shows all of it
  renderRangeControls () {
    const container = document.getElementById('graph-range')
    if (!container) return

    const list = document.getElementById('graph-range-list')
    const fullRange = this.getFullRange()
    const presets = RANGE_PRESETS.filter(seconds => seconds < fullRange).concat(fullRange)
    const check = '<svg class="range-menu-check" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 5.2 L4.1 7.3 L8 2.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square" stroke-linejoin="miter"/></svg>'

    list.innerHTML = presets.map(seconds =>
      `<button type="button" class="range-menu-option" role="option" data-range="${seconds}" aria-selected="false">${escapeHtml(formatRange(seconds))}${check}</button>`
    ).join('')

    // A single choice would have nothing to open
    container.hidden = presets.length < 2
  }

  // A range of 0 means the user dragged a custom zoom
  updateRangeControls () {
    const isCustomZoom = !this._rangeSeconds

    const container = document.getElementById('graph-range')
    const label = document.getElementById('graph-range-label')
    if (container && label) {
      container.querySelectorAll('.range-menu-option').forEach(button => {
        const isActive = !isCustomZoom && parseInt(button.getAttribute('data-range')) === this._rangeSeconds
        button.classList.toggle('is-active', isActive)
        button.setAttribute('aria-selected', isActive ? 'true' : 'false')
      })

      if (isCustomZoom) {
        const { min, max } = this._plotInstance.scales.x
        const sameDay = new Date(min * 1000).toDateString() === new Date(max * 1000).toDateString()
        label.textContent = sameDay
          ? `${formatTime(min)} – ${formatTime(max)}`
          : `${formatDay(min)} – ${formatDay(max)}`
        container.querySelector('.range-menu-toggle').title = `${formatDayTime(min)} – ${formatDayTime(max)}`
      } else {
        label.textContent = formatRange(this._rangeSeconds)
        container.querySelector('.range-menu-toggle').removeAttribute('title')
      }
    }

    const resetZoom = document.getElementById('graph-reset-zoom')
    if (resetZoom) resetZoom.hidden = !isCustomZoom

    this.updateUrl()
  }

  withRangeLock (fn) {
    const wasLocked = this._lockRange
    this._lockRange = true
    try {
      fn()
    } finally {
      this._lockRange = wasLocked
    }
  }

  setRange (seconds) {
    this._rangeSeconds = seconds
    this.applyRange()
    this.updateRangeControls()
  }

  applyRange () {
    const first = this._graphTimestamps[0]
    const last = this._graphTimestamps[this._graphTimestamps.length - 1]
    const min = Math.max(first, last - this._rangeSeconds)

    this.withRangeLock(() => {
      this._plotInstance.setScale('x', { min, max: last })
    })
  }

  // Scale changes that did not come from a preset are drag zooms or double click resets
  handleScaleChange = (u, key) => {
    if (key !== 'x' || this._lockRange) return

    if (this.isZoomed()) {
      this._rangeSeconds = 0
      this.updateRangeControls()
    } else {
      // A double click resets to every stored point, so put the default window back
      this.setRange(this.getDefaultRange())
    }
  }

  handleRangeClick = (event) => {
    const option = event.target.closest('[data-range]')
    if (option) {
      this.setRange(parseInt(option.getAttribute('data-range')))
      this.setRangeMenuOpen(false)
      return
    }

    if (event.target.closest('.range-menu-toggle')) {
      this.setRangeMenuOpen(!this._rangeMenuOpen)
    }
  }

  setRangeMenuOpen (open) {
    const menu = document.getElementById('graph-range')
    const list = document.getElementById('graph-range-list')
    const toggle = document.getElementById('graph-range-toggle')
    if (!menu || !list || !toggle) return

    this._rangeMenuOpen = open
    menu.classList.toggle('is-open', open)
    list.hidden = !open
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  handleRangeMenuDismiss = (event) => {
    if (!this._rangeMenuOpen) return

    if (event.type === 'keydown') {
      if (event.key === 'Escape') this.setRangeMenuOpen(false)
      return
    }

    const menu = document.getElementById('graph-range')
    if (menu && !menu.contains(event.target)) this.setRangeMenuOpen(false)
  }

  handleResetZoomClick = () => {
    this.setRange(this.getDefaultRange())
  }

  // Dims every other server so the hovered row's live and history lines stand out
  focusServer (serverRegistration) {
    if (!this._plotInstance) return

    this._pendingFocusId = serverRegistration && serverRegistration.isVisible ? serverRegistration.serverId : null

    // Moving between rows fires a leave then an enter, which should cost one repaint rather than two
    if (this._focusFrame === undefined) {
      this._focusFrame = requestAnimationFrame(this.applyFocus)
    }
  }

  applyFocus = () => {
    this._focusFrame = undefined

    const focusedId = this._pendingFocusId
    if (!this._plotInstance || focusedId === this._focusedId) return

    this._focusedId = focusedId

    for (const server of this._app.serverRegistry.getServerRegistrations()) {
      const isFocused = server.serverId === focusedId
      const alpha = focusedId === null || isFocused ? 1 : UNFOCUSED_ALPHA

      const live = this._plotInstance.series[server.getGraphDataIndex()]
      live.alpha = alpha
      live.width = isFocused ? FOCUSED_LINE_WIDTH : LINE_WIDTH

      this._plotInstance.series[this.getLastWeekSeriesIndex(server.serverId)].alpha = alpha
    }

    this._plotInstance.redraw(false)
  }

  getShareView () {
    const servers = this._app.serverRegistry.getServerRegistrations()
    const visible = servers.filter(serverRegistration => serverRegistration.isVisible)
    const view = {}

    if (visible.length > 0 && visible.length < servers.length) {
      view.servers = visible.map(serverRegistration => serverRegistration.data.name)
    }

    // The default window stays out of the address bar
    if (!this._rangeSeconds) {
      view.from = Math.floor(this._plotInstance.scales.x.min)
      view.to = Math.ceil(this._plotInstance.scales.x.max)
    } else if (this._rangeSeconds !== this.getDefaultRange()) {
      view.range = this._rangeSeconds
    }

    if (!this._showHistory) {
      view.history = false
    }

    return view
  }

  getTooltipServers () {
    return this._app.serverRegistry.getServerRegistrations()
      .filter(serverRegistration => serverRegistration.isVisible)
      .sort((a, b) => compareFavoriteFirst(a, b) || a.data.name.localeCompare(b.data.name))
  }

  formatTooltip (idx, closestSeriesIndex) {
    const rows = this.getTooltipServers()
      .map(serverRegistration => {
        const point = this.getGraphDataPoint(serverRegistration.serverId, idx)
        const lastWeekSeriesIndex = this.getLastWeekSeriesIndex(serverRegistration.serverId)
        const isActive = closestSeriesIndex === serverRegistration.getGraphDataIndex() || closestSeriesIndex === lastWeekSeriesIndex

        let previous = ''
        if (this._showHistory) {
          const lastWeekPoint = this._lastWeekSeries[serverRegistration.serverId][idx]
          if (typeof lastWeekPoint === 'number') {
            previous = `<span class="tip-prev">${formatNumber(lastWeekPoint)}</span>`
          }
        }

        return `<div class="tip-row${isActive ? ' is-active' : ''}"><span class="tip-dot" style="background:${safeCssColor(serverRegistration.data.color)}"></span><span class="tip-name">${escapeHtml(serverRegistration.data.name)}</span><span class="tip-count">${formatNumber(point)}${previous}</span></div>`
      }).join('')

    return `<div class="tip-time">${escapeHtml(formatDayTime(this._graphTimestamps[idx]))}</div>${rows}`
  }

  formatLegacyTooltip (idx, closestSeriesIndex) {
    return this.getTooltipServers()
      .map(serverRegistration => {
        const point = this.getGraphDataPoint(serverRegistration.serverId, idx)
        const lastWeekSeriesIndex = this.getLastWeekSeriesIndex(serverRegistration.serverId)

        let serverName = escapeHtml(serverRegistration.data.name)
        if (closestSeriesIndex === serverRegistration.getGraphDataIndex() || closestSeriesIndex === lastWeekSeriesIndex) {
          serverName = `<strong>${serverName}</strong>`
        }
        if (serverRegistration.isFavorite) {
          serverName = `<span class="${this._app.favoritesManager.getIconClass(true)}"></span> ${serverName}`
        }

        let text = `${serverName}: ${formatNumber(point)}`

        if (this._showHistory) {
          const lastWeekPoint = this._lastWeekSeries[serverRegistration.serverId][idx]
          if (typeof lastWeekPoint === 'number') {
            text += ` (${formatNumber(lastWeekPoint)} last week)`
          }
        }

        return text
      }).join('<br>') + `<br><br><strong>${escapeHtml(formatTimestampSeconds(this._graphTimestamps[idx]))}</strong>`
  }

  refreshLastWeekGraphIfNeeded (timestamp) {
    if (!this._lastWeekData || timestamp + LAST_WEEK_REFRESH_MARGIN_SECONDS >= this._lastWeekData.coversUntil) {
      this.requestLastWeekGraph()
    }
  }

  requestLastWeekGraph () {
    // A failed query sends no reply, so retry a request that has gone unanswered
    const now = Date.now()

    if (!this._lastWeekRequestedAt || now - this._lastWeekRequestedAt >= LAST_WEEK_RETRY_DELAY) {
      this._lastWeekRequestedAt = now
      this._app.socketManager.sendLastWeekGraphRequest()
    }
  }

  handleLastWeekGraph (payload) {
    this._lastWeekRequestedAt = undefined
    this._lastWeekData = payload

    this.updatePlotData()
  }

  isZoomed () {
    const plotScaleX = this._plotInstance.scales.x
    return plotScaleX.min > this._graphTimestamps[0] || plotScaleX.max < this._graphTimestamps[this._graphTimestamps.length - 1]
  }

  handleHistoryButtonClick = () => {
    this.endSharedView()
    this._showHistory = !this._showHistory

    this.updateHistoryButton()

    if (this._showHistory) {
      this.refreshLastWeekGraphIfNeeded(this._graphTimestamps[this._graphTimestamps.length - 1])
    }

    this.updateLocalStorage()
    this.syncSeriesVisibility()

    // Setting the x scale again re-ranges the Y axis to include or drop the history lines
    const xScale = { min: this._plotInstance.scales.x.min, max: this._plotInstance.scales.x.max }

    this.withRangeLock(() => {
      this._plotInstance.setData(this.getGraphData(), false)

      if (this._rangeSeconds) {
        this.applyRange()
      } else {
        this._plotInstance.setScale('x', xScale)
      }
    })
  }

  updateHistoryButton () {
    const button = document.getElementById('graph-controls-history')
    if (!button) return

    button.classList.toggle('graph-controls-history-off', !this._showHistory)
    button.classList.toggle('is-active', this._showHistory)
    button.setAttribute('aria-pressed', this._showHistory ? 'true' : 'false')
  }

  syncSeriesVisibility () {
    for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
      this._plotInstance.series[serverRegistration.getGraphDataIndex()].show = serverRegistration.isVisible
      this._plotInstance.series[this.getLastWeekSeriesIndex(serverRegistration.serverId)].show = serverRegistration.isVisible && this._showHistory
      serverRegistration.updateSeriesVisibility()
    }
  }

  redraw = () => {
    // Use drawing as a hint to update settings
    // This may cause unnessecary localStorage updates, but its a rare and harmless outcome
    this.updateLocalStorage()
    this.syncSeriesVisibility()
    this._plotInstance.redraw()
  }

  requestResize () {
    // Only resize when _plotInstance is defined
    // Set a timeout to resize after resize events have not been fired for some duration of time
    // This prevents burning CPU time for multiple, rapid resize events
    if (this._plotInstance) {
      if (this._resizeRequestTimeout) {
        clearTimeout(this._resizeRequestTimeout)
      }

      // Schedule new delayed resize call
      // This can be cancelled by #requestResize, #resize and #reset
      this._resizeRequestTimeout = setTimeout(this.resize, 200)
    }
  }

  resize = () => {
    this._plotInstance.setSize(this.getPlotSize())

    // undefine value so #clearTimeout is not called
    // This is safe even if #resize is manually called since it removes the pending work
    if (this._resizeRequestTimeout) {
      clearTimeout(this._resizeRequestTimeout)
    }

    this._resizeRequestTimeout = undefined
  }

  initEventListeners () {
    if (!this._initEventListenersOnce) {
      this._initEventListenersOnce = true

      // These listeners should only be init once since they attach to persistent elements
      const settingsToggle = document.getElementById('settings-toggle')
      if (settingsToggle) {
        settingsToggle.addEventListener('click', this.handleSettingsToggle, false)
      }

      document.querySelectorAll('.graph-controls-show').forEach((element) => {
        element.addEventListener('click', this.handleShowButtonClick, false)
      })

      document.getElementById('graph-controls-history').addEventListener('click', this.handleHistoryButtonClick, false)

      const listeners = {
        'graph-range': this.handleRangeClick,
        'graph-reset-zoom': this.handleResetZoomClick
      }

      for (const id in listeners) {
        const element = document.getElementById(id)
        if (element) element.addEventListener('click', listeners[id], false)
      }

      document.addEventListener('click', this.handleRangeMenuDismiss, false)
      document.addEventListener('keydown', this.handleRangeMenuDismiss, false)
    }

    if (isLegacyDesign()) {
      document.querySelectorAll('.graph-control').forEach((element) => {
        element.addEventListener('click', this.handleServerButtonClick, false)
      })
    }
  }

  handleSettingsToggle = () => {
    const element = document.getElementById('big-graph-controls-drawer')
    if (!element) return

    if (element.style.display !== 'block') {
      element.style.display = 'block'
    } else {
      element.style.display = 'none'
    }
  }

  handleServerButtonClick = (event) => {
    const serverId = parseInt(event.target.getAttribute('minetrack-server-id'))
    const serverRegistration = this._app.serverRegistry.getServerRegistration(serverId)

    if (serverRegistration.isVisible !== event.target.checked) {
      this.endSharedView()
      serverRegistration.isVisible = event.target.checked
      this._showOnlyFavorites = false
      this.redraw()
    }
  }

  toggleServer (serverRegistration) {
    this.endSharedView()

    // Any manual changes automatically disables "Only Favorites" mode
    // Otherwise the auto management might overwrite their manual changes
    this._showOnlyFavorites = false

    if (this._soloIds.has(serverRegistration.serverId)) {
      this._soloIds.delete(serverRegistration.serverId)
    } else {
      this._soloIds.add(serverRegistration.serverId)
    }

    // An empty solo means nothing is selected, so every server is shown again
    const soloing = this._soloIds.size > 0

    for (const server of this._app.serverRegistry.getServerRegistrations()) {
      server.isVisible = soloing ? this._soloIds.has(server.serverId) : true
    }

    if (!this._plotInstance) {
      for (const server of this._app.serverRegistry.getServerRegistrations()) {
        server.updateSeriesVisibility()
      }

      this.updateLocalStorage()
      this.updateControls()
      return
    }

    this.redraw()
    this.updateControls()
  }

  handleShowButtonClick = (event) => {
    this.endSharedView()

    let showType = event.currentTarget.getAttribute('minetrack-show-type')

    // Clicking Favourites again leaves that mode and shows every server
    if (showType === 'favorites' && this._showOnlyFavorites) {
      showType = 'all'
    }

    // If set to "Only Favorites", set internal state so that
    // visible graphData is automatically updating when a ServerRegistration's #isVisible changes
    // This is also saved and loaded by #loadLocalStorage & #updateLocalStorage
    this._showOnlyFavorites = showType === 'favorites'
    this._soloIds.clear()

    let redraw = false

    this._app.serverRegistry.getServerRegistrations().forEach(function (serverRegistration) {
      let isVisible
      if (showType === 'all') {
        isVisible = true
      } else if (showType === 'none') {
        isVisible = false
      } else if (showType === 'favorites') {
        isVisible = serverRegistration.isFavorite
      }

      if (serverRegistration.isVisible !== isVisible) {
        serverRegistration.isVisible = isVisible
        redraw = true
      }
    })

    if (redraw) {
      this.redraw()
    } else {
      this.updateLocalStorage()
    }

    this.updateControls()
  }

  handleServerIsFavoriteUpdate = (serverRegistration) => {
    // When in "Only Favorites" mode, visibility is dependent on favorite status
    // Redraw and update elements as needed
    if (this._showOnlyFavorites && serverRegistration.isVisible !== serverRegistration.isFavorite) {
      serverRegistration.isVisible = serverRegistration.isFavorite

      if (this._plotInstance) {
        this.redraw()
      } else {
        serverRegistration.updateSeriesVisibility()
      }
    }
  }

  updateControls () {
    if (isLegacyDesign()) {
      document.querySelectorAll('.graph-control').forEach((checkbox) => {
        const serverId = parseInt(checkbox.getAttribute('minetrack-server-id'))
        const serverRegistration = this._app.serverRegistry.getServerRegistration(serverId)
        checkbox.checked = serverRegistration.isVisible
      })
      return
    }

    document.querySelectorAll('.graph-controls-show').forEach((button) => {
      const favoritesMode = button.getAttribute('minetrack-show-type') === 'favorites'
      button.classList.toggle('is-active', favoritesMode && this._showOnlyFavorites)
      if (favoritesMode) {
        button.setAttribute('aria-pressed', this._showOnlyFavorites ? 'true' : 'false')
      }
    })
  }

  reset () {
    // Destroy graphs and unload references
    // uPlot#destroy handles listener de-registration, DOM reset, etc
    if (this._plotInstance) {
      this._plotInstance.destroy()
      this._plotInstance = undefined
    }

    this._graphTimestamps = []
    this._graphData = []
    this._hasLoadedSettings = false
    this._soloIds = new Set()

    this._lastWeekData = undefined
    this._lastWeekSeries = []
    this._lastWeekRequestedAt = undefined
    this._focusedId = null
    this._pendingFocusId = null

    if (this._focusFrame !== undefined) {
      cancelAnimationFrame(this._focusFrame)
      this._focusFrame = undefined
    }

    // Fire #clearTimeout if the timeout is currently defined
    if (this._resizeRequestTimeout) {
      clearTimeout(this._resizeRequestTimeout)

      this._resizeRequestTimeout = undefined
    }

    // Reset modified DOM structures
    const checkboxes = document.getElementById('big-graph-checkboxes')
    if (checkboxes) checkboxes.innerHTML = ''

    const controls = document.getElementById('big-graph-controls')
    if (controls) controls.style.display = 'none'

    const listControls = document.getElementById('server-list-controls')
    if (listControls) listControls.hidden = true

    const settingsToggle = document.getElementById('settings-toggle')
    if (settingsToggle) settingsToggle.style.display = 'none'
  }
}
