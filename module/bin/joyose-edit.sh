#!/system/bin/sh
# JoyoseEdit privileged helper.
# Called from the KernelSU WebUI via ksu.exec. Positional-arg whitelist only —
# never interpolate user-supplied strings as shell code.
#
# Subcommands:
#   stat                           prints schema/version fingerprints as JSON
#   pull smartp|teg                emits base64 of the DB file
#   push smartp|teg <b64>          decodes <b64> and writes back atomically
#   backup [label]                 snapshot both DBs into /data/adb/joyose-edit/backup/<epoch>[-label]/
#   revert <epoch-label>           restore a specific backup
#   revert-latest                  restore most recent backup
#   restart                        am force-stop com.xiaomi.joyose
#   history-list                   list every history file (one JSON per line)
#   history-get <name>             print the contents of one history file
#   history-clear <keep>           keep N newest, remove the rest
#   (history write goes through history-save-from-stage; see staging section)
#   cat-wasm                       emit base64 of webroot/assets/sql-wasm.wasm
#                                  (workaround for WebView asset handlers that
#                                   refuse .wasm fetches)
#   vision-status                  report vendor FRC/SR flags
#   teg-status                     report teg SDK pref_local_max_version
#   teg-freeze                     pin teg SDK pref_local_max_version to Long.MAX_VALUE
#                                  (stops teg cloud pushes from overwriting teg_config.db)
#   teg-unfreeze                   reset teg SDK pref_local_max_version to 0
#                                  (re-enables teg cloud updates)
#
# The base64 arguments carry DB bytes / history JSON; the kernelsu WebUI
# bridge does not expose stdin, so all payload goes through argv. Modern
# Android has ARG_MAX >= 2 MB which comfortably fits our largest payload
# (~1 MB for the teg_config.db mirror on a K90 Pro Max sample).

set -eu

DATA_ROOT=/data/adb/joyose-edit
STAGE_DIR="$DATA_ROOT/stage"
DB_DIR=/data/user/0/com.xiaomi.joyose/databases
SMARTP="$DB_DIR/SmartP.db"
TEG="$DB_DIR/teg_config.db"
PKG=com.xiaomi.joyose

mkdir -p "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"
chmod 700 "$DATA_ROOT" "$DATA_ROOT/backup" "$DATA_ROOT/history" "$STAGE_DIR"

die() { printf '{"ok":false,"error":%s}\n' "$(printf '%s' "$1" | _json_string)"; exit 1; }

# ---- helpers --------------------------------------------------------------
_json_string() {
  # stdin -> JSON string literal (quote + escape)
  awk 'BEGIN{printf "\""} {
    gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t");
    gsub(/\r/,"\\r"); printf "%s\\n", $0
  } END{printf "\""}'
}

resolve_db() {
  case "$1" in
    smartp) printf '%s' "$SMARTP" ;;
    teg)    printf '%s' "$TEG" ;;
    *)      die "unknown db selector: $1" ;;
  esac
}

