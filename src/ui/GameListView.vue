<template>
  <div class="stack">
    <div class="panel">
      <h2>游戏列表 <small>纳入优化 / 支持</small></h2>
      <div class="hint">
        Joyose 根据这两个列表决定是否应用游戏策略。
        <span class="mono">game_list</span>：正式纳入优化；
        <span class="mono">support_app</span>：更宽泛的支持列表。
      </div>
    </div>

    <div v-if="!hasCommon" class="banner warn">
      <strong>SmartP 未检测到 common_config</strong>
      <span class="hint">SmartP 中没有 common_config 时，此页面暂不可用。可在概览页查看云控状态，或等待官方下发后刷新。</span>
    </div>
    <div v-else class="grid-2">
      <PackageListEditor title="game_list" :packages="gameList" @update="(v: string[]) => update('game_list', v)" />
      <PackageListEditor title="support_app" :packages="supportApp"
        @update="(v: string[]) => update('support_app', v)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { state, markDirty, sourceUsable } from '@/state/session';
import PackageListEditor from './PackageListEditor.vue';

const gameList = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.game_list ?? [];
});
const supportApp = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.support_app ?? [];
});

/** 数据源可用性：默认仅 SmartP；允许 teg 兜底时工作副本有 common_config 即可用。 */
const hasCommon = computed(() => sourceUsable('common_config'));

function update(key: 'game_list' | 'support_app', next: string[]) {
  // 数据源不可用 → 不可编辑：绝不创建/写入
  if (!sourceUsable('common_config')) return;
  const cc = state.cloudConfig.common_config;
  if (!cc) return;
  if (!cc.params) cc.params = {};
  cc.params[key] = next;
  markDirty();
}
</script>
