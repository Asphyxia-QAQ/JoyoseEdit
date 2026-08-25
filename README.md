# JoyoseEdit

一个 **KernelSU WebUI 模块**，用于可视化编辑小米 / 红米 Joyose 的 V3 云控配置
（`/data/user/0/com.xiaomi.joyose/databases/SmartP.db` 与 `teg_config.db`），
免去 Scene / SQLite Browser 手搓字符串的苦力。**仅支持 V3。**

## 实测情况

项目作者使用 Xiaomi 17 Pro Max，**只有 MIFISR 这一条路径有实机验证**。其余路径的解析器能够
字节级 round-trip 仓库内的样本 DB，但真机上改动是否生效**未验证**，请自行承担风险。

| 机型              | 主路径            | 验证方式                              |
| ----------------- | ----------------- | ------------------------------------- |
| Xiaomi 17 Pro Max | MIFISR            | **实机**（作者主设备）                |
| Xiaomi 17 Ultra   | MIFISR            | 样本 + 反编译对照                     |
| Xiaomi 15         | 高通 GPU（AFME）  | 仅样本 DB round-trip                  |
| Xiaomi 15 Pro     | 高通 GPU（AFME）  | 仅样本 DB round-trip                  |
| Redmi K90 Pro Max | Novatek 独显      | 仅样本 DB round-trip                  |

其它 V3 机型若 DB 形状一致可以试，遇到未识别字段会走 JSON 兜底编辑。

## 核心能力

- **四条路径都能编辑**：MIFISR（17 系列）、高通 GPU（15 系列 AFME / FRC / FSR）、
  Novatek 独显（红米 K90 Pro Max）、MIVK / MIGL（渲染 module 通用）。
- **无中生有添加条目**：云端未下发时也能直接在 WebUI 里新建 `game_mifisr_config` /
  `frc_game_params` / `novatek_game_params` 条目和对应的 `fisr_config` 路由。
- **冻结云控**：直接冻结 teg SDK 的 `pref_local_max_version`，让设备永远声称"已是最新版"，
  云端不再下发规则。辅以 DB 里 `version` 字段的 2099 年份锁作旁路保护。
- **全量备份 / 任意回滚**：每次提交自动写一次 DB 二进制备份 + 一条累积历史
  （before / after JSON + diff）；任何历史点都能回滚，回滚本身也追加为新历史。
- **安全护栏**：所有 root 操作走 `bin/joyose-edit.sh` 子命令白名单；写入前比对 DB
  磁盘指纹防冲突；所有解析器的 `serialize(parse(s)) === s` 都在 `npm test` 里校验。

## 安装

1. 到 [release/](./release/) 取最新 zip（或自己 `npm run build && npm run package` 生成）。
2. 在 KernelSU 管理器"安装模块"选择该 zip，重启。
3. 回到 KernelSU 管理器，打开 JoyoseEdit 模块的 "WebUI"。

## WebUI 页面

| 页面         | 作用                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 概览         | DB 状态 / 路径探测 / 快速备份                                           |
| 云控锁定     | 冻结 teg SDK（推荐） + DB version 2099 锁（辅助）                       |
| 去除锁帧     | 关闭 cgame_enable、删除 dynamic_fps_global 与所有 PID_* / dynamic_fps* 字段 |
| 温度解锁     | 把所有插帧/超分温度阈值抬到 ~90°C（45#43#41 → 95#93#91）                 |
| 游戏列表     | 编辑 `common_config.params.game_list` / `support_app`                   |
| MIFISR       | 17 系列插帧 + 超分面板（`game_mifisr_config` + `fisr_config` 路由）     |
| 高通 GPU     | `frc_game_params` 表单 + `fisr_config` 预设                             |
| Novatek 独显 | 三段字符串（独显 A / GPU 方案 / 独显 B）结构化编辑                      |
| MIVK / MIGL  | 渲染 module 细化（`mifi` / `misr` / `vrs` / `hsre` / `drr` / `gmem` …） |
| JSON 编辑    | 兜底：直接改 `params` / `rule_content`（CodeMirror 6）                  |
| 编辑历史     | 全量历史 + diff + 回滚                                                  |
| 导入 / 导出  | 跨设备分享 JSON 配置包                                                  |

（MIFISR / 高通 / Novatek 三项按当前设备后端自动显示/隐藏。）

## 本地开发

```bash
npm install

# 对 5 台样本 DB 全路径 round-trip
npm test

# 类型检查 + 生产构建 → dist/
npm run build

# 打包 KernelSU 安装 zip → release/joyose-edit-<ver>-<count>[-dirty]-<sha>.zip
# commit-count 写入 module.prop 的 versionCode，KernelSU 据此识别更新
npm run package

# 浏览器热更新（无 KernelSU 桥，root 操作会报 unavailable）
npm run dev
```

## 源码导航

```text
module/                   KernelSU 模块载荷（customize / post-fs-data / bin）
  bin/joyose-edit.sh      所有特权操作的唯一入口；子命令白名单
src/parsers/              各 per-game 字符串格式的 parse / serialize / validate
src/parsers/fpslock.ts        去除锁帧：PID_* / dynamic_fps* 前缀匹配 + cgame/全局曲线清理
src/parsers/thermal-unlock.ts 去除插帧温度限制：识别连续温度组并抬升至 ~90°C（安全，不碰帧率）
src/db/                   sql.js 封装 + DB 路径探测 + 磁盘指纹
src/history/              累积式历史 + diff + rule_content 信封同步
src/root/bridge.ts        ksu.exec 封装 + shell 白名单类型化包装
src/ui/                   Vue 3 SFC（各功能页 + Overview / Lock / History …）
tests/run.mts             端到端 harness（npm test）
tests/<device>/           5 台机型的样本 SmartP.db / teg_config.db
scripts/package-module.mjs 打包脚本（dist/ + module/ → zip）
CLAUDE.md                 反编译笔记 + 维护者手册
```

## 注意事项

- DB 格式基于四台实机样本 + jadx 反编译 Joyose 推断，未覆盖的机型可能有新字段，
  UI 会通过"JSON 编辑"兜底暴露，不阻塞使用。
- 本模块**不向云端发起任何请求**，所有处理都在本地完成。
- 写入前自动备份到 `/data/adb/joyose-edit/backup/`；可在"概览"里回滚最近备份，
  或 `sh bin/joyose-edit.sh revert-latest` 命令行回滚。
- 云端下发新版时若未冻结 teg SDK，你的修改可能被覆盖；想稳就用"云控锁定"页的冻结。
- 小米 17 Pro Max 原厂未声明 `ro.vendor.gpp.frc.support` / `ro.vendor.xiaomi.sr.support`，
  即便 DB 配好游戏助手也不会显示画质增强面板；MifisrView 顶部 banner 会提示，并给出
  `resetprop` 临时开启命令。永久生效需要另装模块在开机阶段写 vendor 属性。

## 许可

MIT（见 LICENSE）。
