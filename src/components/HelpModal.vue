<script setup lang="ts">
import { ref, computed } from 'vue'
import overviewDoc from '../../docs/concepts/overview.md?raw'

interface Props {
  open: boolean
  initialDoc?: string
}

interface Emits {
  (e: 'close'): void
}

defineProps<Props>()
defineEmits<Emits>()

const docs: Record<string, string> = {
  overview: overviewDoc,
}
const currentDoc = ref('overview')

const currentDocContent = computed(() => docs[currentDoc.value] || docs['overview'] || '')
const docKeys = computed(() => Object.keys(docs))
</script>

<template>
  <div v-if="open" class="modal-overlay" @click="$emit('close')">
    <div class="modal-content" @click.stop>
      <button class="close-btn" @click="$emit('close')" aria-label="Close">✕</button>

      <div class="modal-body">
        <div class="doc-content">
          <div v-html="formatMarkdown(currentDocContent)" class="markdown"></div>
        </div>

        <div v-if="docKeys.length > 1" class="doc-tabs">
          <button
            v-for="key in docKeys"
            :key="key"
            :class="{ active: currentDoc === key }"
            class="tab-btn"
            @click="currentDoc = key"
          >
            {{ formatTabName(key) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
// Simple markdown to HTML converter
function formatInline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

function formatMarkdown(md: string): string {
  return md
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1>${formatInline(line.slice(2))}</h1>`
      if (line.startsWith('## ')) return `<h2>${formatInline(line.slice(3))}</h2>`
      if (line.startsWith('- ')) return `<li>${formatInline(line.slice(2))}</li>`
      if (line.startsWith('`')) return `<code>${line.slice(1, -1)}</code>`
      if (line.startsWith('---')) return '<hr>'
      return line ? `<p>${formatInline(line)}</p>` : ''
    })
    .join('')
}

function formatTabName(key: string): string {
  return key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal-content {
  position: relative;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  max-width: 50rem;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.close-btn {
  position: absolute;
  top: 0.8rem;
  right: 0.8rem;
  z-index: 101;
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0.25rem;
}

.close-btn:hover {
  color: var(--text);
}

.modal-body {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex: 1;
}

.doc-content {
  flex: 1;
  overflow: auto;
  padding: 1.5rem;
}

.markdown {
  font-size: 0.95rem;
  line-height: 1.6;
}

.markdown h1 {
  font-size: 1.5rem;
  margin: 0 0 1rem 0;
  color: var(--text);
}

.markdown h2 {
  font-size: 1.2rem;
  margin: 1rem 0 0.5rem 0;
  color: var(--text);
}

.markdown p {
  margin: 0.5rem 0;
  color: var(--text);
}

.markdown code {
  background: var(--bg-elev-2);
  padding: 0.2rem 0.4rem;
  border-radius: 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.9em;
}

.markdown li {
  margin-left: 1.5rem;
  color: var(--text);
}

.doc-tabs {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--bg-elev-2);
  overflow: auto;
}

.tab-btn {
  padding: 0.5rem 1rem;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.85rem;
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--text);
  border-color: var(--accent-blue);
}

.tab-btn.active {
  background: var(--accent-blue);
  color: white;
  border-color: var(--accent-blue);
}

@media (max-width: 30rem) {
  .modal-overlay {
    padding: 0;
  }

  .modal-content {
    max-width: 100%;
    max-height: 100%;
    border-radius: 0;
  }

  .doc-content {
    padding: 1rem;
  }
}
</style>
