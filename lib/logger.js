const winston = require('winston')

const { format } = winston

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.File({
      filename: 'minetrack.log',
      format: format.combine(format.timestamp(), format.splat(), format.simple())
    }),
    new winston.transports.Console({
      format: format.combine(
        format.splat(),
        format.timestamp({
          format: () => {
            const date = new Date()
            return date.toLocaleTimeString() + ' ' + date.toLocaleDateString()
          }
        }),
        format.colorize(),
        format.printf(({ level, message, timestamp }) => `${timestamp} - ${level}: ${message}`)
      )
    })
  ]
})

module.exports = logger
