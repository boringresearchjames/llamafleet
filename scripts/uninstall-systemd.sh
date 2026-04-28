#!/usr/bin/env bash
# uninstall-systemd.sh — remove the llamafleet systemd service and associated files.
# Does NOT delete the project directory (the repo you cloned).
# Run with: sudo bash scripts/uninstall-systemd.sh
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root (use sudo)."
  exit 1
fi

SERVICE_NAME="llamafleet"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_DIR="/etc/llamafleet"
DATA_DIR="/var/lib/llamafleet"
STOP_SCRIPT="/usr/local/bin/llamafleet-stop.sh"
APP_LAUNCHER="/usr/share/applications/llamafleet.desktop"

# Stop and disable the service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "Stopping $SERVICE_NAME..."
  systemctl stop "$SERVICE_NAME" || true
fi
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "Disabling $SERVICE_NAME..."
  systemctl disable "$SERVICE_NAME" || true
fi

# Kill any remaining processes owned by the service user
if id -u llamafleet >/dev/null 2>&1; then
  pkill -9 -u llamafleet 2>/dev/null || true
fi

# Free ports in case anything is still bound
fuser -k 8081/tcp 2>/dev/null || true
fuser -k 8090/tcp 2>/dev/null || true

# Remove service file and reload systemd
if [[ -f "$SERVICE_FILE" ]]; then
  rm -f "$SERVICE_FILE"
  echo "Removed $SERVICE_FILE"
fi
systemctl daemon-reload

# Remove stop script
if [[ -f "$STOP_SCRIPT" ]]; then
  rm -f "$STOP_SCRIPT"
  echo "Removed $STOP_SCRIPT"
fi

# Remove env directory (contains llamafleet.env with tokens)
if [[ -d "$ENV_DIR" ]]; then
  rm -rf "$ENV_DIR"
  echo "Removed $ENV_DIR"
fi

# Remove data directory (state, logs)
if [[ -d "$DATA_DIR" ]]; then
  rm -rf "$DATA_DIR"
  echo "Removed $DATA_DIR"
fi

# Remove desktop launcher
if [[ -f "$APP_LAUNCHER" ]]; then
  rm -f "$APP_LAUNCHER"
  echo "Removed $APP_LAUNCHER"
fi

# Remove desktop shortcut for the invoking user
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  user_desktop="$(getent passwd "${SUDO_USER}" | cut -d: -f6)/Desktop/llamafleet.desktop"
  if [[ -f "$user_desktop" ]]; then
    rm -f "$user_desktop"
    echo "Removed $user_desktop"
  fi
fi

# Remove the llamafleet system user
if id -u llamafleet >/dev/null 2>&1; then
  userdel llamafleet 2>/dev/null || true
  echo "Removed system user: llamafleet"
fi

echo ""
echo "llamafleet uninstalled."
echo "The project directory was not removed. Delete it manually if needed."
