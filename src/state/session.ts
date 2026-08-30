// Central reactive store for the WebUI. Holds the pulled DB bytes, the parsed
// working copies of cloud_config.params / teg_config.rule_content, and the
// side-band metadata (stat, path status, dirty flag). All views read / mutate
// through this module, so there is exactly one place where a `push` is
// constructed.

import { reactive, computed } from 'vue';
import type { Database } from 'sql.js';

import * as bridge from '@/root/bridge';
import {
  openDb,
  closeDb,
  exportDb,
  listCloudConfig,
  listRules,
  updateCloudConfigParams,
  updateRulesContent,
  upsertRulesContent,
} from '@/db/dbio';
import {
  detectActiveBackend,
  detectPaths,
  fingerprint,
  parseParams,
  stringifyParams,
  type ActiveBackend,
  type V3PathStatus,
} from '@/db/schema';
import {
  DriverBackedStore,
  snapshotFromMaps,
  buildRecord,
  nextSeq,
  buildHistoryFilename,
  parseHistoryFilename,
  type ConfigSnapshot,
  type HistoryFileMeta,
  type HistoryRecord,
  type HistorySource,
} from '@/history/store';
import { diff, applyDelta, invertDelta } from '@/history/diff';
import { refreshEnvelope } from '@/history/envelope';
import {
  pickBoosterParams,
  latestEnvelopeVersion,
  getDataSourcePref,
  getBoosterSourcePref,
  getCommonSourcePref,
  getWriteTarget,
  getStoredInstallTs,
  storeInstallTs,
  resetAllPrefs,
} from '@/state/source';

/** “空配置”：params 为 null / 非对象 / 无任何键（官方下发过但只有 {}）时，
 *  一律视为“未下发”——不展示版本、不参与锁定、写入被跳过。 */
function isEmptyCloudParams(p: unknown): boolean {
  return (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    (Object.keys(p as object).length === 0)
  );
}

export interface SessionState {
  connected: boolean;
  loading: boolean;
  lastError: string | null;
  stat: bridge.StatResult | null;
  /** Last-observed DB fingerprints, to detect concurrent modification. */
  baselineSmartp: string | null;
  baselineTeg: string | null;
  /** Parsed cloud_config rows by name. Each value is the parsed `params` JSON. */
  cloudConfig: Record<string, any>;
  /** SmartP 侧 cloud_config.params 的原始深拷贝（不受版本来源 / teg 兜底调和影响）。
   *  JSON 编辑的 SmartP_* 目标读写它：目标 = SmartP 数据库那份真实内容。 */
  smartpRaw: Record<string, any>;


  /** Parsed rule_content JSON arrays grouped by rule_module. */
  rulesByModule: Record<string, any[]>;
  /** V3 path detection result (refreshed whenever booster_config is re-parsed). */
  paths: V3PathStatus[];
  /** Which insertion backend this device actually uses. Drives which editor
   * panel the UI surfaces. `null` until a pull completes or when no backend
   * is detectable (e.g. unrelated ROM). */
  activeBackend: ActiveBackend;
  /** Snapshot of the state captured on pull — used as `before` for history records. */
  pristineSnapshot: ReturnType<typeof snapshotFromMaps> | null;
  dirty: boolean;
}

export const state = reactive<SessionState>({
  connected: false,
  loading: false,
  lastError: null,
  stat: null,
  baselineSmartp: null,
  baselineTeg: null,
  cloudConfig: {},
  smartpRaw: {},
  rulesByModule: {},
  paths: [],
  activeBackend: null,
  pristineSnapshot: null,
  dirty: false,
});

export const isReady = computed(
  () => state.connected && state.stat !== null && !state.loading,
);

export async function initialize(): Promise<void> {
  if (!bridge.isKsuAvailable()) {
    state.lastError =
      'KernelSU bridge unavailable — open this WebUI inside KernelSU Manager.';
    state.connected = false;
    return;
  }
  state.connected = true;
  await refreshStat();
  // 模块刚刷入/重装/升级（安装标记变化）→ 重置本地偏好（覆写逻辑回到默认 both），
  // 避免 WebView localStorage 的旧数据跨安装残留。
  try {
    const ts = await bridge.moduleInstallTs();
    if (ts && ts !== '0' && ts !== getStoredInstallTs()) {
      resetAllPrefs();
      storeInstallTs(ts);
    }
  } catch {
    /* 探测失败按不重置处理 */
  }
  // 任一库有内容（SmartP 或 teg_config）都拉取；SmartP 缺失/空时用 teg 兜底。
  if (state.stat?.smartp.exists || state.stat?.teg.exists) {
    await pullAll();
  }
}

