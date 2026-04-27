#!/usr/bin/env bash
# install-ubuntu-systemd.sh — thin wrapper kept for backwards compatibility.
# All logic lives in install-systemd.sh which supports Ubuntu, Fedora, Arch, and openSUSE.
exec "$(dirname "${BASH_SOURCE[0]}")/install-systemd.sh" "$@"
