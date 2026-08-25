<template>
  <div class="stack">
    <div class="panel">
      <h2>导入 / 导出云控 <small>跨设备分享配置</small></h2>
      <div class="hint">
        导出的是可读 JSON，适合备份到云盘或分享给同机型用户。导入后改动只加载到内存，
        需再点顶栏「提交到设备」才会写入 DB，并自动在编辑历史里留一条记录。
      </div>
    </div>

    <div class="panel">
      <h2>导出 <small>当前设备的配置</small></h2>
      <div class="hint">选择要导出的配置域。默认已根据当前设备后端勾选合理项。</div>

      <div class="stack" style="margin-top: var(--space-3)">
        <label v-for="d in availableDomains" :key="d.id" class="row" style="gap: var(--space-2)">
          <input type="checkbox" :checked="selectedDomains.has(d.id)"
            @change="toggleDomain(d.id, ($event.target as HTMLInputElement).checked)" />
          <div style="flex: 1">
            <strong>{{ d.label }}</strong>
            <span v-if="d.empty" class="pill" style="margin-left: var(--space-2)">本机为空</span>
            <div class="hint">{{ d.note }}</div>
          </div>
        </label>
      </div>

      <div class="field" style="margin-top: var(--space-3)">
        <label class="label">备注（可选，写进导出文件和文件名）</label>
        <input v-model="exportNote" placeholder="例：17 Ultra 原神 60→120 MIFISR 优化" />
      </div>

      <div class="btn-row" style="margin-top: var(--space-3)">
        <button class="primary" @click="doExport" :disabled="selectedDomains.size === 0">下载 JSON</button>
        <button class="ghost" @click="copyExport" :disabled="selectedDomains.size === 0">复制到剪贴板</button>
      </div>
    </div>

    <div class="panel">
      <h2>导入 <small>从文件或剪贴板</small></h2>
      <div class="hint">导入会<strong>覆盖</strong>包内包含的配置域；未包含的域保持不变。</div>

      <div class="btn-row" style="margin-top: var(--space-3)">
        <label class="ghost" style="cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 1; text-align: center">
          选择 JSON 文件
          <input type="file" accept=".json,application/json" style="display: none" @change="onFilePicked" />
        </label>
        <button class="ghost" @click="pasteImport">从剪贴板粘贴</button>
        <button v-if="pendingPackage" class="ghost" @click="clearPending">清除已加载包</button>
      </div>

      <div v-if="importError" class="banner error" style="margin-top: var(--space-3)">
        <strong>导入失败</strong>
        <span class="hint">{{ importError }}</span>
      </div>

      <div v-if="pendingPackage" class="stack" style="margin-top: var(--space-3)">
        <div class="panel" style="margin: 0; background: var(--bg-elevated)">
          <div class="row">
            <strong>导入包预览</strong>
            <span class="pill">{{ formatTime(pendingPackage.exported_at) }}</span>
            <span class="pill">{{ backendLabel(pendingPackage.source.backend) }}</span>
          </div>
          <div v-if="pendingPackage.note" class="hint" style="margin-top: var(--space-2)">
            备注：{{ pendingPackage.note }}
          </div>
          <div class="hint" style="margin-top: var(--space-2)">
            包含配置域：<span class="mono">{{ pendingPackage.domains.join(', ') }}</span>
          </div>
        </div>

        <div v-if="compatibility.severity === 'error'" class="banner error">
          <strong>兼容性阻断</strong>
          <span class="hint">{{ compatibility.message }}</span>
        </div>
        <div v-else-if="compatibility.severity === 'warn'" class="banner warn">
          <strong>兼容性提示</strong>
          <span class="hint">{{ compatibility.message }}</span>
        </div>
        <div v-else class="banner" style="background: var(--surface-ok-bg, var(--bg-elevated))">
          <strong>可安全导入</strong>
          <span class="hint">导入包与当前设备兼容。</span>
        </div>

        <div v-if="importDiffSummary.length" class="panel" style="margin: 0; background: var(--bg-elevated)">
          <strong>将要生效的改动 <small class="muted">（{{ importDiffSummary.length }} 条）</small></strong>
          <div style="max-height: 240px; overflow-y: auto; margin-top: var(--space-2)">
            <div v-for="(r, i) in importDiffSummary.slice(0, 300)" :key="i" class="diff-line" :class="r.kind">
              {{ summarizeDiff(r) }}
            </div>
          </div>
          <div v-if="importDiffSummary.length > 300" class="hint" style="margin-top: var(--space-2)">
            仅显示前 300 条。
          </div>
        </div>
        <div v-else class="hint">导入包与当前内存状态完全一致，无实际改动。</div>

        <div class="btn-row">
          <button class="primary" @click="doImport" :disabled="compatibility.severity === 'error'">
            合并导入到内存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { state, markDirty } from '@/state/session';
