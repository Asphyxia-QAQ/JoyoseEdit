<template>
  <div class="stack">
    <div class="panel">
      <div class="panel-header">
        <h2>去除锁帧</h2>
        <button class="danger" @click="doApply" :disabled="state.loading || !hasBooster || !hasLockContent">去除锁帧</button>
        <button class="warn" @click="doLift" :disabled="state.loading || !hasBooster || !hasLiftContent">抬高阈值</button>
        <button class="ghost" @click="rescan" :disabled="!canApply">重新扫描</button>
      </div>
      <div class="hint">
        去除锁帧：一键清除 Joyose 云控里的帧率限制，关闭
        <code class="mono">cgame_enable</code>、移除
        <code class="mono">dynamic_fps_global</code> 与
        <code class="mono">dynamic_fps</code> / <code class="mono">PID</code> 类字段。<br />
        抬高阈值：将 <code class="mono">dynamic_fps*</code>，仅把其中的降帧温度
        抬到 90 ℃+ 级别（46.5→96.5、48→98…），<code class="mono">PID_*</code> 仍会移除。
      </div>

      <div v-if="!hasBooster" class="banner warn">
        <strong>未读取到 booster_config</strong>
        <span>请先在概览页点击刷新拉取设备云控。</span>
      </div>
      <template v-else>
        <table class="table" style="margin-top: var(--space-3)">
          <tbody>
            <tr>
              <td><strong>cgame_enable（云控游戏接管）</strong></td>
              <td>
                <span v-if="scan.cgameEnables === null" class="hint">字段不存在</span>
                <span v-else class="pill" :class="scan.cgameEnables ? 'warn' : 'ok'">
                  {{ scan.cgameEnables ? '开启' : '已关闭' }}
                </span>
              </td>
            </tr>
            <tr>
              <td><strong>dynamic_fps_global（全局动态帧率）</strong></td>
              <td>
                <span v-if="!scan.hasDynamicFpsGlobal" class="pill ok">不存在</span>
                <span v-else class="pill warn">存在（待删除）</span>
              </td>
            </tr>
            <tr>
              <td><strong>锁帧相关字段总数</strong></td>
              <td class="mono">
                <span :class="scan.totalKeys > 0 ? 'pill warn' : 'pill ok'">
                  {{ scan.totalKeys }}
                </span>
                <span v-if="scan.totalKeys > 0" class="hint"
                  >（dynamic_fps / PID 等，全树统计）</span
                >
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="scan.entries.length > 0" style="margin-top: var(--space-3)">
          <h3>携带锁帧字段的游戏条目</h3>
          <table class="table">
            <thead>
              <tr>
                <th>game_name</th>
                <th>将被移除的字段</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in scan.entries" :key="e.name">
                <td class="mono">{{ e.name }}</td>
                <td class="mono muted">{{ e.keys.join('、') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="hint" style="margin-top: var(--space-3)">
          点击后只在内存中生效，请在顶栏横幅点<strong>“提交到设备”</strong>完成写入。
          提交前会自动备份，也可到“编辑历史”随时回滚。
        </p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, markDirty } from '@/state/session';
import { getDataSourcePref } from '@/state/source';
import { toast } from '@/state/toast';
import {
  scanFpsLock,
  applyUnlockFps,
  applyLiftThermalFps,
  type FpsLockScan,
} from '@/parsers/fpslock';

/** 数据源可用性检测：默认仅 SmartP（smartpRaw）；允许 teg 兜底时用工作副本（含 teg 来源）。
 *  操作仍作用于工作副本。 */
const boosterSource = computed(() => {
  if (getDataSourcePref() === 'teg-fallback') return state.cloudConfig.booster_config?.params ?? null;
  return state.smartpRaw.booster_config ?? null;
});
const hasBooster = computed(() => boosterSource.value !== null);

const scan = computed<FpsLockScan>(() =>
  boosterSource.value !== null ? scanFpsLock(boosterSource.value) : emptyScan(),
);

/** 是否检测到锁帧内容（cgame / dynamic_fps_global / PID* 等任一）。 */
const hasLockContent = computed(
  () => scan.value.totalKeys > 0 || scan.value.hasDynamicFpsGlobal,
);

/** 是否有可“提温”的内容：树中必须存在 dynamic_fps*（含 _M/_T/global）才会有抬温对象。
 *  光有 PID_*（无 dynamic_fps）不属于本按钮职责（由“去除锁帧”处理），因此禁用。 */
const hasLiftContent = computed(() => {
  let dyn = 0;
  for (const [k, n] of Object.entries(scan.value.countByKey)) {
    if (k.startsWith('dynamic_fps')) dyn += n ?? 0;
  }
  return dyn > 0;
});

function emptyScan(): FpsLockScan {
  return {
    cgameEnables: null,
    hasDynamicFpsGlobal: false,
    totalKeys: 0,
    countByKey: {},
    entries: [],
  };
}

const canApply = computed(
  () => boosterSource.value !== null && !state.loading,
);

function rescan() {
  // scan is computed off the reactive booster, nothing to cache — toast for feedback.
  toast.info('已重新扫描', `共 ${scan.value.totalKeys} 个锁帧字段`);
}

function doLift() {
  if (!state.cloudConfig.booster_config) return;
  const result = applyLiftThermalFps(state.cloudConfig.booster_config.params);
  markDirty();
  if (!result.changed) {
    toast.info('无可提温 / 删除内容', 'dynamic_fps* 与 PID_* 均未发现');
    return;
  }
  const parts: string[] = [];
  if (result.liftedKeys.length) parts.push(`提温 ${result.liftedKeys.length} 个 dynamic_fps 字段`);
  const keySummary = Object.entries(result.removedByKey)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  if (keySummary) parts.push(keySummary);
  toast.success('已抬高阈值（待提交）', parts.join('；'));
}

function doApply() {
  if (!state.cloudConfig.booster_config) return;
  const result = applyUnlockFps(state.cloudConfig.booster_config.params);
  markDirty();
  if (!result.changed) {
    toast.info('未发现可清除的锁帧内容', '当前云控已经很“干净”了');
    return;
  }
  const parts: string[] = [];
  if (result.cgameDisabled) parts.push('cgame_enable → false');
  if (result.globalDfRemoved) parts.push('dynamic_fps_global 已删除');
  const keySummary = Object.entries(result.removedByKey)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' ');
  if (keySummary) parts.push(keySummary);
  toast.success(
    '已去除锁帧（待提交）',
    `影响 ${result.entriesAffected} 个游戏条目 · ${parts.join('；')}`,
  );
}
</script>