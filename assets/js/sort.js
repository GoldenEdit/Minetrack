import { isLegacyDesign } from './design'
import { compareFavoriteFirst } from './favorites'

const SORT_OPTIONS = [
  {
    mode: 'players',
    sortFunc: (a, b) => b.playerCount - a.playerCount
  },
  {
    mode: 'record',
    sortFunc: (a, b) => {
      if (!a.lastRecordData && !b.lastRecordData) {
        return 0
      } else if (a.lastRecordData && !b.lastRecordData) {
        return -1
      } else if (b.lastRecordData && !a.lastRecordData) {
        return 1
      }
      return b.lastRecordData.playerCount - a.lastRecordData.playerCount
    },
    testFunc: (app) => {
      for (const serverRegistration of app.serverRegistry.getServerRegistrations()) {
        if (serverRegistration.lastRecordData) return true
      }
      return false
    }
  },
  {
    mode: 'name',
    sortFunc: (a, b) => a.data.name.localeCompare(b.data.name)
  }
]

const LEGACY_SORT_OPTIONS = [
  {
    getName: () => 'Players',
    sortFunc: SORT_OPTIONS[0].sortFunc,
    highlightedValue: 'player-count'
  },
  {
    getName: (app) => `${app.publicConfig.graphDurationLabel} Peak`,
    sortFunc: (a, b) => {
      if (!a.lastPeakData && !b.lastPeakData) return 0
      if (a.lastPeakData && !b.lastPeakData) return -1
      if (b.lastPeakData && !a.lastPeakData) return 1
      return b.lastPeakData.playerCount - a.lastPeakData.playerCount
    },
    testFunc: (app) => {
      for (const serverRegistration of app.serverRegistry.getServerRegistrations()) {
        if (serverRegistration.lastPeakData) return true
      }
      return false
    },
    highlightedValue: 'peak'
  },
  {
    getName: () => 'Record',
    sortFunc: SORT_OPTIONS[1].sortFunc,
    testFunc: SORT_OPTIONS[1].testFunc,
    highlightedValue: 'record'
  }
]

const SORT_OPTION_INDEX_DEFAULT = 0
const SORT_MODE_STORAGE_KEY = 'minetrack_sort_mode'
const SORT_OPTION_INDEX_STORAGE_KEY = 'minetrack_sort_option_index'

export class SortController {
  constructor (app) {
    this._app = app
    this._legacy = isLegacyDesign()
    this._buttonElement = document.getElementById('sort-by')
    this._textElement = this._legacy ? document.getElementById('sort-by-text') : null
    this._sortOptionIndex = SORT_OPTION_INDEX_DEFAULT
  }

  activeSortOptions () {
    return this._legacy ? LEGACY_SORT_OPTIONS : SORT_OPTIONS
  }

  reset () {
    this._lastSortedServers = undefined

    if (this._legacy) {
      this._buttonElement.style.display = 'none'
      if (this._textElement) this._textElement.innerText = '...'
      this._buttonElement.removeEventListener('click', this.handleLegacySortClick)
      return
    }

    // Remove bound DOM event listeners
    this._buttonElement.removeEventListener('click', this.handleSortButtonClick)
  }

  loadLocalStorage () {
    if (typeof localStorage === 'undefined') return

    if (this._legacy) {
      const sortOptionIndex = localStorage.getItem(SORT_OPTION_INDEX_STORAGE_KEY)
      if (sortOptionIndex) this._sortOptionIndex = parseInt(sortOptionIndex)
      return
    }

    const mode = localStorage.getItem(SORT_MODE_STORAGE_KEY)
    if (mode) {
      const index = SORT_OPTIONS.findIndex(option => option.mode === mode)
      if (index >= 0) this._sortOptionIndex = index
      return
    }

    // Previous builds stored Players=0, Peak=1, Record=2.
    const legacy = localStorage.getItem(SORT_OPTION_INDEX_STORAGE_KEY)
    if (legacy === '2') this._sortOptionIndex = 1
  }