export async function refreshStat(): Promise<void> {
  try {
    state.stat = await bridge.stat();
    state.lastError = null;
  } catch (err: any) {
    state.lastError = err?.message ?? String(err);
  }
}

export async function pullAll(): Promise<void> {
  state.loading = true;
  try {
    const [smartpBytes, tegBytes] = await Promise.all([
      state.stat?.smartp?.exists
        ? bridge.pull('smartp')
        : Promise.resolve<Uint8Array | null>(null),
      state.stat?.teg?.exists
        ? bridge.pull('teg')
        : Promise.resolve<Uint8Array | null>(null),
    ]);

    // open + extract（缺失的库为 null）
    const dbS = smartpBytes ? await openDb(smartpBytes) : null;
    const dbT = tegBytes ? await openDb(tegBytes) : null;
    try {
      readIntoState(dbS, dbT);
    } finally {
      if (dbS) closeDb(dbS);
      if (dbT) closeDb(dbT);
    }

    // 先用最新 stat 刷新，再拍 baseline 指纹——saveJsonTarget 等直写会 push 改变
    // DB 文件（mtime/size 变化），若沿用旧的 state.stat，下次提交指纹校验必然冲突。
    await refreshStat();
    // set baseline fingerprint
    if (state.stat?.smartp.exists) {
      state.baselineSmartp = fingerprint(state.stat.smartp.mtime ?? 0, state.stat.smartp.size ?? 0);
    }
    if (state.stat?.teg.exists) {
      state.baselineTeg = fingerprint(state.stat.teg.mtime ?? 0, state.stat.teg.size ?? 0);
    }
    state.pristineSnapshot = snapshotFromMaps({
      cloudConfig: state.cloudConfig,
      rulesByModule: state.rulesByModule,
    });
    state.dirty = false;
    state.lastError = null;
  } catch (err: any) {
    state.lastError = err?.message ?? String(err);
  } finally {
    state.loading = false;
  }
}