# Sanity-check a backup / history filename: restrict to a safe character set
# so user input can never escape the directory or the DB paths.
safe_name() {
  case "$1" in
    ''|*..*|*/*|*\\*|*\&*|*\|*|*\;*|*\`*|*\$*|*\(*|*\)*|*\<*|*\>*) return 1 ;;
    *) return 0 ;;
  esac
}

stat_one() {
  local f="$1" key="$2"
  if [ -f "$f" ]; then
    local mtime size uid gid
    mtime=$(stat -c '%Y' "$f" 2>/dev/null || echo 0)
    size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
    uid=$(stat -c '%u' "$f" 2>/dev/null || echo 0)
    gid=$(stat -c '%g' "$f" 2>/dev/null || echo 0)
    printf '"%s":{"exists":true,"path":"%s","mtime":%s,"size":%s,"uid":%s,"gid":%s}' \
      "$key" "$f" "$mtime" "$size" "$uid" "$gid"
  else
    printf '"%s":{"exists":false,"path":"%s"}' "$key" "$f"
  fi
}

# ---- subcommands ----------------------------------------------------------
cmd_stat() {
  printf '{"ok":true,'
  printf '"pkg":"%s",' "$PKG"
  printf '"data_root":"%s",' "$DATA_ROOT"
  stat_one "$SMARTP" smartp
  printf ','
  stat_one "$TEG" teg
  printf ',"backup_count":%s' "$(ls "$DATA_ROOT/backup" 2>/dev/null | wc -l | tr -d ' \n')"
  printf ',"history_count":%s' "$(ls "$DATA_ROOT/history" 2>/dev/null | wc -l | tr -d ' \n')"
  printf '}\n'
}

cmd_pull() {
  local target
  target=$(resolve_db "$1")
  [ -f "$target" ] || die "missing: $target"
  # base64 -w0 — single line so the WebUI can slurp it directly.
  base64 -w0 "$target"
  echo
}

cmd_push() {
  local sel="$1" b64="$2" target tmp uid gid
  [ -n "$b64" ] || die "push: missing base64 payload"
  target=$(resolve_db "$sel")
  [ -f "$target" ] || die "missing: $target"
  uid=$(stat -c '%u' "$target")
  gid=$(stat -c '%g' "$target")
  tmp="$target.jedit.$$"
  # decode directly into the sibling tmp, then rename atomically.
  printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  # quick sanity: must be a SQLite file
  head -c 16 "$tmp" | grep -qa 'SQLite format 3' || { rm -f "$tmp"; die "not a sqlite db"; }
  chown "$uid:$gid" "$tmp" 2>/dev/null || true
  chmod 660 "$tmp"
  mv -f "$tmp" "$target"
  # SELinux labels: copy from sibling file to keep Joyose happy if present.
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$target" 2>/dev/null || true
  fi
  printf '{"ok":true,"path":"%s","uid":%s,"gid":%s}\n' "$target" "$uid" "$gid"
}

cmd_backup() {
  local label="${1:-}" stamp dir
  stamp=$(date +%s)
  if [ -n "$label" ]; then
    safe_name "$label" || die "invalid label"
    dir="$DATA_ROOT/backup/${stamp}-${label}"
  else
    dir="$DATA_ROOT/backup/${stamp}"
  fi
  mkdir -p "$dir"
  chmod 700 "$dir"
  [ -f "$SMARTP" ] && cp -f "$SMARTP" "$dir/SmartP.db"
  [ -f "$TEG" ] && cp -f "$TEG" "$dir/teg_config.db"
  printf '{"ok":true,"dir":"%s","name":"%s"}\n' "$dir" "$(basename "$dir")"

  # Keep only the newest 10 backups (by mtime). Use a pipe (not process
  # substitution) so this stays compatible with Android mksh/dash.
  local keep=10 i=0
  ls -dt "$DATA_ROOT/backup"/*/ 2>/dev/null | while read -r d; do
    i=$((i+1))
    if [ "$i" -gt "$keep" ]; then rm -rf "$d"; fi
  done
}

_revert_from_dir() {
  local dir="$1" uid gid
  [ -d "$dir" ] || die "no such backup: $dir"
  if [ -f "$dir/SmartP.db" ] && [ -f "$SMARTP" ]; then
    uid=$(stat -c '%u' "$SMARTP"); gid=$(stat -c '%g' "$SMARTP")
    cp -f "$dir/SmartP.db" "$SMARTP"
    chown "$uid:$gid" "$SMARTP" 2>/dev/null || true
    chmod 660 "$SMARTP"
  fi
  if [ -f "$dir/teg_config.db" ] && [ -f "$TEG" ]; then
    uid=$(stat -c '%u' "$TEG"); gid=$(stat -c '%g' "$TEG")
    cp -f "$dir/teg_config.db" "$TEG"
    chown "$uid:$gid" "$TEG" 2>/dev/null || true
    chmod 660 "$TEG"
  fi
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$SMARTP" "$TEG" 2>/dev/null || true
  fi
  printf '{"ok":true,"from":"%s"}\n' "$dir"
}

cmd_revert() {
  safe_name "$1" || die "invalid backup name"
  _revert_from_dir "$DATA_ROOT/backup/$1"
}

