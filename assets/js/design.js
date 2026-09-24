export const DESIGN_STORAGE_KEY = 'minetrack_design'

export function isLegacyDesign () {
  return document.documentElement.getAttribute('data-design') === 'old'
}

export function bindDesignSwitcher () {
  const current = isLegacyDesign() ? 'old' : 'new'

  document.querySelectorAll('[data-design-choice]').forEach((button) => {
    const choice = button.getAttribute('data-design-choice')
    const active = choice === current

    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')

    button.addEventListener('click', () => {
      if (choice !== 'new' && choice !== 'old') return
      if (choice === current) return

      try {
        localStorage.setItem(DESIGN_STORAGE_KEY, choice)
      } catch (err) {
        // QuotaExceededError, or SecurityError when storage is blocked.
        // The boot script only reads localStorage, so a failed write cannot switch designs.
        return
      }

      window.location.reload()
    })
  })
}
