#!/system/bin/sh
# JoyoseEdit — KernelSU install script.
# Keeps the module scope narrow: sets up the private data dir and surfaces WebUI entry.

SKIPUNZIP=0

MODDIR="$MODPATH"
DATA_ROOT=/data/adb/joyose-edit

# 区分“全新安装/卸载后重装”与“升级更新”：
#   DATA_ROOT 已存在 → 说明装过旧版本（升级）→ 不重置用户偏好
#   DATA_ROOT 不存在 → 首次安装 / 卸载后重装 → 写安装标记（WebUI 据此重置偏好）
INSTALL_FRESH=0
if [ ! -d "$DATA_ROOT" ]; then INSTALL_FRESH=1; fi

ui_print "- Creating module data directory at $DATA_ROOT"
mkdir -p "$DATA_ROOT/backup"
mkdir -p "$DATA_ROOT/history"
chmod 700 "$DATA_ROOT"
chmod 700 "$DATA_ROOT/backup"
chmod 700 "$DATA_ROOT/history"

# Ensure the root helper is executable.
if [ -f "$MODDIR/bin/joyose-edit.sh" ]; then
  set_perm "$MODDIR/bin/joyose-edit.sh" 0 0 0700
fi

# 仅“全新安装/卸载后重装”写入新的安装标记 → WebUI 重置本地偏好（覆写逻辑默认
# 同时写等）；升级更新不写（保持用户上次选择）。卸载会清 DATA_ROOT，重装自然视为全新。
if [ "$INSTALL_FRESH" = 1 ]; then
  echo "$(date +%s)" > "$MODDIR/.install_ts" 2>/dev/null || true
  chmod 644 "$MODDIR/.install_ts" 2>/dev/null || true
fi

ui_print "- WebUI entry: webroot/index.html"
ui_print "- Target Joyose package: com.xiaomi.joyose"
ui_print "- Supported DB path:"
ui_print "    /data/user/0/com.xiaomi.joyose/databases/SmartP.db"
ui_print "    /data/user/0/com.xiaomi.joyose/databases/teg_config.db"
ui_print ""
ui_print "  Open the module in KernelSU manager to launch the WebUI."