  updateLocalStorage () {
    if (typeof localStorage === 'undefined') return

    if (this._legacy) {
      if (this._sortOptionIndex !== SORT_OPTION_INDEX_DEFAULT) {
        localStorage.setItem(SORT_OPTION_INDEX_STORAGE_KEY, this._sortOptionIndex)
      } else {
        localStorage.removeItem(SORT_OPTION_INDEX_STORAGE_KEY)
      }
      return
    }

    const mode = SORT_OPTIONS[this._sortOptionIndex].mode
    if (mode !== 'players') {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, mode)
    } else {
      localStorage.removeItem(SORT_MODE_STORAGE_KEY)
    }
  }

  show () {
    if (this._legacy) {
      this.showLegacy()
      return
    }

    this.loadLocalStorage()

    const sortOption = SORT_OPTIONS[this._sortOptionIndex]
    if (sortOption.testFunc && !sortOption.testFunc(this._app)) {
      this._sortOptionIndex = SORT_OPTION_INDEX_DEFAULT
    }

    this.updateSortOption()

    // Bind DOM event listeners
    // This is removed by #reset to avoid multiple listeners
    this._buttonElement.addEventListener('click', this.handleSortButtonClick)
  }

  showLegacy () {
    this.loadLocalStorage()

    const sortOption = this.activeSortOptions()[this._sortOptionIndex]
    if (!sortOption || (sortOption.testFunc && !sortOption.testFunc(this._app))) {
      this._sortOptionIndex = SORT_OPTION_INDEX_DEFAULT
    }

    this.updateLegacySortOption()
    this._buttonElement.addEventListener('click', this.handleLegacySortClick)
    this._buttonElement.style.display = 'inline-block'
  }

  handleLegacySortClick = () => {
    const options = this.activeSortOptions()

    for (let step = 0; step < options.length; step++) {
      this._sortOptionIndex = (this._sortOptionIndex + 1) % options.length
      const sortOption = options[this._sortOptionIndex]
      if (!sortOption.testFunc || sortOption.testFunc(this._app)) break
    }

    this.updateLegacySortOption()
    this.updateLocalStorage()
  }

  updateLegacySortOption () {
    const sortOption = this.activeSortOptions()[this._sortOptionIndex]
    this._textElement.innerText = sortOption.getName(this._app)

    for (const serverRegistration of this._app.serverRegistry.getServerRegistrations()) {
      serverRegistration.updateHighlightedValue(sortOption.highlightedValue)
    }

    this.sortServersLegacy()
  }

  sortServersLegacy () {
    const sortOption = this.activeSortOptions()[this._sortOptionIndex]
    const sortedServers = this.sortByFavoriteThen(sortOption.sortFunc)
    const sortedServerIds = sortedServers.map(server => server.serverId)

    if (this.sameServerOrder(sortedServerIds)) return

    this._lastSortedServers = sortedServerIds
    this.placeServers(sortedServers, sortOption.sortFunc)
  }

  handleSortButtonClick = (event) => {
    const button = event.target.closest('[data-sort-index]')
    if (!button || button.disabled) return

    const index = parseInt(button.getAttribute('data-sort-index'))
    if (index === this._sortOptionIndex || !SORT_OPTIONS[index]) return

    this._sortOptionIndex = index
    this.updateSortOption()
    this.updateLocalStorage()
  }

  refreshSortAvailability () {
    this._buttonElement.querySelectorAll('[data-sort-index]').forEach((button) => {
      const index = parseInt(button.getAttribute('data-sort-index'))
      const sortOption = SORT_OPTIONS[index]
      button.disabled = !!(sortOption.testFunc && !sortOption.testFunc(this._app))
    })
  }

  updateSortOption = () => {
    this._buttonElement.querySelectorAll('[data-sort-index]').forEach((button) => {
      const selected = parseInt(button.getAttribute('data-sort-index')) === this._sortOptionIndex
      button.classList.toggle('is-active', selected)
      button.setAttribute('aria-pressed', selected ? 'true' : 'false')
    })

    this.refreshSortAvailability()

    const list = document.getElementById('server-list')
    if (list) list.dataset.sort = SORT_OPTIONS[this._sortOptionIndex].mode

    this.sortServers()
  }

  sortServers = () => {
    if (this._legacy) {
      this.sortServersLegacy()
      return
    }

    this.refreshSortAvailability()

    const sortOption = SORT_OPTIONS[this._sortOptionIndex]
    const sortedServers = this.sortByFavoriteThen(sortOption.sortFunc)
    const sortedServerIds = sortedServers.map(server => server.serverId)

    // Starring the server that is already first does not change order, so the
    // favourites divider still has to be placed when the sequence is unchanged.
    if (!this.sameServerOrder(sortedServerIds)) {
      this._lastSortedServers = sortedServerIds
      this.placeServers(sortedServers, sortOption.sortFunc)
    }

    this.placeFavoritesDivider(sortedServers)
    this._app.serverRegistry.applySearch()
  }

  sortByFavoriteThen (sortFunc) {
    return this._app.serverRegistry.getServerRegistrations().sort((a, b) => {
      return compareFavoriteFirst(a, b) || sortFunc(a, b)
    })
  }

  sameServerOrder (sortedServerIds) {
    if (!this._lastSortedServers) return false

    for (let i = 0; i < sortedServerIds.length; i++) {
      if (sortedServerIds[i] !== this._lastSortedServers[i]) return false
    }

    return true
  }

  placeServers (sortedServers, sortFunc) {
    const rankIndexSort = this._app.serverRegistry.getServerRegistrations().sort(sortFunc)
    const parentElement = document.getElementById('server-list')

    sortedServers.forEach((serverRegistration) => {
      parentElement.appendChild(document.getElementById(`container_${serverRegistration.serverId}`))
      serverRegistration.updateServerRankIndex(rankIndexSort.indexOf(serverRegistration))
    })
  }

  placeFavoritesDivider (sortedServers) {
    const parentElement = document.getElementById('server-list')
    let divider = document.getElementById('favorites-divider')

    if (!divider) {
      divider = document.createElement('div')
      divider.id = 'favorites-divider'
      divider.className = 'favorites-divider'
      divider.setAttribute('role', 'separator')
    }
    let inserted = false

    for (let index = 0; index < sortedServers.length; index++) {
      const next = sortedServers[index + 1]
      if (sortedServers[index].isFavorite && next && !next.isFavorite) {
        const nextElement = document.getElementById(`container_${next.serverId}`)
        parentElement.insertBefore(divider, nextElement)
        inserted = true
        break
      }
    }

    if (!inserted && divider.parentElement) {
      divider.remove()
    }
  }
}
