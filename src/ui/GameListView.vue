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
      <strong>common_config 未下发（不可编辑）</strong>
      <span class="hint">当前 SmartP 与 teg_config 都没有 common_config，游戏列表暂不可编辑。
        请等待官方云控下发 common_config 后再配置；为确保数据完整，
        <strong>模块在此情况下不会向 common_config 写入任何内容</strong>。</span>
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
import { state, markDirty } from '@/state/session';
import PackageListEditor from './PackageListEditor.vue';

const gameList = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.game_list ?? [];
});
const supportApp = computed<string[]>(() => {
  return state.cloudConfig.common_config?.params?.support_app ?? [];
});

const hasCommon = computed(() => !!state.cloudConfig.common_config);

function update(key: 'game_list' | 'support_app', next: string[]) {
  const cc = state.cloudConfig.common_config;
  // 两库都无 common_config → 不可编辑：绝不创建/写入，保持数据一致
  if (!cc) return;
  if (!cc.params) cc.params = {};
  cc.params[key] = next;
  markDirty();
}
</script>
