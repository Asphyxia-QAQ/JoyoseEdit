<template>
  <div class="stack">
    <div class="panel">
      <div class="panel-header">
        <h2>去除锁帧</h2>
        <button class="danger" @click="doApply" :disabled="state.loading || !hasBooster || !hasLockContent">去除锁帧</button>
        <button class="ghost" @click="rescan" :disabled="!canApply">重新扫描</button>
      </div>
      <div class="hint">
        一键清除 Joyose 云控里的帧率锁：关闭
        <code class="mono">cgame_enable</code>、删除
        <code class="mono">dynamic_fps_global</code>，并移除各游戏条目中的
        <code class="mono">dynamic_fps / PID 类</code>字段
        （<code class="mono">dynamic_fps</code>、<code class="mono">PID_T</code>、
        <code class="mono">PID_RE*</code> 等官方新增变体都会按前缀匹配清除），
        让设备不再按温度 / 场景强制压低帧率。改动仅作用于云控参数，不触碰其它配置。
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
                  {{ scan.cgameEnables ? '开启（锁帧生效）' : '已关闭' }}
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
import { toast } from '@/state/toast';
import { scanFpsLock, applyUnlockFps, type FpsLockScan } from '@/parsers/fpslock';

const booster = computed(() => state.cloudConfig.booster_config?.params ?? null);
const hasBooster = computed(() => booster.value !== null);

const scan = computed<FpsLockScan>(() =>
  booster.value !== null ? scanFpsLock(booster.value) : emptyScan(),
);

/** 是否检测到锁帧内容（cgame / dynamic_fps_global / PID* 等任一）。 */
const hasLockContent = computed(
  () => scan.value.totalKeys > 0 || scan.value.hasDynamicFpsGlobal,
);

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
  () => booster.value !== null && !state.loading,
);

function rescan() {
  // scan is computed off the reactive booster, nothing to cache — toast for feedback.
  toast.info('已重新扫描', `共 ${scan.value.totalKeys} 个锁帧字段`);
}

function doApply() {
  if (!booster.value) return;
  const result = applyUnlockFps(booster.value);
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