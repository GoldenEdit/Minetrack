import { formatDay } from './util'

export function uPlotTooltipPlugin (onHover) {
  let element

  return {
    hooks: {
      init: u => {
        element = u.root.querySelector('.over')

        element.onmouseenter = () => onHover()
        element.onmouseleave = () => onHover()
      },
      setCursor: u => {
        const { left, top, idx } = u.cursor

        if (idx === null || (u.select && u.select.width > 0)) {
          onHover()
        } else {
          const bounds = element.getBoundingClientRect()

          onHover({
            left: bounds.left + left + window.pageXOffset,
            top: bounds.top + top + window.pageYOffset
          }, idx)
        }
      }
    }
  }
}

// Drawn on drawClear so the lines sit underneath the series
export function uPlotDayBoundariesPlugin ({ lineColor, labelColor, fontFamily }) {
  const MIN_LABEL_SPACING = 90

  return {
    hooks: {
      drawClear: u => {
        const { min, max } = u.scales.x
        if (min == null || max == null || max <= min) return

        const ratio = devicePixelRatio
        const { left, top, width, height } = u.bbox
        const secondsPerPixel = (max - min) / (width / ratio)
        const showLabels = (24 * 60 * 60) / secondsPerPixel >= MIN_LABEL_SPACING

        const ctx = u.ctx
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, top, width, height)
        ctx.clip()
        ctx.lineWidth = ratio
        ctx.strokeStyle = lineColor
        ctx.setLineDash([2 * ratio, 3 * ratio])
        ctx.fillStyle = labelColor
        ctx.font = `${11 * ratio}px ${fontFamily}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'

        // setHours(24) moves to the next local midnight, and stepping by date keeps DST days correct
        const day = new Date(min * 1000)
        day.setHours(24, 0, 0, 0)

        for (; day.getTime() / 1000 < max; day.setDate(day.getDate() + 1)) {
          const x = Math.round(u.valToPos(day.getTime() / 1000, 'x', true)) + 0.5

          ctx.beginPath()
          ctx.moveTo(x, top)
          ctx.lineTo(x, top + height)
          ctx.stroke()

          if (showLabels) {
            ctx.fillText(formatDay(day.getTime() / 1000), x + 4 * ratio, top + 4 * ratio)
          }
        }

        ctx.restore()
      }
    }
  }
}

// Time chips on the drag range, in the same place Datadog puts them
export function uPlotRangeSelectPlugin (formatTime) {
  let startLabel
  let endLabel

  const hide = () => {
    if (!startLabel) return
    startLabel.style.display = 'none'
    endLabel.style.display = 'none'
  }

  return {
    hooks: {
      init: u => {
        const over = u.root.querySelector('.over')
        startLabel = document.createElement('div')
        endLabel = document.createElement('div')
        startLabel.className = 'graph-range-label'
        endLabel.className = 'graph-range-label is-end'
        over.appendChild(startLabel)
        over.appendChild(endLabel)
      },
      setCursor: u => {
        const { left, width } = u.select

        if (width < 2) {
          hide()
          return
        }

        startLabel.textContent = formatTime(Math.round(u.posToVal(left, 'x')))
        endLabel.textContent = formatTime(Math.round(u.posToVal(left + width, 'x')))
        startLabel.style.display = 'block'
        endLabel.style.display = 'block'

        const startWidth = startLabel.offsetWidth
        const endWidth = endLabel.offsetWidth
        const plotWidth = u.root.querySelector('.over').clientWidth
        const narrow = width < startWidth + endWidth + 8

        let startLeft = left
        if (startLeft < 4) startLeft = 4
        if (startLeft + startWidth > plotWidth - 4) startLeft = Math.max(4, plotWidth - startWidth - 4)

        let endLeft = left + width
        if (endLeft > plotWidth - 4) endLeft = plotWidth - 4
        if (endLeft < endWidth + 4) endLeft = endWidth + 4

        startLabel.style.top = '8px'
        endLabel.style.top = narrow ? '28px' : '8px'
        startLabel.style.left = `${startLeft}px`
        endLabel.style.left = `${endLeft}px`
      },
      setSelect: hide
    }
  }
}
