<script setup lang="ts">
import { ref } from 'vue'
import { logDebug } from '../debug'
import { useOutsideClick } from '../lib/useOutsideClick'

// A trigger button that opens a small options popover. Selecting an option
// always closes the popover and then runs that option's action — the two
// menus that used to duplicate this (SessionView's Invite menu, AccountHome's
// Account menu) each coded their own version, and only one of them actually
// worked reliably; this exists so there's one place that gets it right.
// Outside-click detection is scoped to this component's own root, not a
// page-wide area, so it can never race with unrelated panel-closing logic
// elsewhere on the page.
const props = defineProps<{ label: string; tone?: string }>()

const open = ref(false)
const root = ref<HTMLElement>()

function toggle() {
  open.value = !open.value
  logDebug(`MenuButton[${props.label}]: toggle -> open=${open.value}`)
}

function select(action: () => void) {
  logDebug(`MenuButton[${props.label}]: option selected, closing and running action`)
  open.value = false
  action()
}

useOutsideClick(root, () => {
  if (!open.value) return
  logDebug(`MenuButton[${props.label}]: outside click, closing`)
  open.value = false
})
</script>

<template>
  <div ref="root" class="menu-wrap">
    <button type="button" class="chip-ghost" :class="tone" @click.stop="toggle">{{ label }}</button>
    <div v-if="open" class="menu-pop">
      <slot :select="select" />
    </div>
  </div>
</template>

<style scoped>
.menu-wrap {
  position: relative;
}

.chip-ghost {
  padding: 0.28rem 0.65rem;
  min-height: 30px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.2;
}

.chip-ghost.tone-blue {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.menu-pop {
  position: absolute;
  top: calc(100% + 0.3rem);
  right: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  min-width: 10rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
</style>
