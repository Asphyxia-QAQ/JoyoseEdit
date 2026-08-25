<template>
  <div class="stack">
    <div v-if="noCloudConfig" class="banner warn">
      <strong>未检测到 Joyose 云控配置</strong>
      <span class="hint">SmartP 与 teg_config 中都没有 booster_config / common_config。
        请先让 Joyose 联网下发一次云控（或打开一次游戏工具箱），再点“刷新”重新拉取；
        也可以在「JSON 编辑」里直接写入配置。</span>
    </div>
    <div v-else-if="noBoosterWithCommon" class="banner warn">
      <strong>booster_config 未下发（插帧 / 独显相关暂不可用）</strong>
      <span class="hint">已读取到 common_config，但两库都没有 booster_config。
        插帧 / 独显 / 锁帧等页面会保持空态；可在「JSON 编辑 → cloud_config.booster_config.params」
        手动写入，或等待官方云控下发后点“刷新”。</span>
    </div>

    <div class="panel">
      <div class="panel-header">
        <h2>概览</h2>
        <button class="ghost" @click="handleRefresh" :disabled="state.loading">刷新</button>
        <button class="danger ghost" @click="handleResetCloud" :disabled="state.loading">重置云控</button>
        <button class="primary" @click="handleBackup" :disabled="state.loading">立即备份</button>
      </div>
      <div class="hint">
        目标包：<span class="mono">{{ state.stat?.pkg ?? 'com.xiaomi.joyose' }}</span><br>
        数据目录：<span class="mono">{{ state.stat?.data_root ?? '/data/adb/joyose-edit' }}</span>
      </div>
      <div class="grid-2" style="margin-top: var(--space-3)">
        <DbStatCard label="SmartP.db" :stat="state.stat?.smartp" />
        <DbStatCard label="teg_config.db" :stat="state.stat?.teg" />
      </div>
    </div>

    <div class="panel">
      <h2>路径识别 <small>按设备实际 DB 自适应</small></h2>
      <table class="table">
        <thead>
          <tr>
            <th>路径</th>
            <th>状态</th>
            <th class="num">条目</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in state.paths" :key="p.id">
            <td><strong>{{ pathLabel(p.id) }}</strong></td>
            <td>
              <span class="pill" :class="p.active ? 'ok' : 'off'">
                {{ p.active ? '已激活' : '未下发' }}
              </span>
            </td>
            <td class="num mono">{{ p.count }}</td>
            <td class="muted">{{ p.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>云控版本 <small>来源对比</small></h2>
      <div class="grid-2">
        <div v-for="(cfg, name) in state.cloudConfig" :key="name" class="stack">
          <div class="row">
            <strong class="mono">{{ name }}</strong>
            <span class="pill" :class="isLocked(cfg.meta.version) ? 'warn' : ''">
              当前: {{ currentLabel(cfg, name) }}
            </span>
          </div>
          <div v-for="ln in sourceNoteLines(cfg, name)" :key="ln.k" class="hint mono" style="margin-top: var(--space-1)">
            {{ ln.k }}：{{ ln.v ? ln.v + ' ' : '' }}<template v-if="ln.mark"><span class="muted">{{ ln.mark }}</span></template>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>云控版本来源</h2>
      <div class="hint">
        同一份云控在 SmartP.db 与 teg_config.db 中各有一份，官方更新 / 修 bug 时两边版本可能
        不同步。<strong>“自动”会读取版本号较新的一份（推荐）</strong>；改动最终会写回两份 DB 保持一致。
        若 teg_config.db 里没有对应条目，则该项固定使用 SmartP.db。
      </div>
      <div class="stack" style="margin-top: var(--space-2)">
        <div v-if="cfgPresent('booster_config')" class="row" style="gap: var(--space-2)">
          <span class="label" style="min-width: 128px">booster_config</span>
          <span v-if="sourceSingle('booster_config')" class="hint mono">{{ sourceSingleLabel('booster_config') }}（不可修改）</span>
          <select v-else-if="canChangeSource('booster_config')" v-model="sourcePref" @change="onSourceChange">
            <option v-for="opt in sourceOptions('booster_config')" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <span v-else class="hint">两库均无此配置</span>
        </div>
        <div v-if="cfgPresent('common_config')" class="row" style="gap: var(--space-2)">
          <span class="label" style="min-width: 128px">common_config</span>
          <span v-if="sourceSingle('common_config')" class="hint mono">{{ sourceSingleLabel('common_config') }}（不可修改）</span>
          <select v-else-if="canChangeSource('common_config')" v-model="commonPref" @change="onCommonSourceChange">
            <option v-for="opt in sourceOptions('common_config')" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <span v-else class="hint">两库均无此配置</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>覆写逻辑 <small>全局生效</small></h2>
      <div class="hint">
        提交时默认<strong>同时修改</strong> SmartP.db 与 teg_config.db；可选只改其中一份（另一份保持
        云端原始内容）。此设置对<strong>所有页面</strong>生效——普通编辑、DB 版本锁、去除锁帧、温度解锁
        等的“提交到设备”都会按此目标写入。
      </div>
      <select v-model="writeTarget" @change="onWriteTargetChange" style="margin-top: var(--space-2)">
        <option v-for="(label, v) in WRITE_TARGET_LABELS" :key="v" :value="v">{{ label }}</option>
      </select>
      <div class="hint" style="margin-top: var(--space-1)">
        全新安装 / 卸载后重装会自动回到默认“同时写”；升级更新保留你的选择。
      </div>
    </div>

    <div class="panel">
      <h2>备份</h2>
      <div class="hint">
        已有备份：<strong>{{ state.stat?.backup_count ?? 0 }}</strong> 份　·
        已有历史：<strong>{{ state.stat?.history_count ?? 0 }}</strong> 条
      </div>
      <div class="btn-row" style="margin-top: var(--space-2);">
        <button @click="handleBackup">立即备份</button>
        <button class="danger" @click="handleRevertLatest">回滚到最近备份</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { state, pullAll, refreshStat, recordBackupCheckpoint } from '@/state/session';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';
import * as bridge from '@/root/bridge';
import DbStatCard from './DbStatCard.vue';
import {
  getBoosterSourcePref,
  setBoosterSourcePref,
  getCommonSourcePref,
  setCommonSourcePref,
  getWriteTarget,
  setWriteTarget,
  PREF_LABELS,
  WRITE_TARGET_LABELS,
  type BoosterSourcePref,
  type WriteTarget,
} from '@/state/source';

function pathLabel(id: string): string {
  switch (id) {
    case 'mifisr': return 'MIFISR'
    case 'qualcomm': return '高通 GPU';
    case 'novatek': return 'Novatek 独显';
    case 'mivk': return 'MIVK (Vulkan)';
    case 'migl': return 'MIGL (OpenGL)';
    default: return id;
  }
}

function isLocked(v: unknown): boolean {
  return typeof v === 'number' && String(v).startsWith('2099');
}

/** SmartP 与 teg 两库都没有 booster_config / common_config（含从 teg 兜底后仍无）时
 *  显示引导提示。 */
const noCloudConfig = computed(
  () => !state.cloudConfig.booster_config && !state.cloudConfig.common_config,
);

/** 仅有 common_config（允许空配置行存在）、两库都无 booster_config 行 → 插帧不可用。 */
const noBoosterWithCommon = computed(
  () => !!state.cloudConfig.common_config && !state.cloudConfig.booster_config,
);

/** 两行展示 SmartP.db / teg_config.db 各自的版本，并标注当前沿用的是哪个来源。
 *  common_config 的 SmartP 侧官方没有版本号（2024010101 只是模块写 teg 的兜底值），
 *  因此该行显示为“—”，避免误导。 */
interface SourceLine { k: string; v: string; mark: string }

function sourceNoteLines(cfg: any, name: string): SourceLine[] {
  const sp = Number(cfg.meta?.smartpVersion ?? 0);
  const tg = Number(cfg.meta?.tegVersion ?? 0);
  // _real：两库真实存在该配置才允许标注“← 当前”；空配置（empty）也不标注。
  const isReal = cfg.meta?._real === true && !cfg.meta?.empty;
  const empty = !!cfg.meta?.empty;
  const src = isReal ? (cfg.meta?.source as 'smartp' | 'teg' | undefined) : undefined;
  const isCommon = name === 'common_config';
  return [
    {
      k: 'SmartP',
      // 空配置 / common_config 的 SmartP 侧无版本号 → 不显示数字
      v: empty || isCommon ? '' : sp ? String(sp) : '',
      mark: src === 'smartp' ? '← 当前' : '',
    },
    { k: 'teg', v: empty ? '' : tg ? String(tg) : '', mark: src === 'teg' ? '← 当前' : '' },
  ];
}

/** “当前:”列：common_config 用 SmartP 时显示来源名（SmartP 无版本号），
 *  否则显示当前有效版本号。 */
function currentLabel(cfg: any, name: string): string {
  if (cfg.meta?.empty) return '（空）';
  const src = cfg.meta?.source as 'smartp' | 'teg' | undefined;
  const v = Number(cfg.meta?.version ?? 0);
  if (name === 'common_config' && src === 'smartp') return 'SmartP';
  return v > 0 ? String(v) : '—';
}

async function handleRefresh() {
  await refreshStat();
  await pullAll();
}

const sourcePref = ref<BoosterSourcePref>(getBoosterSourcePref());

const commonPref = ref<BoosterSourcePref>(getCommonSourcePref());

function tegHas(name: string): boolean {
  return (state.rulesByModule[name]?.length ?? 0) > 0;
}

function sourceOptions(name: 'booster_config' | 'common_config'): { value: BoosterSourcePref; label: string }[] {
  const opts: BoosterSourcePref[] = [];
  if (smartpHas(name)) opts.push('smartp');
  if (tegHas(name)) opts.push('teg');
  if (opts.length > 1) opts.unshift('auto');
  return opts.map((v) => ({ value: v, label: PREF_LABELS[v] }));
}

async function onSourceChange() {
  try {
    setBoosterSourcePref(sourcePref.value);
    await pullAll();
    toast.success('已切换 booster_config 来源', PREF_LABELS[sourcePref.value]);
  } catch (err) {
    toast.fromError(err, '切换失败');
  }
}

async function onCommonSourceChange() {
  try {
    setCommonSourcePref(commonPref.value);
    await pullAll();
    toast.success('已切换 common_config 来源', PREF_LABELS[commonPref.value]);
  } catch (err) {
    toast.fromError(err, '切换失败');
  }
}

const writeTarget = ref<WriteTarget>(getWriteTarget());

/** 该配置在 cloudConfig 是否有行（含空配置；两库都无才隐藏来源行）。 */
function cfgPresent(name: string): boolean {
  const c = state.cloudConfig[name];
  return !!c && c.meta?._real === true;
}

/** 该配置是否只来自一个库（SmartP 或 teg 仅其一存在 → 显示但不可修改）。 */
function smartpHas(name: string): boolean {
  const c = state.cloudConfig[name];
  return !!c && c.meta?._real === true && !c.meta?.fromTeg;
}
function sourceSingle(name: string): boolean {
  const s = smartpHas(name);
  const t = tegHas(name);
  return s !== t; // 恰好一个库有
}
function sourceSingleLabel(name: string): string {
  return smartpHas(name) ? '仅 SmartP.db（cloud_config）' : '仅 teg_config.db（rules）';
}
function canChangeSource(name: string): boolean {
  return smartpHas(name) && tegHas(name);
}

function onWriteTargetChange() {
  setWriteTarget(writeTarget.value);
  toast.info('写入覆写已更新', WRITE_TARGET_LABELS[writeTarget.value]);
}



async function handleResetCloud() {
  const ok = await dialog.confirm('重置 Joyose 云控数据？', {
    detail:
      '重置 Joyose 云控数据后系统会尝试重新获取 Joyose 的云控数据，请确保当前在 Wifi 网络环境下，否则无法正常获取云控数据。（如仍然无法获取到新的 Joyose 云控数据，请尝试重启设备。）',
    okText: '确定重置云控数据',
    cancelText: '取消',
    destructive: true,
  });
  if (!ok) return;
  try {
    await bridge.resetCloud();
    toast.success('已重置云控', 'Joyose 数据已清除，正在尝试重新获取云控');
    await refreshStat();
    await pullAll();
  } catch (err) {
    toast.fromError(err, '重置失败');
  }
}

async function handleBackup() {
  try {
    const r = await bridge.backup();
    await recordBackupCheckpoint(r.name).catch(() => null);
    await refreshStat();
    toast.success('已备份', r.name);
  } catch (err) {
    toast.fromError(err, '备份失败');
  }
}

async function handleRevertLatest() {
  const ok = await dialog.confirm('回滚到最近一次备份？', {
    detail: '两份 DB 会被覆盖，但编辑历史记录仍保留（可继续回滚到更早版本）。',
    okText: '回滚',
    destructive: true,
  });
  if (!ok) return;
  try {
    const r = await bridge.revertLatest();
    await bridge.restart().catch(() => null);
    await pullAll();
    toast.success('已回滚到备份', r.from);
  } catch (err) {
    toast.fromError(err, '回滚失败');
  }
}
</script>
