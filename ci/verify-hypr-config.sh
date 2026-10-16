#!/usr/bin/env bash
# Checks one Hyprland config with Hyprland's own parser, no compositor needed:
#   ci/verify-hypr-config.sh --expect ok|error <config.lua|config.conf> [home]
#
# `Hyprland --verify-config` prints "config ok" and exits 0, or names the error
# and exits 1. It runs Lua submap bodies, so an unknown dispatcher or keysym
# inside a submap fails too. It does not flag a duplicate bind.
#
# It runs with a temporary XDG_RUNTIME_DIR and, unless one is given, a
# temporary HOME, and never sees a running session (WAYLAND_DISPLAY and
# HYPRLAND_INSTANCE_SIGNATURE are unset). Hyprland refuses to run as root, so
# CI runs this as an unprivileged user.
set -euo pipefail

usage() { echo "usage: verify-hypr-config.sh --expect ok|error <config> [home]" >&2; exit 2; }
[[ ${1:-} == --expect && ( ${2:-} == ok || ${2:-} == error ) && -n ${3:-} ]] || usage
expect=$2
config=$(realpath "$3")
home=${4:-}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -m 700 "$scratch/runtime"
[[ -n $home ]] || { home="$scratch/home"; mkdir "$home"; }

status=0
env -u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u DISPLAY \
  HOME="$home" XDG_RUNTIME_DIR="$scratch/runtime" \
  XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state" \
  timeout 60 Hyprland --verify-config -c "$config" > "$scratch/out" 2>&1 || status=$?

echo "--- Hyprland --verify-config -c $config (exit $status)"
sed -n '/Config parsing result/,$p' "$scratch/out" | grep -v '^\s*$' || cat "$scratch/out"

if [[ $expect == ok ]]; then
  [[ $status -eq 0 ]] && grep -qx 'config ok' "$scratch/out" && { echo "PASS: config ok"; exit 0; }
  echo "FAIL: expected config ok"; exit 1
fi
[[ $status -eq 1 ]] && ! grep -qx 'config ok' "$scratch/out" && { echo "PASS: refused as expected"; exit 0; }
echo "FAIL: expected Hyprland to refuse the config with exit 1"; exit 1