cmd_revert_latest() {
  local latest
  latest=$(ls -1t "$DATA_ROOT/backup" 2>/dev/null | head -n1)
  [ -n "$latest" ] || die "no backups yet"
  _revert_from_dir "$DATA_ROOT/backup/$latest"
}

cmd_restart() {
  am force-stop "$PKG" 2>/dev/null || true
  printf '{"ok":true,"pkg":"%s"}\n' "$PKG"
}

cmd_history_list() {
  # Emit newline-delimited file names, newest first.
  ls -1t "$DATA_ROOT/history" 2>/dev/null || true
}

cmd_history_get() {
  safe_name "$1" || die "invalid history name"
  cat "$DATA_ROOT/history/$1"
}

cmd_history_clear() {
  local keep="$1"
  case "$keep" in ''|*[!0-9]*) die "keep must be a non-negative integer" ;; esac
  ls -1t "$DATA_ROOT/history" 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$DATA_ROOT/history/$f"
  done
  printf '{"ok":true,"kept":%s}\n' "$keep"
}

cmd_cat_wasm() {
  local f=/data/adb/modules/joyose-edit/webroot/assets/sql-wasm.wasm
  [ -f "$f" ] || die "sql-wasm.wasm missing: $f"
  base64 -w0 "$f"
  echo
}

# Report whether the two vendor props that gate com.miui.securitycenter's
# GameBoxVisionEnhanceUtils.needInitService() are set. If both are false, the
# game assistant UI refuses to render FI / SR controls regardless of cloud DB
# content. We do NOT write the props ourselves — that is a user decision — but
# the WebUI can show the state and guide the user.
cmd_vision_status() {
  local frc sr
  frc=$(getprop ro.vendor.gpp.frc.support 2>/dev/null)
  sr=$(getprop ro.vendor.xiaomi.sr.support 2>/dev/null)
  printf '{"ok":true,"frc_support":"%s","sr_support":"%s"}\n' "$frc" "$sr"
}

# ---- teg SDK max-version freeze ------------------------------------------
# Joyose uses the MIUI teg cloud-config SDK (com.xiaomi.teg.config) for its
# runtime config. teg tracks its own `pref_local_max_version` in a
# SharedPreferences XML, completely independent of SmartP.db.cloud_config.version
# and teg_config.db.rules.rule_version. Every ~13 min (or on broadcast) teg SDK
# does:
#   local  = sp.getLong("pref_local_max_version", 0)
#   cloud  = HTTP POST .../getData body={version: local}
#   if (cloud.data.maxVersion == local) -> no-op
#   else -> apply delete/insert of rules to teg_config.db (NO per-rule
#           version check), bump SP, notify observers -> f.f.u() reloads
#           Joyose's in-memory state from teg_config.db via CloudConfig.
# So the only way to truly stop cloud from overwriting a user's edits is to
# write Long.MAX_VALUE into pref_local_max_version — teg then always sees
# "up to date" and never reapplies rules. Side effect: ALL teg cloud updates
# (including unrelated modules) are frozen.
TEG_SP=/data/user/0/com.xiaomi.joyose/shared_prefs/teg_config_pref.xml
TEG_MAX_VALUE=9223372036854775807

_teg_current_max() {
  [ -f "$TEG_SP" ] || { echo 0; return; }
  grep 'pref_local_max_version' "$TEG_SP" 2>/dev/null \
    | sed -E 's|.*value="([^"]*)".*|\1|' | head -n1
}

cmd_teg_status() {
  if [ ! -f "$TEG_SP" ]; then
    printf '{"ok":true,"exists":false,"path":"%s"}\n' "$TEG_SP"
    return
  fi
  local cur frozen
  cur=$(_teg_current_max)
  [ -n "$cur" ] || cur=0
  if [ "$cur" = "$TEG_MAX_VALUE" ]; then frozen=true; else frozen=false; fi
  printf '{"ok":true,"exists":true,"path":"%s","pref_local_max_version":"%s","frozen":%s}\n' \
    "$TEG_SP" "$cur" "$frozen"
}

