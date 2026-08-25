<template>
  <div class="panel" style="margin: 0; background: var(--bg-elevated)">
    <div class="label">{{ label }}</div>
    <div class="grid-2" style="margin-bottom: 8px">
      <div class="field">
        <label class="label">minFps</label>
        <input v-model="segment.minFps" @input="emitChange" />
      </div>
      <div class="field">
        <label class="label">targetFps</label>
        <input v-model="segment.targetFps" @input="emitChange" />
      </div>
    </div>
    <div class="field" style="margin-bottom: 8px">
      <label class="label">CSV ({{ segment.csv.length }} slots)</label>
      <textarea
        :value="segment.csv.join(',')"
        @change="onCsvChange"
        rows="3"
        style="font-family: var(--font-mono); font-size: 12px"
      />
      <div class="tiny muted">
        常见 hex：<span class="mono">0x2114</span> / <span class="mono">0x2414</span> 模式位、
        <span class="mono">0x55 / 0x66 / 0x77</span> 锐化、
        <span class="mono">0x222 / 0x535 / 0x717</span> 色彩矩阵
      </div>
    </div>
    <div class="grid-4">
      <div class="field">
        <label class="label">T1</label>
        <input v-model="segment.t1" @input="emitChange" />
      </div>
      <div class="field">
        <label class="label">T2</label>
        <input v-model="segment.t2" @input="emitChange" />
      </div>
      <div class="field">
        <label class="label">T3</label>
        <input v-model="segment.t3" @input="emitChange" />
      </div>
      <div class="field">
        <label class="label">T4</label>
        <input v-model="segment.t4" @input="emitChange" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface SegmentShape {
  minFps: string;
  targetFps: string;
  csv: string[];
  t1: string;
  t2: string;
  t3: string;
  t4: string;
}

const props = defineProps<{ label: string; segment: SegmentShape }>();
const emit = defineEmits<{ (e: 'change'): void }>();

function emitChange() {
  emit('change');
}

function onCsvChange(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value;
  props.segment.csv = value.split(',').map((s) => s.trim());
  emit('change');
}
</script>
