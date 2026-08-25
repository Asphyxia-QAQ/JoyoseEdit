<template>
  <div class="stack">
    <div class="panel">
      <h2>冻结 Joyose 云控（推荐）</h2>
      <div class="hint" style="margin-bottom: var(--space-3)">
        Joyose 的游戏配置来自 MIUI 云控，大约每 13 分钟自动拉取一次并覆盖本地。
        冻结后设备端将永远声称"已是最新版本"，云端不再下发任何规则，本模块改动可长期保留。
      </div>

      <div v-if="tegLoading" class="hint">正在读取云控状态…</div>
      <div v-else-if="!tegState.exists" class="banner warn">
        <strong>云控 SDK 尚未初始化</strong>
        <span class="hint">先在顶栏点一次保存，Joyose 启动后再回来这里冻结即可。</span>
      </div>
      <div v-else>
        <table class="table">
          <tbody>
            <tr>
              <td>配置路径</td>
              <td class="mono">{{ tegState.path }}</td>
            </tr>
            <tr>
              <td>云控基准版本</td>
              <td class="mono">
                <span :class="tegState.frozen ? 'pill warn' : ''">{{ tegState.pref_local_max_version }}</span>
              </td>
            </tr>
            <tr>
              <td>当前状态</td>
              <td>
                <span v-if="tegState.frozen" class="pill warn">已冻结（云控永不覆盖）</span>
                <span v-else class="hint">未冻结（云控会按正常周期覆盖）</span>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="btn-row" style="margin-top: var(--space-3)">
          <button v-if="!tegState.frozen" class="primary" @click="doFreeze" :disabled="busy">冻结云控</button>
          <button v-else class="ghost" @click="doUnfreeze" :disabled="busy">解冻（恢复云控）</button>
          <button class="ghost" @click="refresh" :disabled="busy">刷新状态</button>
        </div>
        <p class="hint" style="margin-top: var(--space-2)">
          冻结 / 解冻会先停掉一次 Joyose 进程以刷新缓存。
          <strong>副作用：</strong>冻结期间所有走 MIUI 云控的模块都不会更新，想恢复请点解冻。
        </p>
      </div>
    </div>

    <div class="panel">
      <h2>DB 版本锁 <small>辅助手段</small></h2>
      <div class="hint" style="margin-bottom: var(--space-3)">
        把 DB 里的版本字段改为 2099 开头。<strong>实测有效的防覆盖方式是上面的冻结云控</strong>；
        此处仅作辅助，便于观察 version 分布和应对少数旁路读取。
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>配置名</th>
            <th>云控版本</th>
            <th>参数头版本</th>
            <th>规则版本</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(cfg, name) in state.cloudConfig" :key="name"
            :style="cfg.meta?.empty ? 'opacity: .55' : ''">
            <td><strong class="mono">{{ name }}</strong>
              <span v-if="cfg.meta?.empty" class="hint">（空配置）</span></td>
            <td class="mono">
              <span v-if="cfg.meta?.empty" class="hint">（空）</span>
              <span v-else :class="isLocked(cfg.meta.version) ? 'pill warn' : ''">
                {{ cfg.meta.version ?? '—' }}
              </span>
            </td>
            <td class="mono">{{ cfg.meta?.empty ? '（空）' : (cfg.params?.header?.version ?? '—') }}</td>
            <td class="mono">
              <span v-if="cfg.meta?.empty" class="hint">（空）</span>
              <template v-else>
                <span v-for="(rv, ri) in ruleVersionList(name)" :key="ri"
                  :style="rv.old ? 'text-decoration: line-through; opacity: .55' : ''">
                  {{ rv.v }}<template v-if="ri < ruleVersionList(name).length - 1">, </template>
                </span>
                <span v-if="ruleVersionList(name).length === 0" class="muted">（rules 表为空）</span>
              </template>
            </td>
            <td>
              <button v-if="!isLocked(cfg.meta.version) && !cfg.meta?.empty" class="primary" @click="lock(String(name))"
                :disabled="state.loading">锁定</button>
              <button v-else-if="!cfg.meta?.empty" class="ghost" @click="unlock(String(name))" :disabled="state.loading">还原 version</button>
              <span v-else class="hint">—</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="btn-row" style="margin-top: var(--space-3)">
        <button class="primary" @click="lockAll" :disabled="state.loading">全部锁定</button>
        <button @click="bumpOnly" :disabled="state.loading">仅刷大版本（保留后 4 位）</button>
      </div>
      <p class="hint" style="margin-top: var(--space-2)">
        "全部锁定" 会把所有配置的版本前 4 位改成 <strong>2099</strong>，保留后 4 位。
        锁定只针对当前版本（云控版本列）；<span style="text-decoration: line-through">划掉的版本号</span>
        为<strong>旧版本</strong>配置，不属于锁定对象，仍会保留在历史中。
        此操作仅在内存中生效，需在顶栏点保存提交到设备。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { state, lockCloudVersion, unlockCloudVersion, markDirty } from '@/state/session';
