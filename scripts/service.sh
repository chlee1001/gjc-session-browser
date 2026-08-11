#!/usr/bin/env bash
# GJC Sessions를 macOS LaunchAgent로 등록해 로그인할 때마다 자동 실행한다.
set -euo pipefail

LABEL="com.gjc.session-list"
PORT="${GJC_SESSION_LIST_PORT:-4175}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
OUT_LOG="$LOG_DIR/gjc-session-list.out.log"
ERR_LOG="$LOG_DIR/gjc-session-list.err.log"
DOMAIN="gui/$(id -u)"
URL="http://127.0.0.1:$PORT"

die() { printf '%s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "이 스크립트는 macOS 전용입니다."

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

is_registered() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

service_pid() {
  launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label && $1 ~ /^[0-9]+$/ { print $1 }'
}

is_running() {
  [ -n "$(service_pid)" ]
}

# bootout은 비동기다. 해체가 끝날 때까지 기다린 뒤 성공 여부를 돌려준다.
stop_service() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    is_registered || return 0
    sleep 0.25
  done
  return 1
}

responds() {
  curl -fsS -o /dev/null --max-time 3 "$URL/api/sessions?limit=1" 2>/dev/null
}

wait_until_responds() {
  for _ in $(seq 1 60); do
    responds && return 0
    sleep 0.5
  done
  return 1
}

build() {
  [ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install)
  (cd "$ROOT" && npm run build)
}

write_plist() {
  local node_bin node_dir bun_bin bun_dir service_path
  node_bin="$(command -v node)" || die "node를 찾을 수 없습니다. node를 설치한 뒤 다시 실행하세요."
  node_dir="$(dirname "$node_bin")"
  service_path="$node_dir"

  if bun_bin="$(command -v bun 2>/dev/null)"; then
    bun_dir="$(dirname "$bun_bin")"
    [ "$bun_dir" = "$node_dir" ] || service_path="$service_path:$bun_dir"
  else
    printf '%s\n' "경고: bun이 없어 제목 변경과 삭제는 동작하지 않습니다. 조회와 검색은 정상입니다." >&2
  fi
  service_path="$service_path:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "$ROOT/server.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>PATH</key>
    <string>$(xml_escape "$service_path")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$OUT_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ERR_LOG")</string>
</dict>
</plist>
PLIST

  plutil -lint "$PLIST" >/dev/null || die "생성한 plist가 올바르지 않습니다: $PLIST"
}

cmd_install() {
  build
  write_plist
  stop_service || die "기존 서비스를 해체하지 못했습니다."
  launchctl bootstrap "$DOMAIN" "$PLIST"
  if wait_until_responds; then
    printf '%s\n' "등록 완료. 로그인할 때마다 자동 실행합니다: $URL"
  else
    printf '%s\n' "등록은 됐지만 응답이 없습니다. '$0 logs'로 확인하세요." >&2
    exit 1
  fi
}

cmd_start() {
  [ -f "$PLIST" ] || die "등록되어 있지 않습니다. 먼저 '$0 install'을 실행하세요."
  if is_registered; then
    launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || true
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
  fi
  if wait_until_responds; then
    printf '%s\n' "실행 중: $URL"
  else
    printf '%s\n' "시작하지 못했습니다. '$0 logs'로 확인하세요." >&2
    exit 1
  fi
}

cmd_stop() {
  stop_service || die "종료하지 못했습니다."
  if is_running || responds; then
    die "종료하지 못했습니다."
  fi
  printf '%s\n' "종료했습니다. 다음 로그인에 다시 시작합니다. 자동 시작까지 끄려면 '$0 uninstall'."
}

cmd_restart() {
  cmd_stop >/dev/null
  cmd_start
}

cmd_update() {
  build
  write_plist
  stop_service || die "기존 서비스를 해체하지 못했습니다."
  launchctl bootstrap "$DOMAIN" "$PLIST"
  if wait_until_responds; then
    printf '%s\n' "새 빌드로 재시작했습니다: $URL"
  else
    printf '%s\n' "재시작 후 응답이 없습니다. '$0 logs'로 확인하세요." >&2
    exit 1
  fi
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  printf '%s\n' "자동 시작을 해제했습니다. 로그는 남아 있습니다: $OUT_LOG"
}

cmd_status() {
  local pid node_bin
  printf '%-12s %s\n' "레이블" "$LABEL"
  printf '%-12s %s\n' "주소" "$URL"
  printf '%-12s %s\n' "plist" "$([ -f "$PLIST" ] && echo "$PLIST" || echo '없음 (자동 시작 안 함)')"

  if is_registered; then
    pid="$(service_pid)"
    if [ -n "$pid" ]; then
      printf '%-12s %s\n' "launchd" "실행 중 (pid $pid)"
    else
      printf '%-12s %s\n' "launchd" "등록됨 (실행 안 함)"
    fi
  else
    printf '%-12s %s\n' "launchd" "미등록"
  fi

  if responds; then
    printf '%-12s %s\n' "응답" "정상"
  else
    printf '%-12s %s\n' "응답" "없음"
  fi

  if [ -f "$PLIST" ]; then
    node_bin="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || true)"
    if [ -n "$node_bin" ] && [ ! -x "$node_bin" ]; then
      printf '%-12s %s\n' "경고" "등록된 node 경로가 없습니다 ($node_bin). '$0 install'을 다시 실행하세요."
    fi
  fi

  printf '%-12s %s\n' "로그" "$OUT_LOG"
  printf '%-12s %s\n' "오류 로그" "$ERR_LOG"
}

cmd_logs() {
  local lines="${1:-40}"
  for log in "$OUT_LOG" "$ERR_LOG"; do
    printf '\n== %s ==\n' "$log"
    [ -f "$log" ] && tail -n "$lines" "$log" || printf '%s\n' "(없음)"
  done
}

usage() {
  cat <<USAGE
사용법: $0 <명령>

  install    빌드하고 LaunchAgent로 등록한다 (로그인마다 자동 실행)
  start      지금 실행한다
  stop       지금 종료한다 (다음 로그인에 다시 시작)
  restart    종료 후 다시 실행한다
  update     코드 변경 후 다시 빌드하고 재시작한다
  status     등록·실행·응답 상태를 본다
  logs [N]   로그 마지막 N줄을 본다 (기본 40)
  uninstall  자동 시작을 해제한다

포트를 바꾸려면 GJC_SESSION_LIST_PORT 를 지정한 뒤 install 하세요.
USAGE
}

case "${1:-}" in
  install) cmd_install ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  update) cmd_update ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-40}" ;;
  uninstall) cmd_uninstall ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