function readIntoState(dbS: Database | null, dbT: Database | null) {
  const cc: Record<string, any> = {};
  const smartpRaw: Record<string, any> = {};
  if (dbS) {
    for (const row of listCloudConfig(dbS)) {
      const params = parseParams(row.params);
      // 空配置（{} 或其它空形态）≠ 未下发：保留行、标记 empty，
      // 由 UI/锁定/写入按 empty 特殊处理（不显示版本、不锁定、不写盘）。
      const empty = isEmptyCloudParams(params);
      cc[row.config_name] = {
        meta: { ...row, _real: true, empty },
        params,
      };
      smartpRaw[row.config_name] = JSON.parse(JSON.stringify(params));
    }
  }
  state.cloudConfig = cc;
  state.smartpRaw = smartpRaw;

  const byModule: Record<string, any[]> = {};
  if (dbT) {
    for (const row of listRules(dbT)) {
      const mod = row.rule_module ?? 'unknown';
      if (!byModule[mod]) byModule[mod] = [];
      try {
        const content = parseParams(row.rule_content);
        const envParams =
          content && typeof content === 'object' && !Array.isArray(content)
            ? (content as any).params
            : null;
        byModule[mod].push({
          meta: { ...row, _real: true, empty: isEmptyCloudParams(envParams) },
          content,
        });
      } catch {
        // keep the raw row even if JSON is malformed
        byModule[mod].push({ meta: { ...row, _real: true, empty: false }, content: row.rule_content });
      }
    }
  }
  state.rulesByModule = byModule;

  // ---- SmartP 缺失 / 无该配置行时，用 teg envelope 兜底构造工作副本 ----
  // 让“只有 teg_config 有内容”的设备也能正常使用（不再依赖 SmartP 存在）。
  for (const [name, rows] of Object.entries(byModule)) {
    // 兜底条件：SmartP 没有该配置，或 SmartP 的该配置为空（empty）——此时若有
    // 非空的 teg envelope，则采用 teg 内容（fromTeg），避免“SmartP 空配置挡住
    // teg 的非空内容”导致识别不到 booster/common。
    const cur = cc[name];
    if (cur && !cur.meta?.empty) continue;
    const env = rows.find((r) => {
      const e = r.content;
      return (
        e &&
        typeof e === 'object' &&
        !Array.isArray(e) &&
        !isEmptyCloudParams((e as any).params)
      );
    })?.content;
    if (env) {
      const p = parseParams(JSON.stringify((env as any).params));
      cc[name] = {
        // fromTeg：该配置在 SmartP 中不存在，内容完全来自 teg —— 调和时按 teg
        // 处理，绝不能把它当作“SmartP 来源”展示版本号 / ← 当前。
        meta: {
          version: Number((env as any).version ?? 0),
          rule_version: null,
          fromTeg: true,
          _real: true,
        },
        params: p,
      };
    }
  }

  // ---- 版本来源选择（source-of-truth）----
  // booster_config 在 SmartP.db 与 teg_config.db 各有副本，官方更新时可能
  // 不同步（teg 通常更新，且 rules 表保留多行历史）。按用户偏好选择；
  // common_config 始终用 SmartP（其 teg 镜像字段不完整）。比较用
  // envelope.version（与 SmartP.version 同 YYYYMMDDxx 体系），不能拿
  // rule_version（内部序号）做跨库比较。指定“smartp / auto(t取新) / teg”。
  {
    const booster = cc['booster_config'];
    if (booster) {
      if (booster.meta.fromTeg) {
        // SmartP 无该配置，内容完全来自 teg：来源只能是 teg
        booster.meta.smartpVersion = 0;
        booster.meta.tegVersion = latestEnvelopeVersion(byModule['booster_config']);
        booster.meta.version =
          booster.meta.tegVersion > 0 ? booster.meta.tegVersion : undefined;
        booster.meta.source = 'teg';
      } else {
        // 保留两份库的原始版本供概览对比（调和会改写 meta.version）
        booster.meta.smartpVersion = Number(booster.meta.version ?? 0);
        booster.meta.tegVersion = latestEnvelopeVersion(byModule['booster_config']);
        const picked = pickBoosterParams(
          booster,
          byModule['booster_config'],
          getBoosterSourcePref(),
        );
        if (picked) {
          booster.params = picked.params;
          booster.meta.version = picked.version;
          booster.meta.source = picked.source;
        }
      }
    }
  }

  // common_config：内容(params)与“版本号”都跟随来源（默认 SmartP）——
  // SmartP.cloud_config.common_config 的 version 列就是官方版本（如 2024010101），
  // 以官方真实为准；参数头（params.header）为空时保持为空显示。
  // COMMON_CONFIG_VERSION(2024010101) 只用于 teg 缺 common 镜像行时的兜底写入。
  {
    const common = cc['common_config'];
    if (common) {
      common.meta.smartpVersion = Number(common.meta.version ?? 0);
      common.meta.tegVersion = latestEnvelopeVersion(byModule['common_config']);
    }
    const pickedC = pickBoosterParams(
      common,
      byModule['common_config'],
      getCommonSourcePref(),
    );
    if (common && pickedC) {
      common.params = pickedC.params;
      // 内容来源（smartp / teg）——用于 UI 标记“← 当前”
      common.meta.source = pickedC.source;
      // 版本跟随来源（官方真实版本）：默认 SmartP（2024010101），
      // 显式选 teg 才用 teg 的 envelope.version。
      common.meta.version = pickedC.version > 0 ? pickedC.version : undefined;
    }
  }

  // common_config 调和：SmartP 无该配置（teg 兜底）时直接以 teg 为准
  {
    const common2 = cc['common_config'];
    if (common2 && common2.meta.fromTeg) {
      common2.meta.smartpVersion = 0;
      common2.meta.tegVersion = latestEnvelopeVersion(byModule['common_config']);
      common2.meta.version =
        common2.meta.tegVersion > 0 ? common2.meta.tegVersion : undefined;
      common2.meta.source = 'teg';
    }
  }

  const booster = cc.booster_config?.params ?? {};
  state.paths = detectPaths(booster);
  state.activeBackend = detectActiveBackend(booster);
}

/** Mark a mutation to booster_config / common_config / rules as pending.
 * Called by the views after every in-memory edit. */
export function markDirty(): void {
  state.dirty = true;
  if (state.cloudConfig.booster_config) {
    const booster = state.cloudConfig.booster_config.params ?? {};
    state.paths = detectPaths(booster);
    state.activeBackend = detectActiveBackend(booster);
  }
}

/** Synchronise teg_config.rules.rule_content for a given module from the
 * current cloud_config.params. Mirrors what Joyose itself does internally. */
/** Fallback version used when teg_config has no common_config mirror row yet. */
export const COMMON_CONFIG_VERSION = 2024010101;

/** If teg carries any rules but is missing the common_config mirror, create a
 *  placeholder row now so the push writes it. Version defaults per policy. */
