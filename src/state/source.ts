// Source-of-truth selection for booster_config.
//
// Joyose keeps the same cloud JSON in two databases:
//   - SmartP.db  cloud_config.params            (key column version, e.g. 2026042590)
//   - teg_config.db rules.rule_content          (an envelope { ..., version,
//                                                 params } with several rows of
//                                                 history per module)
// The two `version` numbers use the SAME YYYYMMDDxx scheme, but the rules
// table also has an internal `rule_version` (a monotonically increasing
// ordinal like 649438) that must NOT be compared against SmartP's version.
// The envelope.version is the comparable one.
//
// Choice policy:
//   · common_config always comes from SmartP.db.
//   · booster_config follows a user preference:
//       auto   -> the side with the higher envelope.version wins
//       smartp -> always SmartP.db
//       teg    -> always the latest teg row
//   · When teg is selected, the row with the highest envelope.version is used
//     (the rows table keeps multiple historical releases).

export type BoosterSourcePref = 'auto' | 'smartp' | 'teg';

const KEY = 'joyose-edit.boosterSource';

export function getBoosterSourcePref(): BoosterSourcePref {
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'smartp' || v === 'teg') return v;
    } catch {
      /* storage unavailable */
    }
  }
  return 'auto';
}

export function setBoosterSourcePref(v: BoosterSourcePref): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* ignore */
    }
  }
}

// ----- common_config source (independent from booster_config) -----

const COMMON_KEY = 'joyose-edit.commonSource';

/** common_config source preference. Defaults to SmartP.db — the teg mirror of
 *  common_config is frequently stub/incomplete, so the user must opt into teg
 *  explicitly via the Overview selector. */
export function getCommonSourcePref(): BoosterSourcePref {
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(COMMON_KEY);
      if (v === 'smartp' || v === 'teg') return v;
    } catch {
      /* storage unavailable */
    }
  }
  return 'smartp';
}

export function setCommonSourcePref(v: BoosterSourcePref): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(COMMON_KEY, v);
    } catch {
      /* ignore */
    }
  }
}

// ----- write target (覆写逻辑) -----

export type WriteTarget = 'both' | 'smartp' | 'teg';

const WRITE_KEY = 'joyose-edit.writeTarget';

/** Which database(s) a commit should write to. Global — every view's push
 *  (including DB version lock, unlocked-fps, thermal unlock, …) honours it.
 *  Defaults to 'both' (mirror both DBs, the historical behaviour). */
export function getWriteTarget(): WriteTarget {
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(WRITE_KEY);
      // 用户显式选择（both / smartp / teg）优先，且后续启动一直基于此选择
      if (v === 'both' || v === 'smartp' || v === 'teg') return v;
    } catch {
      /* storage unavailable */
    }
  }
  // 第一次启动默认同时写 SmartP.db + teg_config.db
  return 'both';
}

export function setWriteTarget(v: WriteTarget): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(WRITE_KEY, v);
    } catch {
      /* ignore */
    }
  }
}

const INSTALL_TS_KEY = 'joyose-edit.installTs';

/** 记录已消费的安装标记（localStorage）。 */
export function getStoredInstallTs(): string {
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem(INSTALL_TS_KEY) ?? '';
    } catch {
      /* ignore */
    }
  }
  return '';
}

export function storeInstallTs(ts: string): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(INSTALL_TS_KEY, ts);
    } catch {
      /* ignore */
    }
  }
}

/** 清空所有本地偏好（模块重装后调用），让各设置回到默认：
 *  覆写逻辑=both、booster 来源=auto、common 来源=smartp。 */
export function resetAllPrefs(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(WRITE_KEY);
    localStorage.removeItem(KEY);
    localStorage.removeItem(COMMON_KEY);
    localStorage.removeItem(INSTALL_TS_KEY);
    localStorage.removeItem(DATA_SOURCE_KEY);
  } catch {
    /* ignore */
  }
}

// ----- 数据源策略（SmartP 检测 vs teg 兜底）-----
export type DataSourcePref = 'smartp' | 'teg-fallback';