_teg_rewrite() {
  local new_value="$1" tmp uid gid
  [ -f "$TEG_SP" ] || die "teg SDK SP file does not exist yet: $TEG_SP. Let Joyose initialise teg SDK first (e.g. push once)."

  # Must stop Joyose first — SharedPreferences has a per-process cache that
  # won't pick up raw file edits until the process is recreated.
  am force-stop "$PKG" 2>/dev/null || true

  uid=$(stat -c '%u' "$TEG_SP")
  gid=$(stat -c '%g' "$TEG_SP")
  tmp="$TEG_SP.jedit.$$"
  if grep -q 'pref_local_max_version' "$TEG_SP" 2>/dev/null; then
    sed -E 's|(<long name="pref_local_max_version" value=")[^"]*(")|\1'"$new_value"'\2|' \
      "$TEG_SP" > "$tmp" || { rm -f "$tmp"; die "sed replace failed"; }
  else
    awk -v ins="    <long name=\"pref_local_max_version\" value=\"$new_value\" />" '
      /<\/map>/ { print ins } { print }
    ' "$TEG_SP" > "$tmp" || { rm -f "$tmp"; die "awk insert failed"; }
  fi
  chown "$uid:$gid" "$tmp" 2>/dev/null || true
  chmod 660 "$tmp"
  mv -f "$tmp" "$TEG_SP"
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$TEG_SP" 2>/dev/null || true
  fi
  printf '{"ok":true,"path":"%s","pref_local_max_version":"%s"}\n' "$TEG_SP" "$new_value"
}

cmd_teg_freeze()   { _teg_rewrite "$TEG_MAX_VALUE"; }
cmd_teg_unfreeze() { _teg_rewrite 0; }

# ---- staging (for payloads that would overflow ARG_MAX) ------------------
# WebUI uses these to upload big base64 blobs in chunks instead of a single
# huge argv (shell rejects ~100+ KB argv with "Argument list too long").

cmd_stage_clear() {
  safe_name "$1" || die "invalid stage name"
  : > "$STAGE_DIR/$1"
  chmod 600 "$STAGE_DIR/$1"
  printf '{"ok":true,"stage":"%s"}\n' "$1"
}

cmd_stage_append() {
  safe_name "$1" || die "invalid stage name"
  local chunk="$2"
  [ -n "$chunk" ] || die "stage-append: missing chunk"
  [ -f "$STAGE_DIR/$1" ] || die "stage not initialised: $1 (call stage-clear first)"
  printf '%s' "$chunk" >> "$STAGE_DIR/$1"
  printf '{"ok":true}\n'
}

cmd_push_from_stage() {
  local sel="$1" stage="$2" target tmp uid gid stage_file
  safe_name "$stage" || die "invalid stage name"
  target=$(resolve_db "$sel")
  [ -f "$target" ] || die "missing: $target"
  stage_file="$STAGE_DIR/$stage"
  [ -f "$stage_file" ] || die "stage file missing: $stage"
  uid=$(stat -c '%u' "$target")
  gid=$(stat -c '%g' "$target")
  tmp="$target.jedit.$$"
  base64 -d < "$stage_file" > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "base64 decode failed"; }
  head -c 16 "$tmp" | grep -qa 'SQLite format 3' || { rm -f "$tmp"; die "not a sqlite db"; }
  chown "$uid:$gid" "$tmp" 2>/dev/null || true
  chmod 660 "$tmp"
  mv -f "$tmp" "$target"
  rm -f "$stage_file"
  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$target" 2>/dev/null || true
  fi
  printf '{"ok":true,"path":"%s","uid":%s,"gid":%s}\n' "$target" "$uid" "$gid"
}

cmd_history_save_from_stage() {
  safe_name "$1" || die "invalid history name"
  safe_name "$2" || die "invalid stage name"
  local f="$DATA_ROOT/history/$1"
  local stage_file="$STAGE_DIR/$2"
  [ -f "$stage_file" ] || die "stage file missing: $2"
  umask 077
  base64 -d < "$stage_file" > "$f" 2>/dev/null || die "base64 decode failed"
  chmod 600 "$f"
  rm -f "$stage_file"
  printf '{"ok":true,"path":"%s"}\n' "$f"
}

