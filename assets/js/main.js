import { App } from './app'
import { isLegacyDesign } from './design'
import { trackPinnedHeights } from './pin'

const app = new App()

document.addEventListener('DOMContentLoaded', () => {
  app.init()
  trackPinnedHeights()

  window.addEventListener('resize', function () {
    if (isLegacyDesign()) app.percentageBar.redraw()

    // Delegate to GraphDisplayManager which can check if the resize is necessary
    app.graphDisplayManager.requestResize()
    app.serverRegistry.resizeSparklines()
  }, false)
}, false)
