// Server side twin of assets/js/share.js, used to build link previews for shared graph views

const SHARE_PARAMS = ['servers', 'range', 'from', 'to', 'history']

// Matches DEFAULT_RANGE in assets/js/graph.js
const DEFAULT_RANGE = 3 * 24 * 60 * 60

// Bounds the work a single preview request can ask for
const MAX_SERVER_PARAMS = 20

const RANGE_UNITS = {
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60
}

// Links copied from the page carry the sharer's time zone, so previews read in their local time
function normalizeTimeZone (value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
    return 'UTC'
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function parseRange (value) {
  const match = /^(\d+)([mhd])$/.exec(value || '')
  if (!match) return
  const seconds = parseInt(match[1]) * RANGE_UNITS[match[2]]
  return seconds > 0 ? seconds : undefined
}

// Same rules as parseSharedView in assets/js/share.js, but always returns a view
function parseSharedView (search) {
  const params = new URLSearchParams(search)
  const view = {}

  if (params.has('tz')) {
    view.timeZone = normalizeTimeZone(params.get('tz'))
  }

  if (!SHARE_PARAMS.some(key => params.has(key))) return view

  const servers = params.getAll('servers').filter(name => name.length > 0).slice(0, MAX_SERVER_PARAMS)
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

  if (params.get('history') === '1') {
    view.history = true
  }

  return view
}

// Turns a parsed view into the servers and window to draw, all times in seconds
// first/last are the bounds of the graph data the server holds
function resolveView (view, serverRegistrations, first, last) {
  const names = new Set(view.servers || [])
  const matched = serverRegistrations.filter(serverRegistration => names.has(serverRegistration.data.name))

  // Names that no longer exist are ignored, and with none left every server is shown
  const registrations = matched.length > 0 ? matched : serverRegistrations

  let from
  let to

  if (view.range) {
    to = last
    from = last - view.range
  } else if (view.from && view.to && view.to > first && view.from < last) {
    from = view.from
    to = view.to
  } else {
    to = last
    from = last - DEFAULT_RANGE
  }

  from = Math.max(from, first)
  to = Math.min(to, last)

  // An old link can point at a window that has scrolled out of the graph
  if (!(to > from)) {
    to = last
    from = Math.max(first, last - DEFAULT_RANGE)
  }

  return {
    registrations,
    isAllServers: matched.length === 0 || matched.length === serverRegistrations.length,
    timeZone: view.timeZone || 'UTC',
    history: view.history === true,
    from: Math.floor(from),
    to: Math.floor(to)
  }
}

// Absolute window in the query, so a live "range" link still gets a fresh image URL as time moves
function canonicalQuery (resolved, roundTo = 60) {
  const params = new URLSearchParams()

  if (!resolved.isAllServers) {
    resolved.registrations.forEach(serverRegistration => params.append('servers', serverRegistration.data.name))
  }

  let from = Math.floor(resolved.from / roundTo) * roundTo
  let to = Math.floor(resolved.to / roundTo) * roundTo

  // Windows shorter than the rounding keep their exact bounds
  if (!(to > from)) {
    from = resolved.from
    to = resolved.to
  }

  params.set('from', from)
  params.set('to', to)

  if (resolved.history) {
    params.set('history', '1')
  }
  if (resolved.timeZone && resolved.timeZone !== 'UTC') {
    params.set('tz', resolved.timeZone)
  }

  return params.toString()
}

module.exports = {
  DEFAULT_RANGE,
  normalizeTimeZone,
  parseSharedView,
  resolveView,
  canonicalQuery
}
