<template>
  <div class="stack">
    <div class="panel">
      <div class="panel-header">
        <h2>去除插帧温度限制</h2>
        <button class="ghost" @click="rescan" :disabled="!hasBooster">重新扫描</button>
      </div>
      <div class="hint">
        一键把云控里所有<strong>插帧 / 超分温度阈值</strong>抬到 ~90°C
        （45#43#43#41 → 95#93#93#91），设备基本不会再因发热而降档。
        覆盖 <code class="mono">novatek_game_params</code>、
        <code class="mono">frc_game_params</code>、
        <code class="mono">game_mifisr_config</code>、
        <code class="mono">extra_params</code> /
        <code class="mono">novatek_non_playing_config</code> 等所有字符串配置；
        只改<strong>连续的温度组</strong>，不会碰帧率数字（60/120/144 等）。
      </div>

      <div v-if="!hasBooster" class="banner warn">
        <strong>未读取到 booster_config</strong>
        <span>请先在概览页点击刷新拉取设备云控。</span>
      </div>
      <template v-else>
        <table class="table" style="margin-top: var(--space-3)">
          <tbody>
            <tr>
              <td><strong>命中温度组字段</strong></td>
              <td class="mono"><span class="pill" :class="scan.fieldsAffected ? 'warn' : 'ok'">{{ scan.fieldsAffected }}</span></td>
            </tr>
            <tr>
              <td><strong>分布</strong></td>
              <td class="hint" v-if="!scan.fieldsAffected">暂无（云控里没有可识别的温度组）</td>
              <td v-else class="mono">{{ fieldSummary }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="uniqueGroups.length" style="margin-top: var(--space-3)">
          <h3>本机温度组</h3>
          <div class="stack">
            <span v-for="(g, i) in uniqueGroups" :key="i" class="mono"
              :style="{ color: applied ? 'var(--ok-color, #2e9e5b)' : undefined }">
              {{ g }}
            </span>
          </div>
        </div>

        <div class="btn-row" style="margin-top: var(--space-3)">
          <button class="danger" @click="doApply" :disabled="state.loading || !scan.fieldsAffected">
            {{ scan.fieldsAffected ? '去除全部插帧温度限制' : '（未发现温度限制）' }}
          </button>
        </div>
        <p class="hint" style="margin-top: var(--space-2)">
          点击后只在内存中生效，请在顶栏横幅点<strong>“提交到设备”</strong>完成写入。
          提交前会自动备份，也可到“编辑历史”回滚。
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { state, markDirty } from '@/state/session';
import { toast } from '@/state/toast';
import {
  scanThermalUnlock,
  applyThermalUnlock,
  findTempGroups,
  type ThermalScan,
} from '@/parsers/thermal-unlock';

const booster = computed(() => state.cloudConfig.booster_config?.params ?? null);
const hasBooster = computed(() => booster.value !== null);

const scan = computed<ThermalScan>(() =>
  booster.value !== null ? scanThermalUnlock(booster.value) : emptyScan(),
);

function emptyScan(): ThermalScan {
  return { fieldsAffected: 0, groupsTotal: 0, byField: {}, examples: [] };
}

/** 扫描本机所有字符串，收集去重后的温度组（每组显示一次）。 */
const uniqueGroups = computed<string[]>(() => {
  const set = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach(walk);
    } else if (typeof node === 'string') {
      for (const g of findTempGroups(node)) set.add(g.raw);
    }
  };
  if (booster.value) walk(booster.value);
  return [...set].slice(0, 12);
});

const fieldSummary = computed(() =>
  Object.entries(scan.value.byField)
    .map(([k, n]) => `${k}×${n}`)
    .join('  '),
);

function rescan() {
  applied.value = false;
  toast.info('已重新扫描', `命中 ${scan.value.fieldsAffected} 个字段`);
}

const applied = ref(false);

function doApply() {
  if (!booster.value) return;
  const result = applyThermalUnlock(booster.value);
  markDirty();
  applied.value = true;
  if (!result.changed) {
    toast.info('未发现可抬升的温度组', '当前云控已经很“凉快”了');
    return;
  }
  const parts = Object.entries(result.liftedByField)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  toast.success(
    '已去除插帧温度限制（待提交）',
    `抬升 ${result.groupsTotal} 组 · ${parts}`,
  );
}
</script>