import { toast } from '@/state/toast';
import { dialog } from '@/state/dialog';
import { diff, summarizeRecord } from '@/history/diff';
import { snapshotFromMaps } from '@/history/store';
import type { ActiveBackend } from '@/db/schema';

// ---- schema ---------------------------------------------------------------

const SCHEMA = 'joyose-edit.export/v1';

type DomainId = 'enhance' | 'render' | 'gamelist' | 'teg_freeze_hint' | 'raw';

interface ExportFile {
  schema: typeof SCHEMA;
  exported_at: number;
  source: {
    backend: ActiveBackend;
    paths: { id: string; active: boolean; count: number }[];
  };
  domains: DomainId[];
  data: {
    cloudConfig: Record<string, { params: Record<string, unknown> }>;
    rulesByModule?: Record<string, unknown[]>;
  };
  note?: string;
}

// Key subtrees under booster_config.params.game_booster that each domain covers.
// Used both for export (pick from current state) and import (overwrite per-key).
const DOMAIN_GB_KEYS: Record<Exclude<DomainId, 'gamelist' | 'teg_freeze_hint' | 'raw'>, string[]> = {
  enhance: [
    'fisr_config',
    'fisr_mqs_v2',
    'mqs_enhance_list',
    'customize_game_params',
    'frc_game_params',
    'novatek_game_params',
    'novatek_extend_config',
    'novatek_black_app',
    'novatek_gex_fps_limit',
    'support_highfps_app',
  ],
  render: ['mivk_settings', 'migl_settings'],
};

// ---- state ----------------------------------------------------------------

const selectedDomains = ref<Set<DomainId>>(new Set());
const exportNote = ref('');
const pendingPackage = ref<ExportFile | null>(null);
const importError = ref('');

// ---- domain availability + defaults ---------------------------------------

const availableDomains = computed(() => {
  const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
  const common = state.cloudConfig.common_config?.params ?? {};

  const enhanceKeys = DOMAIN_GB_KEYS.enhance.filter((k) => gb[k] !== undefined);
  const renderKeys = DOMAIN_GB_KEYS.render.filter((k) => gb[k] !== undefined);
  const hasGameList = Array.isArray(common.game_list) || Array.isArray(common.support_app);

  return [
    {
      id: 'enhance' as DomainId,
      label: '画质增强',
      note: enhanceKeys.length
        ? `插帧 / 超分策略：${enhanceKeys.join(', ')}`
        : '插帧 / 超分策略（当前为空，勾选也导不出东西）',
      empty: enhanceKeys.length === 0,
    },
    {
      id: 'render' as DomainId,
      label: '渲染模块（MIVK / MIGL）',
      note: renderKeys.length
        ? `xrender hook 配置：${renderKeys.join(', ')}`
        : '渲染模块参数（当前为空）',
      empty: renderKeys.length === 0,
    },
    {
      id: 'gamelist' as DomainId,
      label: '游戏列表',
      note: hasGameList
        ? `game_list / support_app（${(common.game_list?.length ?? 0)} + ${(common.support_app?.length ?? 0)} 项）`
        : '游戏列表（当前为空）',
      empty: !hasGameList,
    },
  ];
});

// Pre-select domains that have content on this device.
(function initDefaults() {
  for (const d of availableDomains.value) {
    if (!d.empty) selectedDomains.value.add(d.id);
  }
})();

function toggleDomain(id: DomainId, checked: boolean) {
  const next = new Set(selectedDomains.value);
  if (checked) next.add(id);
  else next.delete(id);
  selectedDomains.value = next;
}

// ---- export ---------------------------------------------------------------