function ensureCommonConfigRules(): void {
  const name = 'common_config';
  const cc = state.cloudConfig[name];
  // 仅在两库“真实存在且非空”的 common_config 时才补 teg 镜像；空壳/残留（_real!==true）
  // 或空配置（empty）不建，杜绝“两库都无 common / 空 common 却被写入”。
  if (cc?.meta?._real && !cc.meta?.empty && !state.rulesByModule[name]?.length) {
    state.rulesByModule[name] = [
      {
        meta: { rule_version: COMMON_CONFIG_VERSION },
        content: refreshEnvelope(null, cc.params, COMMON_CONFIG_VERSION, 'common_config'),
      },
    ];
  }
}

function hasAnyRules(): boolean {
  return Object.values(state.rulesByModule).some((rows) => rows.length > 0);
}

export function syncRuleContent(configName: string, newVersion?: number): void {
  const cc = state.cloudConfig[configName];
  if (!cc) return;
  const rules = state.rulesByModule[configName];
  if (!rules || rules.length === 0) return;
  // 版本基准：只认“当前有效版本”（cc.meta.version，含锁定后的 2099 值）。
  // common_config 在无有效版本时兜底 COMMON_CONFIG_VERSION(2024010101)。
  // 绝不用 r.meta.rule_version（内部序号，且可能被旧版本污染成 2099 垃圾）。
  const effV =
    newVersion ?? resolveRuleVersion(configName, cc);
  for (const r of rules) {
    r.content = refreshEnvelope(r.content as any, cc.params, effV > 0 ? effV : undefined, configName);
    if (typeof newVersion === 'number') r.meta.rule_version = newVersion;
  }
}

function resolveRuleVersion(configName: string, cc: any): number {
  const cur = Number(cc.meta?.version ?? 0);
  if (!(cur > 0)) return configName === 'common_config' ? COMMON_CONFIG_VERSION : 0;
  return cur;
}

/** Lock the cloud version by rewriting the leading 4 digits to `2099`.
 * Mirrors the Coolapk trick: Joyose compares the cloud-pushed `version`
 * against `cloud_config.version` and only overwrites when the cloud value
 * is newer, so faking a far-future date pins our edits. */
/** JSON 编辑的四个固定目标。 */

/** JSON 编辑的四个固定目标。 */
export type JsonTarget = 'sp_booster' | 'sp_common' | 'teg_booster' | 'teg_common';

/**
 * JSON 编辑「保存修改」：完全独立通道，目标定向直写对应库的那一部分，
 * 不受“覆写逻辑”/顶部全局提交影响：
 *   - SmartP_*   → 只写 SmartP.cloud_config 该行 params，并同步 version 列
 *                   （已有版本保留；无版本写 2099 锁，确保不被云控覆盖、其它工具可见）
 *   - teg_config_* → 只写 teg.rules 该 module 的 rule_content（单对象信封，作者镜像覆盖所有行）
 * 点击即直写：不自动备份、不走顶部“提交到设备”/历史；写后重启 Joyose 并从 DB 重建状态。
 */
