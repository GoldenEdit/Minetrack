const fs = require('fs')
const http = require('http')
const path = require('path')

const WebSocket = require('ws')
const finalHttpHandler = require('finalhandler')
const serveStatic = require('serve-static')

const logger = require('./logger')
const GraphImage = require('./graphimage')
const { parseSharedView, resolveView, canonicalQuery } = require('./share')
const { TimeTracker } = require('./time')

const config = require('../config')

const INDEX_PATH = path.join(__dirname, '..', 'dist', 'index.html')

const PREVIEW_CACHE_SIZE = 100
const LIVE_PREVIEW_TTL = 60 * 1000
const FIXED_PREVIEW_TTL = 60 * 60 * 1000

const HASHED_FAVICON_URL_REGEX = /hashedfavicon_([a-z0-9]{32})\.png/g

function getRemoteAddr (req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress
}

function getPathname (url) {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

function getSearch (url) {
  const index = url.indexOf('?')
  return index === -1 ? '' : url.slice(index)
}

function firstHeaderValue (value) {
  return typeof value === 'string' ? value.split(',')[0].trim() : undefined
}

// Previews need absolute URLs. Behind a proxy the forwarded headers carry the public scheme and host
function getBaseUrl (req) {
  if (config.site.publicUrl) {
    return config.site.publicUrl.replace(/\/+$/, '')
  }

  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http')
  const host = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host || 'localhost'

  return `${proto === 'https' ? 'https' : 'http'}://${host}`
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char])
}

class Server {
  static getHashedFaviconUrl (hash) {
    // Format must be compatible with HASHED_FAVICON_URL_REGEX
    return `/hashedfavicon_${hash}.png`
  }

  constructor (app) {
    this._app = app
    this._previewCache = new Map()

    this.createHttpServer()
    this.createWebSocketServer()
  }

  createHttpServer () {
    const distServeStatic = serveStatic('dist/')
    const faviconsServeStatic = serveStatic('favicons/')

    this._http = http.createServer((req, res) => {
      logger.log('info', '%s requested: %s', getRemoteAddr(req), req.url)

      // Test the URL against a regex for hashed favicon URLs
      // Require only 1 match ([0]) and test its first captured group ([1])
      // Any invalid value or hit miss will pass into static handlers below
      const faviconHash = [...req.url.matchAll(HASHED_FAVICON_URL_REGEX)]

      // Link previews: crawlers like Discord's read meta tags and fetch an image, but never run the page's JavaScript
      if (req.method === 'GET' || req.method === 'HEAD') {
        const pathname = getPathname(req.url)

        if ((pathname === '/' || pathname === '/index.html') && this.handleIndexRequest(req, res)) {
          return
        }
        if (pathname === '/og.png' && this.handlePreviewImageRequest(req, res)) {
          return
        }
      }

      if (faviconHash.length === 1 && this.handleFaviconRequest(res, faviconHash[0][1])) {
        return
      }

      // Attempt to handle req using distServeStatic, otherwise fail over to faviconServeStatic
      // If faviconServeStatic fails, pass to finalHttpHandler to terminate
      distServeStatic(req, res, () => {
        faviconsServeStatic(req, res, finalHttpHandler(req, res))
      })
    })
  }

  // Graph bounds in seconds, matching what the frontend can show
  getGraphBounds () {
    const timestamps = this._app.timeTracker.getGraphPoints()
    const now = TimeTracker.toSeconds(TimeTracker.getEpochMillis())
    return {
      timestamps,
      first: timestamps.length > 0 ? timestamps[0] : now,
      last: timestamps.length > 0 ? timestamps[timestamps.length - 1] : now
    }
  }

  resolveSharedView (url) {
    const { timestamps, first, last } = this.getGraphBounds()
    const view = parseSharedView(getSearch(url))
    const resolved = resolveView(view, this._app.serverRegistrations, first, last)
    return { timestamps, last, resolved }
  }

  readIndexHtml () {
    let stat
    try {
      stat = fs.statSync(INDEX_PATH)
    } catch {
      return
    }

    if (!this._indexHtml || this._indexHtml.mtimeMs !== stat.mtimeMs) {
      this._indexHtml = {
        mtimeMs: stat.mtimeMs,
        html: fs.readFileSync(INDEX_PATH, 'utf8')
      }
    }

    return this._indexHtml.html
  }