function buildExportPackage(): ExportFile {
  const gb = state.cloudConfig.booster_config?.params?.game_booster ?? {};
  const common = state.cloudConfig.common_config?.params ?? {};

  const exportedGb: Record<string, unknown> = {};
  const exportedCommon: Record<string, unknown> = {};

  if (selectedDomains.value.has('enhance')) {
    for (const k of DOMAIN_GB_KEYS.enhance) {
      if (gb[k] !== undefined) exportedGb[k] = gb[k];
    }
  }
  if (selectedDomains.value.has('render')) {
    for (const k of DOMAIN_GB_KEYS.render) {
      if (gb[k] !== undefined) exportedGb[k] = gb[k];
    }
  }
  if (selectedDomains.value.has('gamelist')) {
    if (Array.isArray(common.game_list)) exportedCommon.game_list = common.game_list;
    if (Array.isArray(common.support_app)) exportedCommon.support_app = common.support_app;
  }

  const cloudConfig: ExportFile['data']['cloudConfig'] = {};
  if (Object.keys(exportedGb).length) {
    cloudConfig.booster_config = { params: { game_booster: exportedGb } };
  }
  if (Object.keys(exportedCommon).length) {
    cloudConfig.common_config = { params: exportedCommon };
  }

  return {
    schema: SCHEMA,
    exported_at: Math.floor(Date.now() / 1000),
    source: {
      backend: state.activeBackend,
      paths: state.paths.map((p) => ({ id: p.id, active: p.active, count: p.count })),
    },
    domains: Array.from(selectedDomains.value),
    data: { cloudConfig },
    note: exportNote.value.trim() || undefined,
  };
}

function serializePackage(pkg: ExportFile): string {
  return JSON.stringify(pkg, null, 2);
}

