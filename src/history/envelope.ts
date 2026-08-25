// teg_config.rules.rule_content wraps a cloud_config row's `params` in an
// envelope. The shape is stable across samples we inspected — Joyose treats
// this mirror as a fallback when cloud_config is missing, so we need to keep
// it in perfect sync with cloud_config whenever we mutate params / version.

export interface RuleEnvelope<T = unknown> {
  config_name: string;
  group_name: string;
  enable: boolean;
  version: number;
  with_model: boolean;
  params: T;
}

export function buildRuleEnvelope<T>(
  configName: string,
  params: T,
  version: number,
): RuleEnvelope<T> {
  return {
    config_name: configName,
    group_name: configName,
    enable: true,
    version,
    with_model: false,
    params,
  };
}

/** Given a freshly parsed `rule_content` envelope, substitute fresh `params`
 * (and optionally bump `version`). Returns a new object; the original stays
 * untouched so diffs remain meaningful. */
export function refreshEnvelope<T>(
  envelope: RuleEnvelope<unknown> | null | undefined,
  params: T,
  version?: number,
  /** 新建镜像行时使用的 config_name / group_name（envelope 为 null 或缺名时）。 */
  fallbackName?: string,
): RuleEnvelope<T> {
  const base = envelope
    ? { ...envelope }
    : buildRuleEnvelope(fallbackName ?? '__unknown__', params, version ?? 0);
  // 补齐所有字段为确定值——官方 envelope 固定包含这 6 个键，缺字段会让
  // JSON.stringify 丢掉 undefined 键，导致写入 teg 后只剩 version/params。
  const groupName =
    typeof base.group_name === 'string' && base.group_name !== ''
      ? base.group_name
      : typeof base.config_name === 'string' && base.config_name !== ''
        ? base.config_name
        : fallbackName ?? '';
  return {
    config_name:
      typeof base.config_name === 'string' && base.config_name !== ''
        ? base.config_name
        : fallbackName ?? '',
    group_name: groupName,
    enable: typeof base.enable === 'boolean' ? base.enable : true,
    version: typeof version === 'number' ? version : base.version,
    with_model: typeof base.with_model === 'boolean' ? base.with_model : false,
    params,
  };
}
