<template>
  <div class="stack">
    <div class="panel">
      <div class="row" style="flex-wrap: wrap">
        <label class="row" style="gap: var(--space-1)">
          <span class="hint">目标</span>
          <select v-model="target">
            <option value="sp_booster">SmartP_booster_config</option>
            <option value="sp_common">SmartP_common_config</option>
            <option value="teg_booster">teg_config_booster_config</option>
            <option value="teg_common">teg_config_common_config</option>
          </select>
        </label>
        <button class="primary" @click="save" :disabled="!editor || !isValidJson || targetEmpty">保存修改</button>
        <button class="ghost" @click="resetLatest(true)">重置为最新值</button>
        <button class="ghost" @click="importText" :disabled="targetEmpty">导入 JSON</button>
        <button class="ghost" @click="exportText" :disabled="!editor || !isValidJson || targetEmpty">导出 JSON</button>
      </div>
    </div>

    <div class="panel">
      <div class="cm-shell" ref="editorRoot" />
      <div v-if="targetEmpty" class="tiny" style="color: var(--warn); margin-top: var(--space-2)">
        ⚠ {{ emptyHint }}
      </div>
      <div v-if="!isValidJson" class="tiny" style="color: var(--warn); margin-top: var(--space-2)">
        ⚠ JSON 无法解析：{{ parseError }}
      </div>
      <div v-else class="hint" style="margin-top: var(--space-2)">
        JSON 合法 · {{ codeLength }} 字符
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { state, saveJsonTarget, pullAll } from '@/state/session';
import * as bridge from '@/root/bridge';
import { toast } from '@/state/toast';
// CodeMirror is the biggest single contributor to bundle size and is only
// used in this view — defer all imports until the view actually mounts.
import type { EditorView } from 'codemirror';

type Target = 'sp_booster' | 'sp_common' | 'teg_common' | 'teg_booster';

const target = ref<Target>('sp_booster');
const editorRoot = ref<HTMLElement | null>(null);
const editor = ref<EditorView | null>(null);
const isValidJson = ref(true);
const parseError = ref('');
const codeLength = ref(0);

/** 未保存修改标记：编辑器内容相对最近一次“保存/重置”有改动。 */
const dirty = ref(false);
/** 代码内部改文档（reset）时抑制 dirty 标记。 */
let suppressDirty = false;

function currentText(): string {
  switch (target.value) {
    case 'sp_booster':
      return JSON.stringify(state.smartpRaw.booster_config ?? {}, null, 2);
    case 'sp_common':
      return JSON.stringify(state.smartpRaw.common_config ?? {}, null, 2);
    case 'teg_common':
      // 作者单份语义：只显示该 module 最新一行的信封（一份配置）
      return JSON.stringify(state.rulesByModule.common_config?.[0]?.content ?? {}, null, 2);
    case 'teg_booster':
      return JSON.stringify(state.rulesByModule.booster_config?.[0]?.content ?? {}, null, 2);
  }
}

function reset() {
  const text = currentText();
  if (!editor.value) {
    dirty.value = false;
    return;
  }
  suppressDirty = true;
  editor.value.dispatch({
    changes: { from: 0, to: editor.value.state.doc.length, insert: text },
  });
  suppressDirty = false;
  isValidJson.value = true;
  parseError.value = '';
  codeLength.value = text.length;
  dirty.value = false; // 已同步到当前库内容
}

/** 重置为数据库最新值：smartpRaw 只在 pullAll（启动/概览刷新）时重建，所以这里
 *  先重新拉取一次，确保编辑器显示的是 DB 当前内容（而不是打开页面时的旧副本）。 */
async function resetLatest(withInfo = false) {
  try {
    await pullAll();
    reset();
    if (withInfo) toast.info('已重置为数据库最新值');
  } catch (err) {
    toast.fromError(err, '重置失败');
  }
}

// 切换目标：有未保存修改时要确认；拒绝则恢复原目标并保留编辑内容（不刷新）
let canceledSwitch = false;
watch(
  target,
  async (nv, ov) => {
    if (ov === undefined) {
      reset();
      return;
    }
    if (canceledSwitch) {
      canceledSwitch = false; // 恢复目标的那次进入：不刷新，保留编辑器内容
      return;
    }
    if (dirty.value && !window.confirm('编辑器有未保存的修改，确定切换目标并放弃？')) {
      dirty.value = false;
      canceledSwitch = true;
      target.value = ov;
      return;
    }
    dirty.value = false;
    await resetLatest();
  },
  { immediate: true },
);