function downloadName(pkg: ExportFile): string {
  const dt = new Date(pkg.exported_at * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`
    + `-${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`;
  const backend = pkg.source.backend ?? 'unknown';
  const slug = (pkg.note ?? '').replace(/[^\w\-]+/g, '_').slice(0, 24);
  return `joyose-${backend}-${ts}${slug ? '-' + slug : ''}.json`;
}

function doExport() {
  const pkg = buildExportPackage();
  const body = serializePackage(pkg);
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(pkg);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast.success('已生成导出文件', downloadName(pkg));
}

async function copyExport() {
  const pkg = buildExportPackage();
  const body = serializePackage(pkg);
  try {
    await navigator.clipboard.writeText(body);
    toast.success('已复制到剪贴板', `${body.length.toLocaleString()} 字符`);
  } catch {
    toast.warn('复制失败', '请改用"下载 JSON"');
  }
}

// ---- import ---------------------------------------------------------------

function validatePackage(obj: unknown): { ok: true; pkg: ExportFile } | { ok: false; err: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, err: '不是有效的 JSON 对象' };
  const raw = obj as Record<string, unknown>;
  if (raw.schema !== SCHEMA) {
    return { ok: false, err: `schema 不匹配，期望 ${SCHEMA}，实际 ${String(raw.schema)}` };
  }
  if (!raw.data || typeof raw.data !== 'object') return { ok: false, err: '缺少 data 字段' };
  if (!Array.isArray(raw.domains)) return { ok: false, err: '缺少 domains 字段' };
  if (!raw.source || typeof raw.source !== 'object') return { ok: false, err: '缺少 source 字段' };
  return { ok: true, pkg: raw as unknown as ExportFile };
}

function onFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadImportText(String(reader.result ?? ''));
  reader.onerror = () => {
    importError.value = '读取文件失败';
    pendingPackage.value = null;
  };
  reader.readAsText(file);
  (e.target as HTMLInputElement).value = '';
}

async function pasteImport() {
  const text = await dialog.prompt('粘贴导入包 JSON', {
    detail: '把之前导出的 JSON 内容粘贴在下方。',
    placeholder: '{ "schema": "joyose-edit.export/v1", ... }',
    multiline: true,
  });
  if (text === null) return;
  loadImportText(text);
}

function loadImportText(text: string) {
  importError.value = '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    importError.value = `JSON 解析失败：${(err as Error).message}`;
    pendingPackage.value = null;
    return;
  }
  const v = validatePackage(parsed);
  if (!v.ok) {
    importError.value = v.err;
    pendingPackage.value = null;
    return;
  }
  pendingPackage.value = v.pkg;
}

function clearPending() {
  pendingPackage.value = null;
  importError.value = '';
}

// ---- compatibility --------------------------------------------------------

const compatibility = computed<{ severity: 'ok' | 'warn' | 'error'; message: string }>(() => {
  const pkg = pendingPackage.value;
  if (!pkg) return { severity: 'ok', message: '' };

  const onlyGeneric = pkg.domains.every((d) => d === 'gamelist');
  const srcBackend = pkg.source.backend;
  const curBackend = state.activeBackend;

  if (!onlyGeneric && srcBackend && curBackend && srcBackend !== curBackend) {
    return {
      severity: 'error',
      message: `导入包来自 ${backendLabel(srcBackend)}，当前设备是 ${backendLabel(curBackend)}。`
        + `跨后端导入画质 / 渲染配置会破坏字段结构，已阻止。若只想导入游戏列表，请在导出端重新选中"游戏列表"单独导出。`,
    };
  }

  if (pkg.domains.includes('render') && !state.paths.find((p) => p.id === 'mivk')?.active) {
    return {
      severity: 'warn',
      message: '导入包包含渲染模块，但当前设备未检测到 mivk_settings，合并后相关键会被新增。确认无误再导入。',
    };
  }

  if (pkg.domains.includes('enhance') && !curBackend) {
    return {
      severity: 'warn',
      message: '当前设备未检测到画质增强后端，导入将创建对应键；若机型不支持（如老 ROM），提交后可能无效但不会损坏系统。',
    };
  }

  return { severity: 'ok', message: '' };
});

// ---- preview diff ---------------------------------------------------------

const importDiffSummary = computed(() => {
  const pkg = pendingPackage.value;
  if (!pkg) return [];
  const before = snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  });
  const afterState = simulateMerge(pkg);
  const after = snapshotFromMaps(afterState);
  return diff(before, after);
});

function summarizeDiff(r: Parameters<typeof summarizeRecord>[0]): string {
  return summarizeRecord(r);
}

// Compute what state.cloudConfig / state.rulesByModule would look like if we
// applied `pkg` now — without actually mutating. Used for the preview diff.
function simulateMerge(pkg: ExportFile): {
  cloudConfig: Record<string, unknown>;
  rulesByModule: Record<string, unknown[]>;
} {
  const cc = deepClone(state.cloudConfig);
  const rules = deepClone(state.rulesByModule);
  applyMerge(pkg, cc, rules);
  return { cloudConfig: cc, rulesByModule: rules };
}

function applyMerge(
  pkg: ExportFile,
  cc: Record<string, any>,
  _rules: Record<string, any[]>,
): void {
  for (const [cfgName, cfgBody] of Object.entries(pkg.data.cloudConfig)) {
    if (!cc[cfgName]) cc[cfgName] = { meta: {}, params: {} };
    if (!cc[cfgName].params) cc[cfgName].params = {};
    const target = cc[cfgName].params;
    const src = (cfgBody as any).params ?? {};

    if (cfgName === 'booster_config') {
      if (!target.game_booster) target.game_booster = {};
      const srcGb = src.game_booster ?? {};
      for (const [k, v] of Object.entries(srcGb)) {
        target.game_booster[k] = deepClone(v);
      }
    } else {
      for (const [k, v] of Object.entries(src)) {
        target[k] = deepClone(v);
      }
    }
  }
  // rules are auto-synced from cloud_config during pushAll via syncRuleContent,
  // so we don't need to touch rulesByModule here for the preview or apply.
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

async function doImport() {
  const pkg = pendingPackage.value;
  if (!pkg) return;
  if (compatibility.value.severity === 'error') return;

  const ok = await dialog.confirm('确认导入到内存？', {
    detail: `将合并 ${pkg.domains.length} 个配置域；不会立即写设备。`
      + `导入后点顶栏「提交到设备」才会真正生效，并自动生成编辑历史。`,
    okText: '合并到内存',
  });
  if (!ok) return;

  applyMerge(pkg, state.cloudConfig as Record<string, any>, state.rulesByModule);
  markDirty();
  pendingPackage.value = null;
  importError.value = '';
  toast.success('已合并到内存', '点顶栏「提交到设备」才会真正生效');
}

// ---- helpers --------------------------------------------------------------

function backendLabel(b: ActiveBackend | null | undefined): string {
  switch (b) {
    case 'mifisr': return 'MIFISR（17 系列）';
    case 'qualcomm': return '高通老通路（15 系列）';
    case 'novatek': return 'Novatek 独显（红米）';
    default: return '未检测到后端';
  }
}

function formatTime(epoch: number): string {
  try {
    const d = new Date(epoch * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(epoch);
  }
}
</script>
