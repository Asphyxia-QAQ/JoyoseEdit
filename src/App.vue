<template>
  <div class="app-shell" :class="{ 'sidebar-open': navOpen }">
    <div class="mobile-bar">
      <button class="hamburger" @click="navOpen = !navOpen" :aria-expanded="navOpen" aria-label="菜单">
        ☰
      </button>
      <h1>Joyose<span>Edit</span></h1>
      <span class="tiny muted">{{ activeViewLabel }}</span>
    </div>
    <div class="sidebar-scrim" v-show="navOpen" @click="navOpen = false" aria-hidden="true" />
    <nav class="sidebar" @click="onNavClick">
      <h1>Joyose<span>Edit</span></h1>
      <div class="sidebar-version">v{{ version }} · KernelSU WebUI</div>

      <button class="nav-btn" :class="{ active: view === 'overview' }" @click="view = 'overview'">
        <span>概览</span>
        <span class="badge" v-if="state.stat">{{ pathsActive }}/4</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'lock' }" @click="view = 'lock'">
        <span>云控锁定</span>
        <span class="badge" v-if="isLocked">已锁</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'unlockfps' }" @click="view = 'unlockfps'">
        <span>去除锁帧</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'thermal' }" @click="view = 'thermal'">
        <span>温度解锁</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'gamelist' }" @click="view = 'gamelist'">
        <span>游戏列表</span>
        <span class="badge" v-if="gameListCount">{{ gameListCount }}</span>
      </button>

      <div class="nav-divider">插帧 / 超分</div>

      <button v-if="state.activeBackend === 'mifisr'" class="nav-btn" :class="{ active: view === 'mifisr' }"
        @click="view = 'mifisr'">
        <span>MIFISR</span>
        <span class="badge">{{ pathCount('mifisr') }}</span>
      </button>

      <button v-if="state.activeBackend === 'qualcomm'" class="nav-btn" :class="{ active: view === 'frc' }"
        @click="view = 'frc'">
        <span>高通 GPU</span>
        <span class="badge">{{ pathCount('qualcomm') }}</span>
      </button>

      <button v-if="state.activeBackend === 'novatek'" class="nav-btn" :class="{ active: view === 'novatek' }"
        @click="view = 'novatek'">
        <span>Novatek 独显</span>
        <span class="badge">{{ pathCount('novatek') }}</span>
      </button>

      <div v-if="state.stat && state.activeBackend === null" class="tiny muted" style="padding: 6px 12px">
        未检测到 Joyose 插帧配置
      </div>

      <button class="nav-btn" :class="{ active: view === 'mivk' }" @click="view = 'mivk'">
        <span>MIVK / MIGL</span>
        <span class="badge">{{ pathCount('mivk') }} / {{ pathCount('migl') }}</span>
      </button>

      <div class="nav-divider">其他</div>

      <button class="nav-btn" :class="{ active: view === 'json' }" @click="view = 'json'">
        <span>JSON 编辑</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'history' }" @click="view = 'history'">
        <span>编辑历史</span>
      </button>

      <button class="nav-btn" :class="{ active: view === 'importexport' }" @click="view = 'importexport'">
        <span>导入 / 导出</span>
      </button>

      <button class="nav-btn theme-btn" @click="cycleTheme" :title="themeTitle">
        <span>主题</span>
        <span class="badge">{{ themeLabel }}</span>
      </button>
    </nav>

    <main class="main">
      <div v-if="!state.connected" class="banner error">
        <strong>未检测到 KernelSU</strong>
        <span>{{ state.lastError ?? '请在 KernelSU 管理器内打开本模块的 WebUI。' }}</span>
      </div>
      <div v-else-if="state.lastError" class="banner error">
        <strong>错误</strong>
        <span>{{ state.lastError }}</span>
        <button class="ghost" @click="dismissError">知道了</button>
      </div>
      <div v-if="state.dirty" class="banner warn">
        <strong>有未提交修改</strong>
        <span>前往"云控锁定"或"提交"按钮完成写入；或切到"编辑历史"回滚。</span>
        <button @click="handlePush" :disabled="state.loading">提交到设备</button>
        <button class="ghost" @click="handleDiscard" :disabled="state.loading">丢弃</button>
      </div>

      <Suspense>
        <template #default>
          <component :is="currentView" />
        </template>
        <template #fallback>
          <div class="muted">加载中…</div>
        </template>
      </Suspense>
    </main>
    <ToastStack />
    <DialogStack />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, h, onMounted, ref, watch } from 'vue';
import { state, initialize, pullAll, pushAll } from '@/state/session';
import { toast } from '@/state/toast';
import OverviewView from '@/ui/OverviewView.vue';
import ToastStack from '@/ui/ToastStack.vue';
import DialogStack from '@/ui/DialogStack.vue';
import { dialog } from '@/state/dialog';
import { theme, cycleTheme } from '@/state/theme';

// Async view chunks can fail silently in WebView (stale cache hitting a new
// content-hash 404, or MIME rejection of .js chunks on certain KernelSU
// manager builds). Without an errorComponent + timeout, <Suspense> just
// parks the fallback "加载中…" forever. The wrapper surfaces a real error
// instead so the user knows to refresh.
const AsyncErrorView = {
  setup: () => () =>
    h('div', { class: 'banner error' }, [
      h('strong', '视图加载失败'),
      h('span', '资源请求超时或被 WebView 拒绝 — 刷新页面或重装模块后重试。'),
    ]),
};
function asyncView(loader: () => Promise<unknown>) {
  return defineAsyncComponent({
    loader: loader as () => Promise<any>,
    errorComponent: AsyncErrorView,
    timeout: 15000,
    delay: 200,
  });
}

