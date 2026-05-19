#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-wechat-clawbot-monitor.sh \
    --config /root/hiboss/adapters/wechat-clawbot/sidecar.json \
    --hiboss-dir /var/lib/hiboss \
    --agent nex \
    --notify-to channel:telegram:<chat-id>

Options:
  --binary <path>             Defaults to hiboss-wechat-clawbot-sidecar on PATH
  --cron-file <path>          Defaults to /etc/cron.d/hiboss-wechat-clawbot-monitor
  --log-file <path>           Defaults to /var/log/hiboss-wechat-clawbot-monitor.log
  --interval-minutes <n>      Defaults to 5
USAGE
}

binary=""
config=""
hiboss_dir=""
agent=""
notify_to=""
cron_file="/etc/cron.d/hiboss-wechat-clawbot-monitor"
log_file="/var/log/hiboss-wechat-clawbot-monitor.log"
interval_minutes="5"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --binary) binary="${2:-}"; shift 2 ;;
    --config) config="${2:-}"; shift 2 ;;
    --hiboss-dir) hiboss_dir="${2:-}"; shift 2 ;;
    --agent) agent="${2:-}"; shift 2 ;;
    --notify-to) notify_to="${2:-}"; shift 2 ;;
    --cron-file) cron_file="${2:-}"; shift 2 ;;
    --log-file) log_file="${2:-}"; shift 2 ;;
    --interval-minutes) interval_minutes="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$binary" ]; then
  binary="$(command -v hiboss-wechat-clawbot-sidecar || true)"
fi

if [ -z "$binary" ] || [ ! -x "$binary" ]; then
  echo "error: sidecar binary not found or not executable" >&2
  exit 2
fi
if [ -z "$config" ] || [ ! -f "$config" ]; then
  echo "error: --config is required and must point to an existing file" >&2
  exit 2
fi
if [ -z "$hiboss_dir" ] || [ ! -d "$hiboss_dir" ]; then
  echo "error: --hiboss-dir is required and must point to an existing directory" >&2
  exit 2
fi
if [ -z "$agent" ]; then
  echo "error: --agent is required" >&2
  exit 2
fi
if [ -z "$notify_to" ]; then
  echo "error: --notify-to is required" >&2
  exit 2
fi
case "$interval_minutes" in
  *[!0-9]*|"") echo "error: --interval-minutes must be a positive integer" >&2; exit 2 ;;
esac
if [ "$interval_minutes" -lt 1 ] || [ "$interval_minutes" -gt 59 ]; then
  echo "error: --interval-minutes must be between 1 and 59" >&2
  exit 2
fi
case "$binary$config$hiboss_dir$agent$notify_to$cron_file$log_file" in
  *"'"*) echo "error: single quotes are not supported in arguments written to cron" >&2; exit 2 ;;
esac

quote_arg() {
  printf "'%s'" "$1"
}

cron_dir="$(dirname "$cron_file")"
log_dir="$(dirname "$log_file")"
install -d -m 0755 "$cron_dir"
install -d -m 0755 "$log_dir"
touch "$log_file"
chmod 0644 "$log_file"

cron_tmp="$(mktemp)"
cat > "$cron_tmp" <<EOF
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/$interval_minutes * * * * root HIBOSS_DIR=$(quote_arg "$hiboss_dir") $(quote_arg "$binary") monitor --config $(quote_arg "$config") --hiboss-dir $(quote_arg "$hiboss_dir") --agent $(quote_arg "$agent") --notify-to $(quote_arg "$notify_to") >> $(quote_arg "$log_file") 2>&1
EOF
install -m 0644 "$cron_tmp" "$cron_file"
rm -f "$cron_tmp"

HIBOSS_DIR="$hiboss_dir" "$binary" monitor \
  --config "$config" \
  --hiboss-dir "$hiboss_dir" \
  --agent "$agent" \
  --notify-to "$notify_to" >> "$log_file" 2>&1

echo "installed: true"
echo "binary: $binary"
echo "cron-file: $cron_file"
echo "log-file: $log_file"
echo "interval-minutes: $interval_minutes"
echo "notify-target-configured: true"
HIBOSS_DIR="$hiboss_dir" "$binary" monitor-status --cron-file "$cron_file" --log-file "$log_file"
