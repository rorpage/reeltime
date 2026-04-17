#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${SUDO_USER:-}" ]]; then
    USHER_USER="$SUDO_USER"
elif logname &>/dev/null 2>&1; then
    USHER_USER=$(logname)
else
    USHER_USER="$USER"
fi
USHER_HOME=$(eval echo "~$USHER_USER")
USHER_UID=$(id -u "$USHER_USER")

BOOT_CFG="/boot/firmware/config.txt"
[[ -f "$BOOT_CFG" ]] || BOOT_CFG="/boot/config.txt"
IR_PIN="${IR_PIN:-17}"
IR_OVERLAY="dtoverlay=gpio-ir,gpio_pin=${IR_PIN}"

echo "🎟️  Installing usher..."

if grep -q "$IR_OVERLAY" "$BOOT_CFG" 2>/dev/null; then
    echo "IR overlay already present in $BOOT_CFG"
else
    echo "Adding IR overlay (GPIO${IR_PIN}) to $BOOT_CFG"
    echo "$IR_OVERLAY" | sudo tee -a "$BOOT_CFG" > /dev/null
    REBOOT_NEEDED=true
fi

sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    mpv \
    python3-pip python3-venv python3-tk \
    ir-keytable \
    fonts-dejavu-core

python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -e .

sed \
    -e "s|__USER__|$USHER_USER|g" \
    -e "s|__INSTALL_DIR__|$SCRIPT_DIR|g" \
    -e "s|__HOME__|$USHER_HOME|g" \
    -e "s|__UID__|$USHER_UID|g" \
    "$SCRIPT_DIR/usher.service" | sudo tee /etc/systemd/system/usher.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable usher

echo ""
echo "✅  usher installed."

if [[ "${REBOOT_NEEDED:-false}" == "true" ]]; then
    echo "⚠️   Reboot required to activate the IR overlay:  sudo reboot"
else
    echo "    Start now:   sudo systemctl start usher"
    echo "    Watch logs:  journalctl -u usher -f"
fi