async function mountEditor() {
  await nextTick();
  if (!editorRoot.value || editor.value) return;
  const [{ EditorView: EV, basicSetup }, { json }, { oneDark }, { EditorState }] =
    await Promise.all([
      import('codemirror'),
      import('@codemirror/lang-json'),
      import('@codemirror/theme-one-dark'),
      import('@codemirror/state'),
    ]);
  editor.value = new EV({
    state: EditorState.create({
      doc: currentText(),
      extensions: [
        basicSetup,
        json(),
        oneDark,
        EV.updateListener.of((v) => {
          if (!v.docChanged) return;
          if (suppressDirty) return; // 内部 reset 造成的变动不算未保存
          dirty.value = true;
          const text = v.state.doc.toString();
          codeLength.value = text.length;
          try {
            JSON.parse(text);
            isValidJson.value = true;
            parseError.value = '';
          } catch (err: any) {
            isValidJson.value = false;
            parseError.value = err?.message ?? String(err);
          }
        }),
      ],
    }),
    parent: editorRoot.value,
  });
  codeLength.value = editor.value.state.doc.length;
}

watch(editorRoot, (el) => {
  if (el) mountEditor();
});

onMounted(() => {
  // 进入页面先拉一次最新（静默），确保编辑器显示 DB 当前内容而非历史旧副本
  void resetLatest();
});

onBeforeUnmount(() => {
  if (dirty.value) window.confirm('编辑器有未保存的修改，离开页面将丢失');
  editor.value?.destroy();
});

/** 目标显示名，同时用作导出文件名（如 SmartP_booster_config.json）。 */
const emptyHint = computed<string>(() =>
  target.value.startsWith('sp_') ? 'SmartP 当前为空，无法修改' : 'teg 当前为空，无法修改',
);
/** 目标在对应库为空（SmartP 无该 config 行 / teg 无该 module 行）时禁止保存：
 *  空表不给写（与后端拒绝一致），仅允许在其有对应行时修改。 */
const targetEmpty = computed<boolean>(() => {
  const t = target.value;
  if (t.startsWith('sp_')) {
    const name = t === 'sp_booster' ? 'booster_config' : 'common_config';
    const cc = state.cloudConfig[name];
    return !cc || cc.meta?.fromTeg === true;
  }
  const mod = t === 'teg_booster' ? 'booster_config' : 'common_config';
  return (state.rulesByModule[mod] ?? []).length === 0;
});

function targetLabel(): string {
  switch (target.value) {
    case 'sp_booster':
      return 'SmartP_booster_config';
    case 'sp_common':
      return 'SmartP_common_config';
    case 'teg_booster':
      return 'teg_config_booster_config';
    case 'teg_common':
      return 'teg_config_common_config';
  }
}

/** 保存修改（独立通道）：把编辑器内容按目标“直接写入对应数据库的那一部分”
 *  （见 session.saveJsonTarget）——SmartP 目标只写 SmartP（不串 teg、同步 version），
 *  teg 目标逐行写；不受“覆写逻辑”/顶部全局提交影响。 */
async function save() {
  if (!editor.value) return;
  const text = editor.value.state.doc.toString();
  try {
    await saveJsonTarget(target.value, text);
    toast.success(
      '已保存',
      `已写入 ${targetLabel()}（${target.value.startsWith('sp_') ? 'SmartP 侧' : 'teg 侧'}）`,
    );
    reset(); // saveJsonTarget 已 pullAll，重置显示为最新
  } catch (err) {
    toast.fromError(err, '保存失败');
  }
}

async function exportText() {
  const text = editor.value?.state.doc.toString() ?? '';
  const fname = `${targetLabel()}.json`;
  try {
    const res = await bridge.exportFile(fname, text);
    toast.success('已导出', res.path);
  } catch (err) {
    toast.fromError(err, '导出失败');
  }
}

function importText() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      if (editor.value) {
        editor.value.dispatch({
          changes: { from: 0, to: editor.value.state.doc.length, insert: text },
        });
      }
      toast.success('已导入', file.name);
    };
    reader.readAsText(file);
  };
  input.click();
}
</script>