export async function saveJsonTarget(
  target: JsonTarget,
  jsonText: string,
): Promise<{ ok: true; target: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: any) {
    throw new Error(`JSON 解析失败：${err?.message ?? err}`);
  }

  // 冲突软检测：目标库在“上次拉取/保存”后又被 Joyose 后台更新过 → 拒绝保存并提示
  // 刷新，防止把新下发的云控覆盖掉（与顶部提交的指纹检测一致；仅拦截、不自动 rebase）。
  {
    const fresh = await bridge.stat().catch(() => null);
    if (fresh) {
      if (
        (target === 'sp_booster' || target === 'sp_common') && state.baselineSmartp
      ) {
        const fp = fingerprint(fresh.smartp.mtime ?? 0, fresh.smartp.size ?? 0);
        if (fp !== state.baselineSmartp) {
          if (
            !window.confirm(
              'SmartP.db 刚被 Joyose 后台更新。继续保存会用你的内容覆盖目标行（Joyose 对该行的新更新会丢失）。仍要保存？',
            )
          ) {
            throw new Error('已取消保存（编辑器内容已保留）；如需放弃请点“重置为最新值”');
          }
        }
      } else if (
        (target === 'teg_booster' || target === 'teg_common') && state.baselineTeg
      ) {
        const fp = fingerprint(fresh.teg.mtime ?? 0, fresh.teg.size ?? 0);
        if (fp !== state.baselineTeg) {
          if (
            !window.confirm(
              'teg_config.db 刚被 Joyose 后台更新。继续保存会用你的内容覆盖目标行（Joyose 对该行的新更新会丢失）。仍要保存？',
            )
          ) {
            throw new Error('已取消保存（编辑器内容已保留）；如需放弃请点“重置为最新值”');
          }
        }
      }
    }
  }

  if (target === 'sp_booster' || target === 'sp_common') {
    const name = target === 'sp_booster' ? 'booster_config' : 'common_config';
    // 先把用户文本写入目标行内存，使下面的“作者遍历”能带上它
    let cc = state.cloudConfig[name];
    if (!cc) {
      cc = { meta: { _real: true, version: undefined }, params: parsed };
      state.cloudConfig[name] = cc;
    } else {
      cc.params = parsed;
      if (cc.meta?.empty && !isEmptyCloudParams(parsed)) cc.meta.empty = false;
    }
    state.smartpRaw[name] = parsed;

    const bytes = await bridge.pull('smartp');
    const db = await openDb(bytes);
    let out: Uint8Array;
    try {
      // SmartP 必须真实存在该 config 行才允许写入：空表 / 无该行时直接拒绝，
      // 防止把 teg 兜底内容硬塞进 SmartP（真实存在才允许写入的原则）。
      const cnt =
        Number(
          db.exec(`SELECT COUNT(*) AS c FROM cloud_config WHERE config_name = :n`, {
            ':n': name,
          })[0]?.values?.[0]?.[0] ?? 0,
        );
      if (cnt === 0) {
        throw new Error(
          `${name}：SmartP 当前没有此配置行，不能保存到 SmartP（可改用 teg_config_* 目标）`,
        );
      }
      // 作者行为遍历：booster 带 version、common 不动 version
      for (const [n, obj] of Object.entries(state.cloudConfig)) {
        if (obj.meta?._real !== true || obj.meta?.empty) continue;
        const serialized = stringifyParams(obj.params);
        const version =
          n === 'common_config'
            ? undefined
            : typeof obj.meta.version === 'number'
              ? obj.meta.version
              : undefined;
        updateCloudConfigParams(db, n, serialized, version);
      }
      out = exportDb(db);
    } finally {
      closeDb(db);
    }
    await bridge.push('smartp', out);
  } else {
    const mod = target === 'teg_booster' ? 'booster_config' : 'common_config';
    // 作者单份语义：teg 目标 = 一个信封对象（一份配置），不再暴露多行数组
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('teg_config_* 目标应为单个信封对象（一份配置）');
    }
    const bytes = await bridge.pull('teg');
    const db = await openDb(bytes);
    let out: Uint8Array;
    try {
      const eobj = parsed as Record<string, unknown>;
      // JSON 编辑“所见即所存”：原样保存，不自动增补 config_name/group_name
      const escMod = mod.replace(/'/g, "''");
      const cnt = Number(
        db.exec(`SELECT COUNT(*) AS c FROM rules WHERE rule_module='${escMod}'`)[0]?.values?.[0]?.[0] ?? 0,
      );
      if (cnt === 0) {
        throw new Error(`teg 当前没有 ${mod} 行，不能保存到 teg（与 SmartP 一致）`);
      }
      // 作者镜像：把编辑器这份 envelope 覆盖该 module 的所有行；rule_version 不动
      upsertRulesContent(db, mod, JSON.stringify(eobj), undefined);
      out = exportDb(db);
    } finally {
      closeDb(db);
    }
    await bridge.push('teg', out);
  }

  await bridge.restart().catch(() => null);
  // 从 DB 重建状态（内容已写入；刷新失败不阻断，由 UI 提示“已保存”）
  try {
    await pullAll();
  } catch {
    // 忽略：内容已写入成功，仅界面重建失败
  }
  return { ok: true, target };
}

/** 数据源可用性（页面门控用）：
 *   - SmartP 有对应内容 → 始终可用（内容为“版本来源选择后”的工作副本，auto 取版本最高者，
 *     与数据源 radio 不冲突）；
 *   - SmartP 空 → 仅当“允许 teg 兜底”且工作副本（来自 teg）有对应内容时才可用；
 *   - 两库都无 → 不可用。 */
export function sourceUsable(configName: string): boolean {
  if (!!state.smartpRaw[configName]) return true;
  if (getDataSourcePref() === 'teg-fallback') return !!state.cloudConfig[configName];
  return false;
}

