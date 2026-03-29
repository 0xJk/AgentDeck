#!/bin/bash
# D200H ADB 4-second one-shot dump + adbd keeper installation
# Usage: Called by adb-watch.sh when device is detected, or run manually
set -euo pipefail

SERIAL="${1:-0123456789ABCDEF}"
ADB="adb -s $SERIAL"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="$SCRIPT_DIR/dumps/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTDIR"

echo "=== D200H ADB Dump → $OUTDIR ==="

# STRATEGY: Lock USB sysfs to prevent ADB→HID mode switch
# chmod 444 on functions/enable files → init property handler gets "Permission denied"
# This is a one-shot command, no keeper loop needed
echo "--- [0s] Locking USB sysfs (chmod 444) ---"
$ADB shell '
USB=/sys/class/zkswe_usb/zkswe0
# Lock sysfs files — prevents ANY USB mode change
chmod 444 $USB/functions 2>/dev/null
chmod 444 $USB/enable 2>/dev/null
echo locked
' 2>&1 | tee "$OUTDIR/sysfs_lock.txt" &
LOCK_PID=$!

# Wait briefly for keeper to start, then collect data
sleep 0.5
echo "--- [0.5s] Starting parallel data collection ---"

# Priority 1: Critical config files (not collected in round 1)
$ADB shell "cat /etc/init.rc" > "$OUTDIR/init_rc.txt" 2>&1 &
$ADB shell "cat /res/etc/EasyUI.cfg" > "$OUTDIR/easyui_cfg.txt" 2>&1 &
$ADB shell "cat /config/board.ini" > "$OUTDIR/board_ini.txt" 2>&1 &
$ADB shell "cat /config/mmap.ini" > "$OUTDIR/mmap_ini.txt" 2>&1 &
$ADB shell "cat /config/model/Customer.ini" > "$OUTDIR/customer_ini.txt" 2>&1 &
$ADB shell "cat /etc/build.prop" > "$OUTDIR/build_prop.txt" 2>&1 &
$ADB shell "cat /etc/default.prop" > "$OUTDIR/default_prop.txt" 2>&1 &
$ADB shell "cat /data/preferences.json" > "$OUTDIR/preferences_json.txt" 2>&1 &
$ADB shell "cat /res/ui/default/manifest0.json" > "$OUTDIR/manifest0_json.txt" 2>&1 &

# Priority 2: Hardware identification (parallel)
$ADB shell "cat /proc/cpuinfo" > "$OUTDIR/cpuinfo.txt" 2>&1 &
$ADB shell "cat /sys/class/graphics/fb0/virtual_size 2>/dev/null; echo '---bpp---'; cat /sys/class/graphics/fb0/bits_per_pixel 2>/dev/null; echo '---stride---'; cat /sys/class/graphics/fb0/stride 2>/dev/null; echo '---name---'; cat /sys/class/graphics/fb0/name 2>/dev/null" > "$OUTDIR/fb_info.txt" 2>&1 &
$ADB shell "cat /proc/cmdline" > "$OUTDIR/cmdline.txt" 2>&1 &
$ADB shell "cat /proc/meminfo" > "$OUTDIR/meminfo.txt" 2>&1 &

# Priority 3: Input/Display/Network
$ADB shell "cat /proc/bus/input/devices" > "$OUTDIR/input_devices.txt" 2>&1 &
$ADB shell "ls -la /dev/input/ /dev/event* /dev/gpio* 2>/dev/null" > "$OUTDIR/input_devs.txt" 2>&1 &
$ADB shell "lsmod" > "$OUTDIR/modules.txt" 2>&1 &

# Priority 4: System info
$ADB shell "cat /proc/mtd" > "$OUTDIR/mtd.txt" 2>&1 &
$ADB shell "mount" > "$OUTDIR/mount.txt" 2>&1 &
$ADB shell "ps" > "$OUTDIR/processes.txt" 2>&1 &
$ADB shell "getprop" > "$OUTDIR/getprop.txt" 2>&1 &
$ADB shell "df 2>/dev/null" > "$OUTDIR/disk.txt" 2>&1 &

# Priority 5: Filesystem structure
$ADB shell "ls -laR /data/ 2>/dev/null" > "$OUTDIR/data_listing.txt" 2>&1 &
$ADB shell "ls -la /bin/ /lib/ 2>/dev/null" > "$OUTDIR/bin_listing.txt" 2>&1 &
$ADB shell "ls -la /dev/fb* /dev/input/ /dev/mtd* 2>/dev/null" > "$OUTDIR/dev_listing.txt" 2>&1 &
$ADB shell "ls -laR /etc/ 2>/dev/null" > "$OUTDIR/etc_listing.txt" 2>&1 &
$ADB shell "ls -laR /res/ 2>/dev/null" > "$OUTDIR/res_listing.txt" 2>&1 &
$ADB shell "ls -laR /config/ 2>/dev/null" > "$OUTDIR/config_listing.txt" 2>&1 &

# Priority 6: Deeper investigation — USB, SPI, GPIO
$ADB shell "cat /proc/devices" > "$OUTDIR/proc_devices.txt" 2>&1 &
$ADB shell "ls -la /sys/class/gpio/ /sys/class/leds/ /sys/class/backlight/ 2>/dev/null" > "$OUTDIR/sys_classes.txt" 2>&1 &
$ADB shell "cat /sys/kernel/debug/usb/devices 2>/dev/null" > "$OUTDIR/usb_devices.txt" 2>&1 &
$ADB shell "cat /bin/ssd_init.sh" > "$OUTDIR/ssd_init_sh.txt" 2>&1 &
$ADB shell "cat /etc/vold.fstab" > "$OUTDIR/vold_fstab.txt" 2>&1 &

# Wait for all background jobs
for job in $(jobs -p); do
  wait "$job" 2>/dev/null || true
done

echo ""
echo "=== Dump complete ==="
echo "Output: $OUTDIR"
echo ""

# Summary of key findings
echo "--- Quick Summary ---"
[ -f "$OUTDIR/cpuinfo.txt" ] && echo "CPU: $(grep -m1 'model name\|Hardware\|Processor' "$OUTDIR/cpuinfo.txt" 2>/dev/null || echo 'check file')"
[ -f "$OUTDIR/fb_info.txt" ] && echo "Framebuffer: $(cat "$OUTDIR/fb_info.txt" 2>/dev/null)"
[ -f "$OUTDIR/memory.txt" ] && echo "Memory: $(head -3 "$OUTDIR/memory.txt" 2>/dev/null)"
[ -f "$OUTDIR/network.txt" ] && echo "Network interfaces: $(grep -c 'Link\|inet\|mtu' "$OUTDIR/network.txt" 2>/dev/null || echo '0') found"
[ -f "$OUTDIR/input_devices.txt" ] && echo "Input devices: $(grep -c '^N:' "$OUTDIR/input_devices.txt" 2>/dev/null || echo '0') found"
[ -f "$OUTDIR/keeper_install.txt" ] && echo "Keeper: $(tail -1 "$OUTDIR/keeper_install.txt" 2>/dev/null)"