const LockView = asyncView(() => import('@/ui/LockView.vue'));
const UnlockFpsView = asyncView(() => import('@/ui/UnlockFpsView.vue'));
const ThermalUnlockView = asyncView(() => import('@/ui/ThermalUnlockView.vue'));
const GameListView = asyncView(() => import('@/ui/GameListView.vue'));
const FrcView = asyncView(() => import('@/ui/FrcView.vue'));
const MifisrView = asyncView(() => import('@/ui/MifisrView.vue'));
const NovatekView = asyncView(() => import('@/ui/NovatekView.vue'));
const MivkView = asyncView(() => import('@/ui/MivkView.vue'));
const JsonEditorView = asyncView(() => import('@/ui/JsonEditorView.vue'));
const HistoryView = asyncView(() => import('@/ui/HistoryView.vue'));
const ImportExportView = asyncView(() => import('@/ui/ImportExportView.vue'));

type ViewId =
  | 'overview'
  | 'lock'
  | 'unlockfps'
  | 'thermal'
  | 'gamelist'
  | 'frc'
  | 'mifisr'
  | 'novatek'
  | 'mivk'
  | 'json'
  | 'history'
  | 'importexport';

const view = ref<ViewId>('overview');
const navOpen = ref(false);
const version = __APP_VERSION__;

const VIEW_LABELS: Record<ViewId, string> = {
  overview: '概览',
  lock: '云控锁定',
  unlockfps: '去除锁帧',
  thermal: '温度解锁',
  gamelist: '游戏列表',
  frc: '高通 GPU',
  mifisr: 'MIFISR',
  novatek: 'Novatek 独显',
  mivk: 'MIVK / MIGL',
  json: 'JSON 编辑',
  history: '编辑历史',
  importexport: '导入 / 导出',
};

const activeViewLabel = computed(() => VIEW_LABELS[view.value]);

const currentView = computed(() => {
  switch (view.value) {
    case 'overview': return OverviewView;
    case 'lock': return LockView;
    case 'unlockfps': return UnlockFpsView;
    case 'thermal': return ThermalUnlockView;
    case 'gamelist': return GameListView;
    case 'frc': return FrcView;
    case 'mifisr': return MifisrView;
    case 'novatek': return NovatekView;
    case 'mivk': return MivkView;
    case 'json': return JsonEditorView;
    case 'history': return HistoryView;
    case 'importexport': return ImportExportView;
  }
});

// If the user's selected view no longer matches the device's active backend
// (e.g. they re-pulled from a different phone), bounce back to overview.
watch(
  () => state.activeBackend,
  (backend) => {
    if (view.value === 'frc' && backend !== 'qualcomm') view.value = 'overview';
    else if (view.value === 'mifisr' && backend !== 'mifisr') view.value = 'overview';
    else if (view.value === 'novatek' && backend !== 'novatek') view.value = 'overview';
  },
);

// On mobile, clicking any nav button should collapse the drawer.
function onNavClick(event: Event) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.nav-btn')) navOpen.value = false;
}

onMounted(async () => {
  await initialize();
});

const pathsActive = computed(() => state.paths.filter((p) => p.active).length);
const isLocked = computed(() => {
  const v = state.cloudConfig.booster_config?.meta.version;
  return typeof v === 'number' && String(v).startsWith('2099');
});

const gameListCount = computed(() => {
  const gl = state.cloudConfig.common_config?.params?.game_list;
  return Array.isArray(gl) ? gl.length : null;
});

function pathCount(id: string): string {
  const p = state.paths.find((p) => p.id === id);
  return p ? String(p.count) : '—';
}

const themeLabel = computed(() => {
  if (theme.mode === 'auto') return `跟随系统 · ${theme.effective === 'light' ? '浅' : '深'}`;
  return theme.mode === 'light' ? '浅色' : '深色';
});

const themeTitle = computed(
  () => `切换主题 (当前：${theme.mode})，点击循环 跟随系统 → 浅色 → 深色`,
);

function dismissError() {
  state.lastError = null;
}

async function handlePush() {
  const note = await dialog.prompt('提交修改到设备', {
    detail: '给本次修改加一段备注（可留空），会写进历史记录。',
    placeholder: '例如：开启 17 PM MIFISR 原神插帧',
  });
  if (note === null) return;
  try {
    // JSON 编辑视图的提交强制同时写两份（不受覆写逻辑影响）
    const name = await pushAll({ note, forceBoth: view.value === 'json' });
    toast.success('已提交并写入历史', name);
  } catch (err) {
    toast.fromError(err, '提交失败');
  }
}

async function handleDiscard() {
  const ok = await dialog.confirm('放弃未提交修改？', {
    detail: '本地所有未提交修改会丢失，从设备重新拉取一份干净的副本。',
    okText: '丢弃并拉取',
    destructive: true,
  });
  if (!ok) return;
  try {
    await pullAll();
    toast.info('已重新从设备拉取');
  } catch (err) {
    toast.fromError(err, '拉取失败');
  }
}
</script>
