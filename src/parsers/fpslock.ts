// "去除锁帧" feature — strip Joyose's FPS-capping knobs from a parsed
// booster_config.params tree.
//
// What Joyose uses to force a frame cap / scale the surface down by
// temperature:
//   - game_booster.cgame_enable        : master switch for cloud game control.
//                                        Set to false so the device stops
//                                        applying cloud FPS governance.
//   - game_booster.dynamic_fps_global  : global "dynamic frame rate" curve.
//                                        Removed entirely.
//   - keys named like `PID_*` (PID_T / PID_M / PID_HQ2_T / PID_HQ2_M /
//                        PID_RE2_T / PID_RE3_M ...) and `dynamic_fps*`
//                        (dynamic_fps / dynamic_fps_M / dynamic_fps_T ...)
//     live on per-game entries (game_booster.booster_config.ovrride_config[])
//     and encode temperature->target FPS curves / PID tuning tables.
//
// We match by *prefix* (PID_ / dynamic_fps) rather than an exact key list so
// that new variants shipped by future cloud rules are caught automatically —
// this is the fix for "old list missed PID_RE* / dynamic_fps_T".
//
// All operations are idempotent and mutate nothing that is not lock-frame
// related.

/** True for any key that encodes frame-rate capping. Matched by prefix so
 *  official new variants (PID_RE2_T, dynamic_fps_T, ...) are stripped too. */
export function isFpsLockKey(key: string): boolean {
  return key.startsWith('PID_') || key.startsWith('dynamic_fps');
}

export interface FpsLockEntry {
  /** game_name from ovrride_config, or the enclosing key when not an entry. */
  name: string;
  /** lock-frame keys found on this object. */
  keys: string[];
}

export interface FpsLockScan {
  /** Current game_booster.cgame_enable value; null when the field is absent. */
  cgameEnables: boolean | null;
  /** Whether game_booster.dynamic_fps_global is present. */
  hasDynamicFpsGlobal: boolean;
  /** Total number of lock-frame keys found in the whole booster tree. */
  totalKeys: number;
  /** Count per key name, over the whole tree. */
  countByKey: Record<string, number>;
  /** ovrride_config entries that carry at least one lock-frame key. */
  entries: FpsLockEntry[];
}

export interface UnlockFpsResult {
  /** Count of removed keys, grouped by key name. */
  removedByKey: Record<string, number>;
  /** Number of ovrride_config entries that lost at least one key. */
  entriesAffected: number;
  /** game_name of affected ovrride_config entries. */
  affectedEntries: string[];
  /** Whether game_booster.cgame_enable was flipped to false. */
  cgameDisabled: boolean;
  /** Whether game_booster.dynamic_fps_global was removed. */
  globalDfRemoved: boolean;
  /** Whether anything actually changed. */
  changed: boolean;
}

function collectLockKeys(node: unknown, countByKey: Record<string, number>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectLockKeys(item, countByKey);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (isFpsLockKey(k)) countByKey[k] = (countByKey[k] ?? 0) + 1;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') collectLockKeys(v, countByKey);
  }
}

function stripLockKeys(node: unknown, removedByKey: Record<string, number>): void {
  if (Array.isArray(node)) {
    for (const item of node) stripLockKeys(item, removedByKey);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (isFpsLockKey(k)) {
      delete obj[k];
      removedByKey[k] = (removedByKey[k] ?? 0) + 1;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') stripLockKeys(v, removedByKey);
  }
}

function collectOverrideEntries(params: unknown): FpsLockEntry[] {
  const booster = (params ?? {}) as Record<string, any>;
  const gb = (booster.game_booster ?? {}) as Record<string, any>;
  const ovrride = Array.isArray(gb.booster_config?.ovrride_config)
    ? (gb.booster_config.ovrride_config as unknown[])
    : [];
  const out: FpsLockEntry[] = [];
  for (const item of ovrride) {
    if (!item || typeof item !== 'object') continue;
    const keys = Object.keys(item as Record<string, unknown>).filter((k) =>
      isFpsLockKey(k),
    );
    if (keys.length > 0) {
      out.push({ name: String((item as any).game_name ?? '?'), keys });
    }
  }
  return out;
}

/** Inspect a parsed booster_config.params tree and report the current
 *  lock-frame state. Does not mutate anything. */
export function scanFpsLock(params: unknown): FpsLockScan {
  const booster = (params ?? {}) as Record<string, any>;
  const gb = (booster.game_booster ?? {}) as Record<string, any>;

  const countByKey: Record<string, number> = {};
  collectLockKeys(params, countByKey);
  const totalKeys = Object.values(countByKey).reduce((a, b) => a + b, 0);

  return {
    cgameEnables: typeof gb.cgame_enable === 'boolean' ? gb.cgame_enable : null,
    hasDynamicFpsGlobal: 'dynamic_fps_global' in gb,
    totalKeys,
    countByKey,
    entries: collectOverrideEntries(params),
  };
}

/** Apply the "去除锁帧" transform in place on a parsed booster_config.params
 *  tree: disable cgame_enable, drop dynamic_fps_global and every lock-frame
 *  key. Idempotent — safe to run repeatedly. */
export function applyUnlockFps(params: unknown): UnlockFpsResult {
  const booster = (params ?? {}) as Record<string, any>;
  const gb = (booster.game_booster ?? {}) as Record<string, any>;

  // Snapshot per-entry lock-frame state before we strip, so the report
  // reflects the change actually made.
  const beforeEntries = collectOverrideEntries(params);

  const removedByKey: Record<string, number> = {};
  stripLockKeys(params, removedByKey);

  let cgameDisabled = false;
  if ('cgame_enable' in gb) {
    if (gb.cgame_enable !== false) {
      gb.cgame_enable = false;
      cgameDisabled = true;
    }
  }

  let globalDfRemoved = false;
  if ('dynamic_fps_global' in gb) {
    delete gb.dynamic_fps_global;
    globalDfRemoved = true;
  }

  const affectedEntries = beforeEntries.map((e) => e.name);
  const changed =
    cgameDisabled ||
    globalDfRemoved ||
    Object.keys(removedByKey).length > 0;

  return {
    removedByKey,
    entriesAffected: affectedEntries.length,
    affectedEntries,
    cgameDisabled,
    globalDfRemoved,
    changed,
  };
}