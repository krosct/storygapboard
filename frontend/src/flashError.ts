const FLASH_CLASS = 'error-flash'
const FLASH_DURATION_MS = 3000

/**
 * Navigate to `hash` (if provided and not already active), scroll to the first
 * element in `ids`, and flash all listed elements in red for 3 seconds.
 */
export function focusAndFlashError(ids: string[], hash?: string): void {
  const needsNav = Boolean(hash && window.location.hash !== hash)
  if (needsNav && hash) {
    window.location.hash = hash
  }

  const run = () => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' })
    for (const el of elements) {
      el.classList.remove(FLASH_CLASS)
      void el.offsetWidth
      el.classList.add(FLASH_CLASS)
    }
    window.setTimeout(() => {
      for (const el of elements) {
        el.classList.remove(FLASH_CLASS)
      }
    }, FLASH_DURATION_MS)
  }

  if (needsNav) {
    window.setTimeout(run, 360)
  } else {
    window.requestAnimationFrame(run)
  }
}