import { toast } from '@/state/toast';
import * as bridge from '@/root/bridge';

function isLocked(v: unknown): boolean {
  return typeof v === 'number' && String(v).startsWith('2099');
}

interface RuleVersionItem { v: string; old: boolean }

/** teg 历史版本列表：以 envelope.version 显示，相对“当前云控版本”更旧的标为 old
 *  （UI 划线），当前版本也一并展示（与“云控版本”列同值属正常）。同一版本多行去重。 */
function ruleVersionList(name: string | number): RuleVersionItem[] {
  const rows = state.rulesByModule[String(name)] ?? [];
  if (rows.length === 0) return [];
  const base = Number(state.cloudConfig[String(name)]?.meta?.version ?? 0);
  const seen = new Set<number>();
  const out: RuleVersionItem[] = [];
  for (const r of rows) {
    // 只用 envelope.version（YYYYMMDDxx 体系）；缺失就不展示，绝不用 rule_version。
    const envV = (r.content as any)?.version;
    const v = typeof envV === 'number' && envV > 0 ? envV : 0;
    if (!v || seen.has(Number(v))) continue;
    seen.add(Number(v));
    out.push({ v: String(v), old: Number(v) < base });
  }
  return out;
}

function lock(name: string) {
  const newV = lockCloudVersion(name);
  markDirty();
  toast.success('已锁定（待提交到设备）', `${name} → version ${newV}`);
}

function unlock(name: string) {
  const cc = state.cloudConfig[name] as any;
  const cur = Number(cc?.meta?.version ?? 0);
  const raw = cc?.meta?.originalVersion ?? cur;
  const restored = Number(raw);
  unlockCloudVersion(name, restored);
  markDirty();
  toast.warn('已还原版本（待提交）', `${name} → ${restored}；下一次云控下发可能覆盖`);
}

function lockAll() {
  const skipped: string[] = [];
  const names = Object.keys(state.cloudConfig);
  if (names.length === 0) {
    toast.info('没有可锁定的云控配置', '检测不到 booster_config / common_config');
    return;
  }
  for (const name of names) {
    try {
      lockCloudVersion(name);
    } catch {
      // 该配置 SmartP 与 teg 均无有效版本号（如空 teg 的 common_config），跳过
      skipped.push(name);
    }
  }
  markDirty();
  if (skipped.length) {
    toast.warn('已锁定其余配置', `跳过（无有效版本）：${skipped.join('、')}`);
  } else {
    toast.success('全部配置版本已刷到 2099 开头（待提交）');
  }
}

function bumpOnly() {
  lockAll();
}

const tegState = reactive<bridge.TegStatus>({ ok: true, exists: false, path: '' });
const tegLoading = ref(true);
const busy = ref(false);

async function refresh() {
  tegLoading.value = true;
  try {
    const s = await bridge.tegStatus();
    Object.assign(tegState, s);
  } catch (err) {
    toast.error('读取云控状态失败', (err as Error).message);
  } finally {
    tegLoading.value = false;
  }
}

async function doFreeze() {
  busy.value = true;
  try {
    await bridge.tegFreeze();
    toast.success('云控已冻结', 'Joyose 已重启，后续云端下发不会覆盖本地改动');
    await refresh();
  } catch (err) {
    toast.error('冻结失败', (err as Error).message);
  } finally {
    busy.value = false;
  }
}

async function doUnfreeze() {
  busy.value = true;
  try {
    await bridge.tegUnfreeze();
    toast.warn('云控已解冻', '下一次云控拉取可能覆盖本地改动');
    await refresh();
  } catch (err) {
    toast.error('解冻失败', (err as Error).message);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  if (state.connected) void refresh();
  else tegLoading.value = false;
});
</script>
