const sqlite = require('sqlite3')
const path = require('path')
const fs = require('fs')

const logger = require('./logger')

const config = require('../config')
const { GRAPH_UPDATE_TIME_GAP, ONE_WEEK, TimeTracker } = require('./time')

const BUSY_TIMEOUT_MS = 30 * 1000

// Mounted as a volume in production so the data outlives the container
const DATABASE_DIR = '/database'

class Database {
  constructor (app) {
    this._app = app

    if (!fs.existsSync(DATABASE_DIR)) {
      fs.mkdirSync(DATABASE_DIR)
      logger.log('warn', 'Created missing database directory %s', DATABASE_DIR)
    }

    this._sql = new sqlite.Database(path.join(DATABASE_DIR, 'database.sql'), sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE, (err) => {
      if (err) {
        logger.log('error', 'Unable to open or create database file: %s', err.message)
        throw err
      }
    })

    // A rolling deploy briefly runs the old and new container on the same file, so wait for the lock instead of crashing with SQLITE_BUSY
    this._sql.configure('busyTimeout', BUSY_TIMEOUT_MS)
  }

  getDailyDatabase () {
    if (!config.createDailyDatabaseCopy) {
      return
    }

    const date = new Date()
    const fileName = `database_copy_${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}.sql`

    if (fileName !== this._currentDatabaseCopyFileName) {
      if (this._currentDatabaseCopyInstance) {
        this._currentDatabaseCopyInstance.close()
      }

      this._currentDatabaseCopyInstance = new sqlite.Database(fileName)
      this._currentDatabaseCopyFileName = fileName

      // Ensure the initial tables are created
      // This does not created indexes since it is only inserted to
      this._currentDatabaseCopyInstance.serialize(() => {
        this._currentDatabaseCopyInstance.run('CREATE TABLE IF NOT EXISTS pings (timestamp BIGINT NOT NULL, ip TINYTEXT, playerCount MEDIUMINT)', err => {
          if (err) {
            logger.log('error', 'Cannot create initial table for daily database')
            throw err
          }
        })
      })
    }

    return this._currentDatabaseCopyInstance
  }

  ensureIndexes (callback) {
    const handleError = err => {
      if (err) {
        logger.log('error', 'Cannot create table or table index')
        throw err
      }
    }

    this._sql.serialize(() => {
      this._sql.run('CREATE TABLE IF NOT EXISTS pings (timestamp BIGINT NOT NULL, ip TINYTEXT, playerCount MEDIUMINT)', handleError)
      this._sql.run('CREATE TABLE IF NOT EXISTS players_record (timestamp BIGINT, ip TINYTEXT NOT NULL PRIMARY KEY, playerCount MEDIUMINT)', handleError)
      this._sql.run('CREATE INDEX IF NOT EXISTS ip_index ON pings (ip, playerCount)', handleError)
      this._sql.run('CREATE INDEX IF NOT EXISTS timestamp_index on PINGS (timestamp)', handleError)
      // Covers the last-week range scan so it does not look up every matching row in the table
      this._sql.run('CREATE INDEX IF NOT EXISTS timestamp_covering_index ON pings (timestamp, ip, playerCount)', [], err => {
        handleError(err)
        // Queries are executed one at a time; this is the last one.
        // Note that queries not scheduled directly in the callback function of
        // #serialize are not necessarily serialized.
        callback()
      })
    })
  }

  // Grouped by minute in SQL, since loading every raw ping for a multi-week graph would not fit in memory
  loadGraphPoints (graphDuration, callback) {
    const endTime = TimeTracker.getEpochMillis()
    const startTime = endTime - graphDuration

    this.getPingBuckets(startTime, endTime, GRAPH_UPDATE_TIME_GAP, (err, rows) => {
      if (err) {
        throw err
      }

      const buckets = [...new Set(rows.map(row => row.bucket))]
        .sort((a, b) => a - b)
        .slice(-TimeTracker.getMaxGraphDataLength())
      const indexByBucket = new Map(buckets.map((bucket, i) => [bucket, i]))

      const graphDataByIp = {}
      for (const row of rows) {
        const index = indexByBucket.get(row.bucket)
        if (index === undefined) continue

        if (!graphDataByIp[row.ip]) {
          graphDataByIp[row.ip] = Array(buckets.length).fill(null)
        }
        graphDataByIp[row.ip][index] = row.playerCount
      }

      for (const serverRegistration of this._app.serverRegistrations) {
        serverRegistration.graphData = graphDataByIp[serverRegistration.data.ip] || Array(buckets.length).fill(null)
      }

      this._app.timeTracker.loadGraphPoints(buckets.map(bucket => bucket * GRAPH_UPDATE_TIME_GAP))

      callback()
    })
  }

