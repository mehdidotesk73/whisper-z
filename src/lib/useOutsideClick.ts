import { onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'

/**
 * Fires `onOutside` only when a click's entire gesture — the mousedown that
 * started it, not just the (possibly synthetic) trailing click — began
 * outside `root`. Mobile Safari can synthesize an extra `click` shortly
 * after one whose handler removed the tapped element from the DOM (e.g. a
 * menu item that closes its own popover on selection), retargeted to
 * whatever's now underneath — often something outside `root`, like a modal
 * backdrop that opened as a result of that same tap. That ghost click has no
 * mousedown of its own, since the real one already fired against the
 * original (now-removed) element; requiring both keeps it from being
 * mistaken for a real click outside, which would otherwise close whatever
 * that same tap had just opened.
 */
export function useOutsideClick(root: Ref<HTMLElement | undefined>, onOutside: () => void) {
  let downOutside = false

  function onDown(e: MouseEvent) {
    downOutside = !!(root.value && !root.value.contains(e.target as Node))
  }

  function onClick(e: MouseEvent) {
    if (downOutside && root.value && !root.value.contains(e.target as Node)) onOutside()
  }

  onMounted(() => {
    document.addEventListener('mousedown', onDown)
    document.addEventListener('click', onClick)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('click', onClick)
  })
}
