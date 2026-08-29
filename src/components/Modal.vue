<script setup lang="ts">
import { watch } from 'vue'
import { logDebug } from '../debug'

const props = defineProps<{ open: boolean; title?: string }>()
const emit = defineEmits<{ close: [] }>()

watch(
  () => props.open,
  (v) => logDebug(`Modal[${props.title ?? '(untitled)'}]: open=${v}`),
)
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-box" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2 v-if="title" class="modal-title">{{ title }}</h2>
        <button class="modal-close" aria-label="Close" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 200;
}

@media (min-width: 640px) {
  .modal-backdrop {
    align-items: center;
    padding: 1rem;
  }
}

.modal-box {
  width: 100%;
  max-width: 28rem;
  max-height: 85vh;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.75rem 0.75rem 0 0;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

@media (min-width: 640px) {
  .modal-box {
    border-radius: 0.75rem;
  }
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.modal-title {
  margin: 0;
  font-size: 1rem;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  padding: 0.25rem 0.5rem;
  min-height: 44px;
  min-width: 44px;
}

.modal-close:hover {
  color: var(--text);
}
</style>