# ---- dispatch -------------------------------------------------------------
cmd="${1:-}"
cmd_reset_cloud() {
  # 重置 Joyose 云控：清空应用数据使其重新下载云控，再唤醒云端服务/接收器
  pm clear com.xiaomi.joyose 2>/dev/null || true
  am force-stop com.xiaomi.joyose 2>/dev/null || true
  pm enable com.xiaomi.joyose/com.xiaomi.joyose.smartop.SmartOpService 2>/dev/null || true
  pm enable com.xiaomi.joyose/com.xiaomi.joyose.cloud.CloudServerReceiver 2>/dev/null || true
  am broadcast -a android.intent.action.BOOT_COMPLETED -p com.xiaomi.joyose 2>/dev/null || true
  am broadcast com.xiaomi.joyose/com.xiaomi.joyose.cloud.CloudServerReceiver 2>/dev/null || true
  am broadcast com.xiaomi.joyose/com.xiaomi.joyose.JoyoseBroadCastReceiver 2>/dev/null || true
  am broadcast -a android.intent.action.BOOT_COMPLETED -n com.xiaomi.joyose/com.xiaomi.joyose.JoyoseBroadCastReceiver 2>/dev/null || true
  printf 'ok'
}

cmd_save_dl_from_stage() {
  safe_name "$1" || die "invalid download name"
  safe_name "$2" || die "invalid stage name"
  local dir="/sdcard/Download/joyose-edit"
  local f="$dir/$1"
  local stage_file="$STAGE_DIR/$2"
  [ -f "$stage_file" ] || die "stage file missing: $2"
  mkdir -p "$dir" 2>/dev/null || die "cannot create $dir"
  umask 022
  base64 -d < "$stage_file" > "$f" 2>/dev/null || die "base64 decode failed"
  chmod 644 "$f" 2>/dev/null || true
  rm -f "$stage_file"
  printf '{"ok":true,"path":"%s"}\n' "$f"
}

cmd_install_ts() {
  local f="/data/adb/modules/joyose-edit/.install_ts"
  if [ -f "$f" ]; then cat "$f"; else printf '0'; fi
}

cmd_test_file() {
  local key="$1"
  case "$key" in
    odm-etc-default-cloud)
      if [ -f /odm/etc/default_cloud.json ]; then printf 'true'; else printf 'false'; fi
      ;;
    *)
      die "unknown file probe: $key" ;;
  esac
}

[ -n "$cmd" ] || die "missing subcommand"
shift

case "$cmd" in
  stat)           cmd_stat ;;
  save-dl-from-stage) cmd_save_dl_from_stage "${1:?}" "${2:?}" ;;
  reset-cloud)    cmd_reset_cloud ;;
  install-ts)     cmd_install_ts ;;
  test-file)      cmd_test_file "${1:?}" ;;
  pull)           cmd_pull "${1:?}" ;;
  push)           cmd_push "${1:?}" "${2:?}" ;;
  backup)         cmd_backup "${1:-}" ;;
  revert)         cmd_revert "${1:?}" ;;
  revert-latest)  cmd_revert_latest ;;
  restart)        cmd_restart ;;
  history-list)   cmd_history_list ;;
  history-get)    cmd_history_get "${1:?}" ;;
  history-clear)  cmd_history_clear "${1:?}" ;;
  cat-wasm)       cmd_cat_wasm ;;
  vision-status)  cmd_vision_status ;;
  teg-status)     cmd_teg_status ;;
  teg-freeze)     cmd_teg_freeze ;;
  teg-unfreeze)   cmd_teg_unfreeze ;;
  stage-clear)    cmd_stage_clear "${1:?}" ;;
  stage-append)   cmd_stage_append "${1:?}" "${2:?}" ;;
  push-from-stage)         cmd_push_from_stage "${1:?}" "${2:?}" ;;
  history-save-from-stage) cmd_history_save_from_stage "${1:?}" "${2:?}" ;;
  *) die "unknown subcommand: $cmd" ;;
esac
