<template>
  <div class="stack">
    <div class="panel">
      <div class="row" style="flex-wrap: wrap">
        <label class="row" style="gap: var(--space-1)">
          <span class="hint">目标</span>
          <select v-model="target">
            <option value="sp_booster">SmartP_booster_config</option>
            <option value="sp_common">SmartP_common_config</option>
            <option value="teg_common">teg_config_common_config</option>
            <option value="teg_booster">teg_config_booster_config</option>
          </select>
        </label>
        <button class="primary" @click="apply" :disabled="!editor || !isValidJson">应用到内存</button>
        <button class="ghost" @click="reset">重置为最新值</button>
        <button class="ghost" @click="importText">导入 JSON</button>
        <button class="ghost" @click="exportText" :disabled="!editor || !isValidJson">导出 JSON</button>
      </div>
      <div class="hint" style="margin-top: var(--space-2)">
        四个目标对应各库的配置槽位：<code class="mono">SmartP_*</code> 编辑 SmartP
        （cloud_config）侧，<code class="mono">teg_config_*</code> 编辑 teg（rules）侧。
        JSON 编辑可直接选择任一目标，<strong>不受“覆写逻辑”限制</strong>；改动仍照常走顶部
        “提交到设备”（写入方向由覆写逻辑决定，默认同时写）。
      </div>
    </div>

    <div class="panel">
      <div class="cm-shell" ref="editorRoot" />
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
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { state, markDirty } from '@/state/session';
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

const isEmptyObj = (p: unknown): boolean =>
  !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p as object).length === 0;

function currentText(): string {
  switch (target.value) {
    case 'sp_booster':
      return JSON.stringify(state.cloudConfig.booster_config?.params ?? {}, null, 2);
    case 'sp_common':
      return JSON.stringify(state.cloudConfig.common_config?.params ?? {}, null, 2);
    case 'teg_common':
      return JSON.stringify((state.rulesByModule.common_config ?? []).map((r) => r.content), null, 2);
    case 'teg_booster':
      return JSON.stringify((state.rulesByModule.booster_config ?? []).map((r) => r.content), null, 2);
  }
}

function reset() {
  const text = currentText();
  if (!editor.value) return;
  editor.value.dispatch({
    changes: { from: 0, to: editor.value.state.doc.length, insert: text },
  });
  isValidJson.value = true;
  parseError.value = '';
  codeLength.value = text.length;
}

watch(target, () => reset(), { immediate: true });

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

onBeforeUnmount(() => {
  editor.value?.destroy();
});

function apply() {
  if (!editor.value) return;
  const text = editor.value.state.doc.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    toast.fromError(err, 'JSON 解析失败');
    return;
  }

  switch (target.value) {
    case 'sp_booster':
    case 'sp_common': {
      const name = target.value === 'sp_booster' ? 'booster_config' : 'common_config';
      let cc = state.cloudConfig[name];
      if (!cc) {
        cc = { meta: { _real: true, version: undefined }, params: parsed };
        state.cloudConfig[name] = cc;
      } else {
        cc.params = parsed;
        // 原为空配置、现已填入内容 → 解除 empty，允许提交写入
        if (cc.meta?.empty && !isEmptyObj(parsed)) cc.meta.empty = false;
      }
      break;
    }
    case 'teg_booster':
    case 'teg_common': {
      const mod = target.value === 'teg_booster' ? 'booster_config' : 'common_config';
      const rows = state.rulesByModule[mod] ?? [];
      if (!Array.isArray(parsed)) {
        toast.error('格式错误', 'teg 目标应为 rule_content 数组');
        return;
      }
      if (rows.length === 0) {
        // teg 侧尚无该 module 行 → 按用户提供的数组新建
        state.rulesByModule[mod] = parsed.map((c: unknown) => ({
          meta: { _real: true, empty: false },
          content: c,
        }));
      } else {
        if (parsed.length !== rows.length) {
          toast.error('格式错误', `teg 现有 ${rows.length} 行，数组需 ${rows.length} 个元素`);
          return;
        }
        for (let i = 0; i < rows.length; i++) rows[i].content = parsed[i];
      }
      break;
    }
  }
  markDirty();
  toast.success('已应用到内存', '使用顶部“提交到设备”按钮写入 DB');
}

function exportText() {
  const text = editor.value?.state.doc.toString() ?? '';
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `joyose-edit-${target.value}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('已导出', a.download);
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