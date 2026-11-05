#!/usr/bin/env bash
# 经 ssh 的 stdin 管道把 PowerShell 脚本推到盒子执行（带重试）。
# scp 在这条链路上会断（Connection closed by UNKNOWN port 65535），stdin 管道可用但偶发断链。
#
# 用法: bash box/ssh-run.sh box/install-task.ps1
set -u
SCRIPT="$1"
TRIES="${TRIES:-6}"
for i in $(seq 1 "$TRIES"); do
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=120 wbssh 'powershell -NoProfile -NonInteractive -Command -' < "$SCRIPT" 2>&1)
  if printf '%s' "$out" | grep -qE 'COOKIE|DONE|repetition='; then
    printf '%s\n' "$out" | grep -v 'WARNING\|openssh\.com'
    exit 0
  fi
  echo "[ssh-run] try $i 链路断开，等 8s 重试..." >&2
  sleep 8
done
echo "[ssh-run] 重试 $TRIES 次仍失败" >&2
exit 1
