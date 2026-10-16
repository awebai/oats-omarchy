#!/usr/bin/env bash
# Installs Omarchy from Omarchy's own package repository into an Arch Linux
# container, with signature checking, so CI runs the package against Omarchy's
# real scripts and real Hyprland.
#
# Run as root in an archlinux:base container, from the repository root:
#   ci/omarchy-bootstrap.sh
# It also creates the unprivileged user `ci` that the checks run as.
#
# Trust: the [omarchy] repository is added with no SigLevel of its own, so it
# inherits the image's "SigLevel = Required DatabaseOptional": every package
# must carry a valid signature from a trusted key. The one key added is
# Omarchy's packaging key, imported from ci/omarchy-signing-key.asc and trusted
# only after its fingerprint equals OMARCHY_KEY below. That fingerprint is the
# one Omarchy pins itself: bin/omarchy-update-keyring (Omarchy 4.0.4) receives
# and locally signs exactly this key, and the omarchy-keyring package
# (20251027-1) lists it in /usr/share/pacman/keyrings/omarchy-trusted.
set -euo pipefail

OMARCHY_KEY=40DFB630FF42BCFFB047046CF0134EE680CAC571
# $arch is pacman's, expanded by pacman, not by this script.
# shellcheck disable=SC2016
OMARCHY_SERVER='https://pkgs.omarchy.org/stable/$arch'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $(id -u) -ne 0 ]]; then
  echo "omarchy-bootstrap: run as root (in the CI container)" >&2
  exit 1
fi

# The key file must hold exactly one primary key, and it must be the pinned one.
fingerprints=$(gpg --show-keys --with-colons "$here/omarchy-signing-key.asc" |
  awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; want = 0 }')
if [[ $fingerprints != "$OMARCHY_KEY" ]]; then
  echo "omarchy-bootstrap: ci/omarchy-signing-key.asc is not the pinned key $OMARCHY_KEY (found: ${fingerprints:-none})" >&2
  exit 1
fi

if ! grep -Eq '^SigLevel *= *Required DatabaseOptional$' /etc/pacman.conf ||
  grep -Eq '^[^#]*(Never|TrustAll)' /etc/pacman.conf; then
  echo "omarchy-bootstrap: /etc/pacman.conf must require signatures (SigLevel = Required DatabaseOptional, no Never or TrustAll)" >&2
  exit 1
fi

pacman-key --init
pacman-key --populate archlinux
pacman-key --add "$here/omarchy-signing-key.asc"
pacman-key --lsign-key "$OMARCHY_KEY"

if ! grep -qx '\[omarchy\]' /etc/pacman.conf; then
  printf '\n[omarchy]\nServer = %s\n' "$OMARCHY_SERVER" >> /etc/pacman.conf
fi

# Arch supports full upgrades only, so the image is brought current in the same
# transaction that installs omarchy (it pulls hyprland, quickshell, jq and the
# rest of Omarchy's base).
pacman -Syu --noconfirm --needed omarchy

pacman -Q omarchy hyprland

# Hyprland refuses to run as root, so the checks after this run as an
# unprivileged user.
id ci &>/dev/null || useradd --create-home ci