const DATA_SOURCE_KEY = 'joyose-edit.dataSource';

/** 数据源策略：
 *   - smartp       ：仅 SmartP（与原作者一致）。SmartP 无对应内容 → 页面不可用。
 *   - teg-fallback ：允许 teg 兜底。SmartP 无内容（或损坏）时也可用 teg 的内容；
 *                    且此后所有修改/锁定都只写到 teg_config.db，SmartP 完全不碰。 */
export function getDataSourcePref(): DataSourcePref {
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(DATA_SOURCE_KEY);
      if (v === 'smartp' || v === 'teg-fallback') return v;
    } catch {
      /* storage unavailable */
    }
  }
  return 'smartp';
}
export function setDataSourcePref(v: DataSourcePref): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(DATA_SOURCE_KEY, v);
    } catch {
      /* ignore */
    }
  }
}
export const DATA_SOURCE_LABELS: Record<DataSourcePref, string> = {
  smartp: '仅 SmartP（默认）',
  'teg-fallback': '允许 teg 兜底',
};

export const WRITE_TARGET_LABELS: Record<WriteTarget, string> = {
  both: '同时写 SmartP.db + teg_config.db（默认）',
  smartp: '仅 SmartP.db（cloud_config）',
  teg: '仅 teg_config.db（rules）',
};

export interface SmartRowLike {
  meta?: { version?: number | null };
  params?: any;
}

export interface TegRowLike {
  meta?: { rule_version?: number | null };
  content?: unknown;
}

/** Latest comparable envelope.version across teg rows (0 when none usable).
 *  Used by the Overview to show SmartP vs teg versions side by side. */
export function latestEnvelopeVersion(tegRows: TegRowLike[] | undefined): number {
  // 只认 envelope.version（YYYYMMDDxx 体系）。rule_version 是内部单调序号，
  // 绝不能被当成版本号（否则 teg 空配置时会显示 467472 / 706918 这类垃圾）。
  let best = 0;
  for (const r of tegRows ?? []) {
    const env = r.content;
    const envParams =
      env && typeof env === 'object' && !Array.isArray(env)
        ? (env as any).params
        : null;
    if (!envParams || typeof envParams !== 'object') continue;
    const v = Number((env as any).version);
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

export interface PickedBooster {
  params: any;
  /** The comparable version (envelope.version when teg wins, else smartp). */
  version: number;
  /** Which side the params came from. */
  source: 'smartp' | 'teg';
}

export const PREF_LABELS: Record<BoosterSourcePref, string> = {
  auto: '自动（版本较新者优先）',
  smartp: 'SmartP.db（cloud_config）',
  teg: 'teg_config.db（rules 最新）',
};

/** Decide which booster_config params to edit from the two candidate rows.
 *  Pure & testable. Returns null only when smartp row is missing. */
export function pickBoosterParams(
  smartRow: SmartRowLike | undefined,
  tegRows: TegRowLike[] | undefined,
  pref: BoosterSourcePref,
): PickedBooster | null {
  if (!smartRow) return null;

  if (pref !== 'smartp' && Array.isArray(tegRows) && tegRows.length > 0) {
    let best: { version: number; params: any } | null = null;
    for (const r of tegRows) {
      const env = r.content;
      const envParams =
        env && typeof env === 'object' && !Array.isArray(env)
          ? (env as any).params
          : null;
      if (!envParams || typeof envParams !== 'object') continue;
      const v = Number((env as any).version);
      if (!Number.isFinite(v) || v <= 0) continue; // 无有效 envelope.version 不算
      if (!best || v > best.version) best = { version: v, params: envParams };
    }
    if (best) {
      const smartV = Number(smartRow.meta?.version ?? 0);
      if (pref === 'teg' || best.version > smartV) {
        return { params: best.params, version: best.version, source: 'teg' };
      }
    }
  }

  return {
    params: smartRow.params,
    version: Number(smartRow.meta?.version ?? 0),
    source: 'smartp',
  };
}