  handleIndexRequest = (req, res) => {
    const html = this.readIndexHtml()
    if (!html || html.indexOf('</head>') === -1) {
      return false
    }

    const baseUrl = getBaseUrl(req)
    const { timestamps, resolved } = this.resolveSharedView(req.url)
    const tags = [
      ['property', 'og:type', 'website'],
      ['property', 'og:site_name', 'Minetrack'],
      ['property', 'og:url', baseUrl + req.url]
    ]

    if (config.logToDatabase && this._app.serverRegistrations.length > 0) {
      const { title, description } = GraphImage.describe(resolved, timestamps)
      const imageUrl = `${baseUrl}/og.png?${canonicalQuery(resolved)}`

      tags.push(
        ['property', 'og:title', title],
        ['property', 'og:description', description],
        ['property', 'og:image', imageUrl],
        ['property', 'og:image:type', 'image/png'],
        ['property', 'og:image:width', GraphImage.WIDTH],
        ['property', 'og:image:height', GraphImage.HEIGHT],
        ['property', 'og:image:alt', `${title}: ${description}`],
        ['name', 'twitter:card', 'summary_large_image'],
        ['name', 'twitter:title', title],
        ['name', 'twitter:description', description],
        ['name', 'twitter:image', imageUrl]
      )
    } else {
      tags.push(
        ['property', 'og:title', 'Minetrack'],
        ['property', 'og:description', 'Live player counts for Minecraft servers.']
      )
    }

    const meta = tags
      .map(([attribute, key, value]) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`)
      .join('\n\t')

    const body = Buffer.from(html.replace('</head>', `\t${meta}\n</head>`))

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=UTF-8',
      'Content-Length': body.length,
      // The tags depend on the query and live data, while the hashed assets it links to stay cacheable
      'Cache-Control': 'no-cache'
    })
    res.end(req.method === 'HEAD' ? undefined : body)

    return true
  }

  handlePreviewImageRequest = (req, res) => {
    if (!config.logToDatabase) {
      return false
    }

    const { timestamps, last, resolved } = this.resolveSharedView(req.url)
    // Favicons only arrive with the first ping, so a new icon must not hit an image cached without it
    const key = canonicalQuery(resolved) + '#' + resolved.registrations.map(serverRegistration => serverRegistration.faviconHash || '').join(',')
    const isLive = resolved.to >= last - 120
    const now = Date.now()

    const send = (entry) => {
      // Re-inserting keeps the Map ordered by last use, so the first key is the one to evict
      this._previewCache.delete(key)
      this._previewCache.set(key, entry)
      while (this._previewCache.size > PREVIEW_CACHE_SIZE) {
        this._previewCache.delete(this._previewCache.keys().next().value)
      }

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': entry.png.length,
        'Cache-Control': `public, max-age=${isLive ? 300 : 86400}`
      })
      res.end(req.method === 'HEAD' ? undefined : entry.png)
    }

    const render = (lastWeek) => {
      let png
      try {
        png = GraphImage.renderPng(resolved, timestamps, lastWeek)
      } catch (err) {
        logger.log('error', 'Cannot render graph preview: %s', err.message)
        res.writeHead(500).end()
        return
      }

      send({
        png,
        expires: now + (isLive ? LIVE_PREVIEW_TTL : FIXED_PREVIEW_TTL)
      })
    }

    const cached = this._previewCache.get(key)

    if (cached && cached.expires >= now) {
      send(cached)
    } else if (resolved.history) {
      // Uses the same cached last week query as the page, so this rarely touches the database
      this._app.getLastWeekGraphData(render)
    } else {
      render()
    }

    return true
  }

  handleFaviconRequest = (res, faviconHash) => {
    for (const serverRegistration of this._app.serverRegistrations) {
      if (serverRegistration.faviconHash === faviconHash) {
        const buf = Buffer.from(serverRegistration.lastFavicon.split(',')[1], 'base64')

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800' // Cache hashed favicon for 7 days
        }).end(buf)

        return true
      }
    }

    return false
  }

  createWebSocketServer () {
    this._wss = new WebSocket.Server({
      server: this._http,
      // The graph payloads are megabytes of numbers, while the frequent update messages stay uncompressed
      perMessageDeflate: {
        threshold: 64 * 1024
      }
    })

    this._wss.on('connection', (client, req) => {
      logger.log('info', '%s connected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())

      // Bind disconnect event for logging
      client.on('close', () => {
        logger.log('info', '%s disconnected, total clients: %d', getRemoteAddr(req), this.getConnectedClients())
      })

      // Pass client off to proxy handler
      this._app.handleClientConnection(client)
    })
  }

  listen (host, port) {
    this._http.listen(port, host)

    logger.log('info', 'Started on %s:%d', host, port)
  }

  broadcast (payload) {
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      }
    })
  }

  getConnectedClients () {
    let count = 0
    this._wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        count++
      }
    })
    return count
  }
}

module.exports = Server
