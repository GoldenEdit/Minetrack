// Publishes the heights of the pinned top bar and graph as CSS variables,
// so the list header can pin right below the graph and scroll targets clear both
export function trackPinnedHeights () {
  const root = document.documentElement
  const topbar = document.querySelector('[data-design-root="new"] .topbar')
  const pin = document.getElementById('graph-pin')
  if (!topbar || !pin) return

  const update = () => {
    // On phones the brand row scrolls away (negative sticky top), so only the part that stays counts
    const top = parseFloat(getComputedStyle(topbar).top) || 0
    const topbarPinned = Math.max(0, topbar.offsetHeight + top)
    const pinned = getComputedStyle(pin).position === 'sticky' && !pin.hidden

    root.style.setProperty('--pin-top', `${topbarPinned}px`)
    root.style.setProperty('--graph-pin-height', pinned ? `${pin.offsetHeight}px` : '0px')
  }

  update()

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(update)
    observer.observe(topbar)
    observer.observe(pin)
  }

  // The media query that turns pinning on or off does not always change either element's size
  window.addEventListener('resize', update, false)
}
