#!/bin/bash
# D200H Deep Probe — USB composite gadget, host port, GPIO, network capabilities
# Run after adb-dump.sh has established ADB persistence
# Usage: bash zkswe/recon/adb-deep-probe.sh
set -euo pipefail

SERIAL="${1:-0123456789ABCDEF}"
ADB="adb -s $SERIAL"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="$SCRIPT_DIR/dumps/deep_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTDIR"

echo "=== D200H Deep Probe → $OUTDIR ==="

# 1. USB gadget — can we do composite (adb+hid)?
echo "--- [1] USB Gadget Investigation ---"
$ADB shell "ls -laR /sys/class/zkswe_usb/ 2>/dev/null" > "$OUTDIR/zkswe_usb.txt" 2>&1 &
$ADB shell "cat /sys/class/zkswe_usb/zkswe0/functions 2>/dev/null; echo '---current---'; cat /sys/class/zkswe_usb/zkswe0/enable 2>/dev/null; echo '---idVendor---'; cat /sys/class/zkswe_usb/zkswe0/idVendor 2>/dev/null; echo '---idProduct---'; cat /sys/class/zkswe_usb/zkswe0/idProduct 2>/dev/null" > "$OUTDIR/usb_gadget_state.txt" 2>&1 &
$ADB shell "ls -laR /sys/class/android_usb/ 2>/dev/null; ls -laR /config/usb_gadget/ 2>/dev/null" > "$OUTDIR/usb_gadget_alt.txt" 2>&1 &
# Try listing available USB functions
$ADB shell "ls /sys/class/zkswe_usb/zkswe0/ 2>/dev/null" > "$OUTDIR/usb_gadget_attrs.txt" 2>&1 &

# 2. USB Host — what's connected, what can be connected?
echo "--- [2] USB Host Investigation ---"
$ADB shell "ls -laR /sys/bus/usb/devices/ 2>/dev/null" > "$OUTDIR/usb_host_devices.txt" 2>&1 &
$ADB shell "cat /proc/bus/usb/devices 2>/dev/null" > "$OUTDIR/usb_proc_devices.txt" 2>&1 &
$ADB shell "ls -la /sys/class/video4linux/ 2>/dev/null" > "$OUTDIR/video4linux.txt" 2>&1 &
$ADB shell "ls -la /dev/video* /dev/snd/ 2>/dev/null" > "$OUTDIR/av_devices.txt" 2>&1 &

# 3. GPIO — are buttons wired to GPIO?
echo "--- [3] GPIO/Button Investigation ---"
$ADB shell "cat /sys/kernel/debug/gpio 2>/dev/null" > "$OUTDIR/gpio_debug.txt" 2>&1 &
$ADB shell "cat /sys/kernel/debug/pinctrl/*/pins 2>/dev/null" > "$OUTDIR/pinctrl.txt" 2>&1 &
# Try getevent to detect any input events
$ADB shell "timeout 2 /bin/getevent -l 2>/dev/null || /bin/getevent -t 2>/dev/null" > "$OUTDIR/getevent.txt" 2>&1 &
# Check HID gadget device
$ADB shell "ls -la /dev/hidg* 2>/dev/null" > "$OUTDIR/hidg_devices.txt" 2>&1 &

# 4. Network capabilities
echo "--- [4] Network Investigation ---"
# Check if RNDIS/NCM modules exist
$ADB shell "find /lib/modules/ /config/modules/ -name '*.ko' 2>/dev/null" > "$OUTDIR/kernel_modules.txt" 2>&1 &
$ADB shell "ls /sys/class/net/ 2>/dev/null" > "$OUTDIR/net_interfaces.txt" 2>&1 &
# Check if USB gadget supports rndis or ncm
$ADB shell "cat /sys/class/zkswe_usb/zkswe0/functions 2>/dev/null" > "$OUTDIR/usb_current_func.txt" 2>&1 &

# 5. Display details
echo "--- [5] Display/Framebuffer Details ---"
$ADB shell "cat /sys/class/graphics/fb0/mode 2>/dev/null; cat /sys/class/graphics/fb0/modes 2>/dev/null" > "$OUTDIR/fb_modes.txt" 2>&1 &
$ADB shell "cat /sys/class/backlight/soc:backlight/brightness 2>/dev/null; cat /sys/class/backlight/soc:backlight/max_brightness 2>/dev/null" > "$OUTDIR/backlight.txt" 2>&1 &
# Framebuffer ioctl info via hexdump of fb0 var screeninfo
$ADB shell "cat /proc/fb 2>/dev/null" > "$OUTDIR/proc_fb.txt" 2>&1 &

# 6. SPI/I2C/UART — for ESP32 connection
echo "--- [6] SPI/I2C/UART for ESP32 ---"
$ADB shell "ls -la /dev/spi* /dev/i2c* /dev/ttyS* 2>/dev/null" > "$OUTDIR/serial_devices.txt" 2>&1 &
$ADB shell "cat /proc/tty/driver/serial 2>/dev/null" > "$OUTDIR/serial_ports.txt" 2>&1 &

# 7. Try composite USB: adb,hid (THE BIG TEST)
echo "--- [7] USB Composite Test (adb,hid) ---"
# First save current state, then try composite
$ADB shell "
echo '=== Before ==='
cat /sys/class/zkswe_usb/zkswe0/functions 2>/dev/null
cat /sys/class/zkswe_usb/zkswe0/enable 2>/dev/null
echo '=== Trying adb,hid ==='
echo 0 > /sys/class/zkswe_usb/zkswe0/enable 2>/dev/null
echo 'adb,hid' > /sys/class/zkswe_usb/zkswe0/functions 2>/dev/null
echo 1 > /sys/class/zkswe_usb/zkswe0/enable 2>/dev/null
echo '=== After ==='
cat /sys/class/zkswe_usb/zkswe0/functions 2>/dev/null
cat /sys/class/zkswe_usb/zkswe0/enable 2>/dev/null
echo '=== Result ==='
echo 'If you can still read this, composite mode works!'
" > "$OUTDIR/composite_test.txt" 2>&1 &

# 8. Explore /mnt/storage (UDISK) — any update mechanism files?
echo "--- [8] Storage/Update Mechanism ---"
$ADB shell "ls -laR /mnt/storage/ 2>/dev/null" > "$OUTDIR/storage_listing.txt" 2>&1 &
$ADB shell "cat /res/etc/EasyUI.cfg" > "$OUTDIR/easyui_cfg.txt" 2>&1 &

wait
echo ""
echo "=== Deep Probe complete ==="
echo "Output: $OUTDIR"
echo ""

# Summary
echo "--- Key Results ---"
[ -f "$OUTDIR/usb_gadget_state.txt" ] && echo "USB Gadget: $(cat "$OUTDIR/usb_gadget_state.txt")"
[ -f "$OUTDIR/composite_test.txt" ] && echo "Composite Test: $(tail -3 "$OUTDIR/composite_test.txt")"
[ -f "$OUTDIR/hidg_devices.txt" ] && echo "HID Gadget: $(cat "$OUTDIR/hidg_devices.txt")"
[ -f "$OUTDIR/net_interfaces.txt" ] && echo "Network: $(cat "$OUTDIR/net_interfaces.txt")"
[ -f "$OUTDIR/serial_devices.txt" ] && echo "Serial: $(cat "$OUTDIR/serial_devices.txt")"
[ -f "$OUTDIR/gpio_debug.txt" ] && echo "GPIO lines: $(wc -l < "$OUTDIR/gpio_debug.txt") lines"
