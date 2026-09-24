const Database = require('./database')
const PingController = require('./ping')
const Server = require('./server')
const { GRAPH_UPDATE_TIME_GAP, ONE_WEEK, TimeTracker } = require('./time')
const MessageOf = require('./message')

const config = require('../config')
const minecraftVersions = require('../minecraft_versions')

// Last week data is fetched slightly past "now - 1 week" so the frontend
// can keep extending the history lines without re-requesting every minute
const LAST_WEEK_LOOKAHEAD = 60 * 60 * 1000

// A cached payload is reused until less than this much of its lookahead remains
const LAST_WEEK_MIN_LOOKAHEAD = 30 * 60 * 1000

const ONE_HOUR = 60 * 60 * 1000
const ONE_DAY = 24 * ONE_HOUR

function formatDuration (millis) {
  return millis % ONE_DAY === 0 ? `${millis / ONE_DAY}d` : `${Math.floor(millis / ONE_HOUR)}h`
}

class App {
  serverRegistrations = []
  _lastWeekGraph
  _lastWeekGraphCallbacks

  constructor () {
    this.pingController = new PingController(this)
    this.server = new Server(this)
    this.timeTracker = new TimeTracker(this)
  }

  loadDatabase (callback) {
    this.database = new Database(this)

    // Setup database instance
    this.database.ensureIndexes(() => {
      this.database.loadGraphPoints(config.graphDuration, () => {
        this.database.loadRecords(() => {
          if (config.oldPingsCleanup && config.oldPingsCleanup.enabled) {
            this.database.initOldPingsDelete(callback)
          } else {
            callback()
          }
        })
      })
    })
  }

  handleReady () {
    this.server.listen(config.site.ip, config.site.port)

    // Allow individual modules to manage their own task scheduling
    this.pingController.schedule()
  }

  handleClientConnection = (client) => {
    if (config.logToDatabase) {
      client.on('message', (message) => {
        if (message === 'requestHistoryGraph') {
          // Send historical graphData built from all serverRegistrations
          const graphData = this.serverRegistrations.map(serverRegistration => serverRegistration.graphData)

          // Send graphData in object wrapper to avoid needing to explicity filter
          // any header data being appended by #MessageOf since the graph data is fed
          // directly into the graphing system
          client.send(MessageOf('historyGraph', {
            timestamps: this.timeTracker.getGraphPoints(),
            graphData
          }))
        } else if (message === 'requestLastWeekGraph') {
          this.getLastWeekGraph(payload => {
            if (payload) {
              client.send(payload)
            }
          })
        }
      })
    }

    const initMessage = {
      config: (() => {
        // Remap minecraftVersion entries into name values
        const minecraftVersionNames = {}
        Object.keys(minecraftVersions).forEach(function (key) {
          minecraftVersionNames[key] = minecraftVersions[key].map(version => version.name)
        })

        // Send configuration data for rendering the page
        return {
          graphDurationLabel: config.graphDurationLabel || formatDuration(config.graphDuration),
          graphDuration: TimeTracker.toSeconds(config.graphDuration),
          graphMaxLength: TimeTracker.getMaxGraphDataLength(),
          serverGraphMaxLength: TimeTracker.getMaxServerGraphDataLength(),
          servers: this.serverRegistrations.map(serverRegistration => serverRegistration.getPublicData()),
          minecraftVersions: minecraftVersionNames,
          isGraphVisible: config.logToDatabase
        }
      })(),
      timestampPoints: this.timeTracker.getServerGraphPoints(),
      servers: this.serverRegistrations.map(serverRegistration => serverRegistration.getPingHistory())
    }

    client.send(MessageOf('init', initMessage))
  }

  // Builds every server's graph from a week ago as one payload shared by all clients
  // Values are grouped into GRAPH_UPDATE_TIME_GAP buckets, with bucketStart already shifted forward a week
  getLastWeekGraph (callback) {
    const now = TimeTracker.getEpochMillis()

    if (this._lastWeekGraph && this._lastWeekGraph.coversUntil - now > LAST_WEEK_MIN_LOOKAHEAD) {
      callback(this._lastWeekGraph.payload)
      return
    }

    // Coalesce concurrent requests into a single query
    if (this._lastWeekGraphCallbacks) {
      this._lastWeekGraphCallbacks.push(callback)
      return
    }

    this._lastWeekGraphCallbacks = [callback]

    const startTime = now - config.graphDuration - ONE_WEEK
    const endTime = now - ONE_WEEK + LAST_WEEK_LOOKAHEAD

    this.database.getPingBuckets(startTime, endTime, GRAPH_UPDATE_TIME_GAP, (err, rows) => {
      let payload

      if (!err) {
        const firstBucket = Math.floor(startTime / GRAPH_UPDATE_TIME_GAP)
        const bucketCount = Math.floor(endTime / GRAPH_UPDATE_TIME_GAP) - firstBucket + 1

        const rowsByIp = {}
        for (const row of rows) {
          if (!rowsByIp[row.ip]) {
            rowsByIp[row.ip] = []
          }
          rowsByIp[row.ip].push(row)
        }

        const graphData = this.serverRegistrations.map(serverRegistration => {
          const series = Array(bucketCount).fill(null)

          for (const row of rowsByIp[serverRegistration.data.ip] || []) {
            series[row.bucket - firstBucket] = row.playerCount
          }

          return series
        })

        payload = MessageOf('lastWeekGraph', {
          bucketStart: TimeTracker.toSeconds(firstBucket * GRAPH_UPDATE_TIME_GAP + ONE_WEEK),
          bucketSize: TimeTracker.toSeconds(GRAPH_UPDATE_TIME_GAP),
          coversUntil: TimeTracker.toSeconds(endTime + ONE_WEEK),
          graphData
        })

        this._lastWeekGraph = {
          payload,
          coversUntil: endTime + ONE_WEEK
        }
      }

      const callbacks = this._lastWeekGraphCallbacks
      this._lastWeekGraphCallbacks = undefined

      callbacks.forEach(cb => cb(payload))
    })
  }
}

module.exports = App