export function lockCloudVersion(configName: string): number {
  const cc = state.cloudConfig[configName];
  if (!cc) throw new Error(`no config named ${configName}`);
  if (cc.meta?.empty) {
    throw new Error(`${configName}: 空配置，无可锁定的版本`);
  }
  const current = Number(cc.meta.version ?? cc.params?.header?.version ?? 0);
  // 锁定基准：booster 取“当前版本 与 teg 最新 envelope.version 的较大者”（保留尾号）；
  // common_config 以官方 SmartP 版本（meta.version，来源=官方）为基准，不被 teg 带偏。
  const latestTeg = latestEnvelopeVersion(state.rulesByModule[configName]);
  // common_config 以官方 SmartP 版本为锁定基准；booster 维持“取较大者”策略。
  const base =
    configName === 'common_config' ? current : Math.max(current, latestTeg);
  if (!(base > 0)) {
    throw new Error(
      `${configName}: 未找到有效版本号（SmartP 与 teg 均无可用 version），无法锁定`,
    );
  }
  const locked = rewriteYear(base);
  // 记录锁定前真实版本，供“还原 version”恢复（而不是硬编码 2024 开头）。
  if (cc.meta.originalVersion === undefined) {
    cc.meta.originalVersion = current;
  }
  cc.meta.version = locked;
  if (cc.params.header) cc.params.header.version = String(locked);
  syncRuleContent(configName, locked);
  markDirty();
  return locked;
}

export function unlockCloudVersion(configName: string, restored: number): void {
  const cc = state.cloudConfig[configName];
  if (!cc) return;
  cc.meta.version = restored;
  if (cc.params.header) cc.params.header.version = String(restored);
  syncRuleContent(configName, restored);
  markDirty();
}

function rewriteYear(version: number): number {
  const s = String(version);
  if (s.length < 4) return Number(`2099${'0'.repeat(Math.max(0, 10 - s.length))}${s}`);
  return Number(`2099${s.slice(4)}`);
}

export interface PushOptions {
  note?: string;
  source?: HistorySource;
  /** If true, ignore the baseline fingerprint mismatch and overwrite. */
  force?: boolean;
}

/** Commit the in-memory edits: build history record, write both DBs, save
 * history, refresh state. Returns the history filename written. */