  loadRecords (callback) {
    let completedTasks = 0

    this._app.serverRegistrations.forEach(serverRegistration => {
      // Find graphPeaks
      // This pre-computes the values prior to clients connecting
      serverRegistration.findNewGraphPeak()

      // Query recordData
      // When complete increment completeTasks to know when complete
      this.getRecord(serverRegistration.data.ip, (hasRecord, playerCount, timestamp) => {
        if (hasRecord) {
          serverRegistration.recordData = {
            playerCount,
            timestamp: TimeTracker.toSeconds(timestamp)
          }
        } else {
          this.getRecordLegacy(serverRegistration.data.ip, (hasRecordLegacy, playerCountLegacy, timestampLegacy) => {
            // New values that will be inserted to table
            let newTimestamp = null
            let newPlayerCount = null

            // If legacy record found, use it for insertion
            if (hasRecordLegacy) {
              newTimestamp = timestampLegacy
              newPlayerCount = playerCountLegacy
            }

            // Set record to recordData
            serverRegistration.recordData = {
              playerCount: newPlayerCount,
              timestamp: TimeTracker.toSeconds(newTimestamp)
            }

            // Insert server entry to records table
            const statement = this._sql.prepare('INSERT INTO players_record (timestamp, ip, playerCount) VALUES (?, ?, ?)')
            statement.run(newTimestamp, serverRegistration.data.ip, newPlayerCount, err => {
              if (err) {
                logger.error(`Cannot insert initial player count record of ${serverRegistration.data.ip}`)
                throw err
              }
            })
            statement.finalize()
          })
        }

        // Check if completedTasks hit the finish value
        // Fire callback since #readyDatabase is complete
        if (++completedTasks === this._app.serverRegistrations.length) {
          callback()
        }
      })
    })
  }

  // One playerCount per server per bucketSize window. SQLite picks an arbitrary ping inside the window
  getPingBuckets (startTime, endTime, bucketSize, callback) {
    this._sql.all('SELECT ip, timestamp / ? AS bucket, playerCount FROM pings WHERE timestamp >= ? AND timestamp <= ? GROUP BY ip, bucket', [
      bucketSize,
      startTime,
      endTime
    ], (err, data) => {
      if (err) {
        logger.log('error', 'Cannot get ping buckets: %s', err.message)
        callback(err)
        return
      }
      callback(null, data)
    })
  }

  getRecord (ip, callback) {
    this._sql.get('SELECT playerCount, timestamp FROM players_record WHERE ip = ?', [
      ip
    ], (err, row) => {
      if (err) {
        logger.log('error', `Cannot get ping record for ${ip}`)
        throw err
      }

      // Record not found
      if (!row) {
        callback(false)
        return
      }

      // Allow null player counts and timestamps, the frontend will safely handle them
      callback(true, row.playerCount, row.timestamp)
    })
  }

  // Retrieves record from pings table, used for converting to separate table
  getRecordLegacy (ip, callback) {
    this._sql.get('SELECT MAX(playerCount) AS playerCount, timestamp FROM pings WHERE ip = ?', [
      ip
    ], (err, row) => {
      if (err) {
        logger.log('error', `Cannot get legacy ping record for ${ip}`)
        throw err
      }

      // An aggregate always returns one row, with null values when there are no pings
      const { playerCount, timestamp } = row

      // Allow null timestamps, the frontend will safely handle them
      // This allows insertion of free standing records without a known timestamp
      if (playerCount !== null) {
        callback(true, playerCount, timestamp)
      } else {
        callback(false)
      }
    })
  }

  insertPing (ip, timestamp, unsafePlayerCount) {
    this._insertPingTo(ip, timestamp, unsafePlayerCount, this._sql)

    // Push a copy of the data into the database copy, if any
    // This creates an "insert only" copy of the database for archiving
    const dailyDatabase = this.getDailyDatabase()
    if (dailyDatabase) {
      this._insertPingTo(ip, timestamp, unsafePlayerCount, dailyDatabase)
    }
  }

  _insertPingTo (ip, timestamp, unsafePlayerCount, db) {
    const statement = db.prepare('INSERT INTO pings (timestamp, ip, playerCount) VALUES (?, ?, ?)')
    statement.run(timestamp, ip, unsafePlayerCount, err => {
      if (err) {
        logger.error(`Cannot insert ping record of ${ip} at ${timestamp}`)
        throw err
      }
    })
    statement.finalize()
  }

  updatePlayerCountRecord (ip, playerCount, timestamp) {
    const statement = this._sql.prepare('UPDATE players_record SET timestamp = ?, playerCount = ? WHERE ip = ?')
    statement.run(timestamp, playerCount, ip, err => {
      if (err) {
        logger.error(`Cannot update player count record of ${ip} at ${timestamp}`)
        throw err
      }
    })
    statement.finalize()
  }

  initOldPingsDelete (callback) {
    // Delete old pings on startup
    logger.info('Deleting old pings..')
    this.deleteOldPings(() => {
      const oldPingsCleanupInterval = config.oldPingsCleanup.interval || 3600000
      if (oldPingsCleanupInterval > 0) {
        // Delete old pings periodically
        setInterval(() => this.deleteOldPings(), oldPingsCleanupInterval)
      }

      callback()
    })
  }

  deleteOldPings (callback) {
    // Never keep less than the graph plus one week, or the last week comparison would have gaps
    const maxAge = Math.max(config.oldPingsCleanup.maxAge || 0, config.graphDuration + ONE_WEEK)
    const oldestTimestamp = TimeTracker.getEpochMillis() - maxAge

    const deleteStart = TimeTracker.getEpochMillis()
    const statement = this._sql.prepare('DELETE FROM pings WHERE timestamp < ?;')
    statement.run(oldestTimestamp, err => {
      if (err) {
        logger.error('Cannot delete old pings')
        throw err
      } else {
        const deleteTook = TimeTracker.getEpochMillis() - deleteStart
        logger.info(`Old pings deleted in ${deleteTook}ms`)

        if (callback) {
          callback()
        }
      }
    })
    statement.finalize()
  }
}

module.exports = Database
