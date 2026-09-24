const SHARE_PARAMS = ['servers', 'range', 'from', 'to', 'history']

const RANGE_UNITS = {
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60
}

export function formatRange (seconds) {
  if (seconds % RANGE_UNITS.d === 0) return `${seconds / RANGE_UNITS.d}d`
  if (seconds % RANGE_UNITS.h === 0) return `${seconds / RANGE_UNITS.h}h`
  return `${Math.round(seconds / RANGE_UNITS.m)}m`
}

function parseRange (value) {
  const match = /^(\d+)([mhd])$/.exec(value || '')
  if (!match) return
  const seconds = parseInt(match[1]) * RANGE_UNITS[match[2]]
  return seconds > 0 ? seconds : undefined
}

// Each server is its own servers= param, since names can contain any separator
export function parseSharedView (search) {
  const params = new URLSearchParams(search)

  if (!SHARE_PARAMS.some(key => params.has(key))) return

  const view = {}

  const servers = params.getAll('servers').filter(name => name.length > 0)
  if (servers.length > 0) {
    view.servers = servers
  }

  const range = parseRange(params.get('range'))
  if (range) {
    view.range = range
  } else {
    const from = parseInt(params.get('from'))
    const to = parseInt(params.get('to'))
    if (from > 0 && to > from) {
      view.from = from
      view.to = to
    }
  }

  if (params.get('history') === '0') {
    view.history = false
  }

  return view
}

// Keeps the address bar in sync with the graph, so copying it shares the current view
export function writeSharedViewToUrl (view) {
  const params = new URLSearchParams(location.search)
  SHARE_PARAMS.forEach(key => params.delete(key))

  if (view.servers) {
    view.servers.forEach(name => params.append('servers', name))
  }
  if (view.range) {
    params.set('range', formatRange(view.range))
  } else if (view.from && view.to) {
    params.set('from', view.from)
    params.set('to', view.to)
  }
  if (view.history === false) {
    params.set('history', '0')
  }

  const search = params.toString()
  const url = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`

  if (url !== `${location.pathname}${location.search}${location.hash}`) {
    history.replaceState(history.state, '', url)
  }
}