async function pushCore(opts: PushOptions = {}): Promise<string> {
  try {
    if (!opts.force) {
      const fresh = await bridge.stat();
      if (state.baselineSmartp) {
        const fp = fingerprint(fresh.smartp.mtime ?? 0, fresh.smartp.size ?? 0);
        if (fp !== state.baselineSmartp) {
          throw new Error(
            `SmartP.db changed on disk since pull (fingerprint ${fp} vs ${state.baselineSmartp}). Pass { force: true } to overwrite.`,
          );
        }
      }
      if (state.baselineTeg) {
        const fp = fingerprint(fresh.teg.mtime ?? 0, fresh.teg.size ?? 0);
        if (fp !== state.baselineTeg) {
          throw new Error(`teg_config.db changed on disk since pull (fingerprint ${fp} vs ${state.baselineTeg}).`);
        }
      }
    }

    // Auto-sync rules.rule_content from the matching cloud_config row, so
    // any edit made via the structured views propagates to the teg mirror
    // without the view layer needing to remember. If teg has rules but is
    // missing common_config, create it (version 2026010101 by default).
    if (hasAnyRules()) ensureCommonConfigRules();
    for (const name of Object.keys(state.cloudConfig)) {
      if (state.rulesByModule[name]?.length) syncRuleContent(name);
    }

    // auto-backup
    await bridge.backup().catch(() => null);

    // ---- 覆写逻辑：按 writeTarget 决定写哪份 DB（默认同时写）。
    // 写入方向一律来自全局覆写逻辑；JSON 编辑已走 saveJsonTarget 独立直写，不经过这里
    const writeTarget = getWriteTarget();
    const writeSmartp = writeTarget === 'both' || writeTarget === 'smartp';
    const writeTeg = writeTarget === 'both' || writeTarget === 'teg';

    // re-pull current bytes, mutate, write back only the chosen target(s)
    const pullTargets: Array<'smartp' | 'teg'> = [];
    if (writeSmartp) pullTargets.push('smartp');
    if (writeTeg) pullTargets.push('teg');
    const [smartpBytes, tegBytes] = await Promise.all([
      writeSmartp ? bridge.pull('smartp') : Promise.resolve(new Uint8Array(0)),
      writeTeg ? bridge.pull('teg') : Promise.resolve(new Uint8Array(0)),
    ]);
    const dbS = writeSmartp ? await openDb(smartpBytes) : null;
    const dbT = writeTeg ? await openDb(tegBytes) : null;

    let outSmartp: Uint8Array | null = null;
    let outTeg: Uint8Array | null = null;
    try {
      if (dbS) {
        for (const [name, obj] of Object.entries(state.cloudConfig)) {
          // 仅写入两库真实存在且非空的配置；空配置不写盘（JSON 编辑用“保存修改”直写）
          if (obj.meta?._real !== true || obj.meta?.empty) continue;
          const serialized = stringifyParams(obj.params);
          // common_config：SmartP.cloud_config 官方没有版本号，写回时不改
          // version 列，避免把模块默认版本号写进 SmartP 造成误导。
          const version =
            name === 'common_config'
              ? undefined
              : typeof obj.meta.version === 'number'
                ? obj.meta.version
                : undefined;
          updateCloudConfigParams(dbS, name, serialized, version);
        }
      }
      if (dbT) {
        for (const [module, rows] of Object.entries(state.rulesByModule)) {
          // When rules table is empty (redmi style), skip.
          if (rows.length === 0) continue;
          const latest = rows[0];
          // 仅写两库真实存在且非空的 module；空配置不写盘
          if (latest.meta?._real !== true || latest.meta?.empty) continue;
          const envelope = latest.content;
          // 信封的 config_name / group_name 与 module 对齐（修正历史空串/坏值）
          if (envelope && typeof envelope === 'object') {
            (envelope as any).config_name = module;
            if (!(envelope as any).group_name) (envelope as any).group_name = module;
          }
          // rule_version 列是 Joyose 内部序号，模块不干预（传 undefined 只更新
          // content，不触碰 rule_version 列；新行插入时 version=null）。
          upsertRulesContent(dbT, module, JSON.stringify(envelope), undefined);
        }
      }

      if (dbS) outSmartp = exportDb(dbS);
      if (dbT) outTeg = exportDb(dbT);
    } finally {
      if (dbS) closeDb(dbS);
      if (dbT) closeDb(dbT);
    }
    void pullTargets;

    const recordBefore = state.pristineSnapshot ??
      snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
    const recordAfter = snapshotFromMaps({
      cloudConfig: state.cloudConfig,
      rulesByModule: state.rulesByModule,
    });

    // persist only the chosen target(s), backed up above regardless
    if (outSmartp) await bridge.push('smartp', outSmartp);
    if (outTeg && Object.values(state.rulesByModule).some((rows) => rows.length > 0)) {
      await bridge.push('teg', outTeg);
    }

    // write history after successful DB push. v2 records store only the
    // forward delta (parent -> this); reconstruction walks the chain from
    // pristineSnapshot. Keeps each file in the KB range.
    const delta = diff(recordBefore, recordAfter);
    const existing = await bridge.historyList();
    const seq = nextSeq(existing);
    const ts = Math.floor(Date.now() / 1000);
    const rec = buildRecord({
      seq,
      timestamp: ts,
      source: opts.source ?? 'webui',
      note: opts.note ?? '',
      delta,
    });
    const fname = buildHistoryFilename(ts, seq);
    await bridge.historySave(fname, JSON.stringify(rec));
    // 历史最多保留最新 10 条（用户要求，越小越好管理）
    await bridge.historyClear(10).catch(() => null);

    // restart Joyose so it picks up the new values
    await bridge.restart().catch(() => null);

    state.pristineSnapshot = recordAfter;
    state.dirty = false;
    await refreshStat();
    if (state.stat?.smartp.exists) {
      state.baselineSmartp = fingerprint(state.stat.smartp.mtime ?? 0, state.stat.smartp.size ?? 0);
    }
    if (state.stat?.teg.exists) {
      state.baselineTeg = fingerprint(state.stat.teg.mtime ?? 0, state.stat.teg.size ?? 0);
    }
    return fname;
  } finally {
    /* state.loading 由外层 pushAll 统一管理 */
  }
}

/**
 * 提交遇磁盘指纹冲突（Joyose 后台更新过 SmartP/teg）时，把当前内存中未提交的
 * 改动 rebase 到 Joyose 最新状态上：保留 meta（锁定版本等），把 params 改动
 * 用 diff/applyDelta 叠加到最新基底，随后重推。让普通使用者无需手动 force。
 */
async function rebaseOntoLatest(): Promise<void> {
  const baseSnap =
    state.pristineSnapshot ??
    snapshotFromMaps({ cloudConfig: state.cloudConfig, rulesByModule: state.rulesByModule });
  const nowSnap = snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  });
  const delta = diff(baseSnap, nowSnap);

  // 保留内存中的 meta（用户可能已锁定版本 / 切了来源）
  const metasBefore: Record<string, any> = {};
  for (const [k, v] of Object.entries(state.cloudConfig)) {
    metasBefore[k] = JSON.parse(JSON.stringify((v as any).meta ?? null));
  }

  const [smartpBytes, tegBytes] = await Promise.all([
    bridge.pull('smartp'),
    bridge.pull('teg'),
  ]);
  const dbS = await openDb(smartpBytes);
  const dbT = await openDb(tegBytes);
  try {
    readIntoState(dbS, dbT);
  } finally {
    closeDb(dbS);
    closeDb(dbT);
  }

  // 恢复用户 meta，再把 params 改动叠加到最新基底
  for (const [k, m] of Object.entries(metasBefore)) {
    if (state.cloudConfig[k] && m) (state.cloudConfig[k] as any).meta = m;
  }
  const newestSnap = snapshotFromMaps({
    cloudConfig: state.cloudConfig,
    rulesByModule: state.rulesByModule,
  });
  const merged = applyDelta(newestSnap, delta);
  rehydrateFromSnapshot(merged);
  state.pristineSnapshot = newestSnap;
  state.dirty = true;
}

