import { useEffect } from 'react'

/** Keep keyboard focus in the top dialog and restore its invoking control. */
export function useDialogFocus(): void {
  useEffect(() => {
    let current: HTMLElement | null = null
    let previous: HTMLElement | null = null
    let inerted: HTMLElement[] = []
    const focusables = (dialog: HTMLElement): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
    )).filter((el) => el.getClientRects().length > 0)
    const sync = (): void => {
      const dialogs = document.querySelectorAll<HTMLElement>('.modal-backdrop .modal')
      const next = dialogs.item(dialogs.length - 1)
      if (next === current) return
      inerted.forEach((el) => { el.inert = false }); inerted = []
      if (!next) {
        current = null
        if (previous?.isConnected) previous.focus()
        previous = null
        return
      }
      if (!current) previous = document.activeElement as HTMLElement
      current = next
      current.setAttribute('role', 'dialog')
      current.setAttribute('aria-modal', 'true')
      if (!current.getAttribute('aria-label')) current.setAttribute('aria-label', current.querySelector('h2')?.textContent ?? '弹窗')
      current.tabIndex = -1
      const overlay = current.closest('.modal-backdrop')!
      for (const sibling of Array.from(overlay.parentElement?.children ?? [])) {
        if (sibling !== overlay && sibling instanceof HTMLElement && !sibling.inert) { sibling.inert = true; inerted.push(sibling) }
      }
      if (!current.contains(document.activeElement)) (focusables(current)[0] ?? current).focus()
    }
    const trap = (event: KeyboardEvent): void => {
      if (!current || event.key !== 'Tab') return
      const items = focusables(current)
      const first = items[0] ?? current
      const last = items[items.length - 1] ?? current
      if (event.shiftKey && (document.activeElement === first || !current.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !current.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('keydown', trap, true)
    return () => { observer.disconnect(); document.removeEventListener('keydown', trap, true); inerted.forEach((el) => { el.inert = false }) }
  }, [])
}