/** 公共提交入口：冲突自动 rebase 重试（最多 3 次），仍失败才把错误抛给上层。 */
export async function pushAll(opts: PushOptions = {}): Promise<string> {
  state.loading = true;
  try {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await pushCore(opts);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!opts.force && msg.includes('changed on disk since pull') && attempt < 2) {
          try {
            await rebaseOntoLatest();
            continue;
          } catch (rebaseErr) {
            lastErr = rebaseErr;
          }
        }
        throw lastErr;
      }
    }
    throw lastErr;
  } finally {
    state.loading = false;
  }
}

/** Walk the commit chain from the working tree (`pristineSnapshot`) back to
 * the post-state of `targetSeq`, applying inverse deltas, then rehydrate
 * the resulting snapshot into the in-memory state. Semantics mirror
 * `git checkout <commit>`: you land on the state at the end of that commit.
 * To see the pre-state of commit N, restore to commit N-1 instead. */
export async function restoreToRecord(targetSeq: number): Promise<void> {
  if (!state.pristineSnapshot) {
    throw new Error('working tree 未初始化，先在概览点刷新');
  }
  const meta = await listHistory();
  const newer = meta.filter((m) => m.seq > targetSeq);
  if (!meta.some((m) => m.seq === targetSeq)) {
    throw new Error(`未找到 seq=${targetSeq} 的历史记录`);
  }

  let snap: ConfigSnapshot = JSON.parse(JSON.stringify(state.pristineSnapshot));
  for (const m of newer) {
    const rec = await readHistory(m.name);
    snap = applyDelta(snap, invertDelta(rec.delta));
  }
  rehydrateFromSnapshot(snap);
  state.dirty = true;
}

function rehydrateFromSnapshot(snap: ConfigSnapshot): void {
  // snapshot only carries parsed content; preserve meta from current state
  for (const [name, params] of Object.entries(snap.smartp.cloud_config)) {
    if (!state.cloudConfig[name]) continue;
    state.cloudConfig[name].params = params;
  }
  for (const [module, contents] of Object.entries(snap.teg.rules)) {
    const rows = state.rulesByModule[module];
    if (!rows) continue;
    for (let i = 0; i < rows.length && i < contents.length; i++) {
      rows[i].content = contents[i];
    }
  }
  if (state.cloudConfig.booster_config) {
    state.paths = detectPaths(state.cloudConfig.booster_config.params ?? {});
  }
}

// ---- history helpers exposed to views -----------------------------------
export async function listHistory(): Promise<HistoryFileMeta[]> {
  const names = await bridge.historyList();
  return names
    .map((n) => parseHistoryFilename(n))
    .filter((m): m is HistoryFileMeta => !!m)
    .sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
}

export async function readHistory(name: string): Promise<HistoryRecord> {
  return JSON.parse(await bridge.historyGet(name));
}

/**
 * Write a marker history entry noting that a raw DB backup was taken.
 * Empty delta = timeline anchor, no state transition. Restoration still
 * goes through `bridge.revert(backupName)` (file-level DB copy), unrelated
 * to the commit chain. File size: ~200 bytes.
 */
export async function recordBackupCheckpoint(backupName: string): Promise<void> {
  const existing = await bridge.historyList();
  const seq = nextSeq(existing);
  const ts = Math.floor(Date.now() / 1000);
  const rec = buildRecord({
    seq,
    timestamp: ts,
    source: 'backup',
    note: backupName,
    delta: [],
  });
  await bridge.historySave(buildHistoryFilename(ts, seq), JSON.stringify(rec));
  // 备份检查点同样只保留最新 10 条历史
  await bridge.historyClear(10).catch(() => null);
}

export function buildHistoryStore() {
  return new DriverBackedStore({
    async listNames() {
      return bridge.historyList();
    },
    async readText(name: string) {
      return bridge.historyGet(name);
    },
    async writeText(name: string, content: string) {
      await bridge.historySave(name, content);
    },
    async remove() {
      // bridge.historyClear(keep) handles bulk remove; single-file remove is
      // deliberately not exposed.
      throw new Error('direct history removal not supported — use historyClear()');
    },
  });
}
