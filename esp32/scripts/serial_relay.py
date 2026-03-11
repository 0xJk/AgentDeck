#!/usr/bin/env python3
"""
ESP32 Serial Relay — polls bridge HTTP endpoints and relays to ESP32 via USB serial.
Temporary bridge until sdc is restarted with built-in esp32-serial heartbeat.

Usage: python3 esp32/scripts/serial_relay.py [bridge_port] [serial_port]
"""

import serial
import time
import json
import urllib.request
import sys
from datetime import datetime, timezone

BRIDGE_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9124
SERIAL_PORT = sys.argv[2] if len(sys.argv) > 2 else '/dev/cu.usbserial-21130'
POLL_INTERVAL = 5  # seconds

def fetch_json(url, timeout=3):
    try:
        return json.loads(urllib.request.urlopen(url, timeout=timeout).read())
    except:
        return None

def format_reset_time(iso_str):
    """Convert ISO 8601 timestamp to relative time like Android's formatResetTime()."""
    if not iso_str:
        return ''
    try:
        # Parse ISO 8601 with timezone
        iso_str = iso_str.replace('+00:00', '+0000').replace('+09:00', '+0900')
        # Handle fractional seconds
        if '.' in iso_str:
            base, rest = iso_str.split('.', 1)
            # Find timezone part
            for sep in ('+', '-'):
                if sep in rest[1:]:  # skip first char (could be sign)
                    idx = rest.index(sep, 1)
                    rest = rest[idx:]
                    break
            else:
                rest = ''
            iso_str = base + rest
        reset_at = datetime.strptime(iso_str, '%Y-%m-%dT%H:%M:%S%z')
        now = datetime.now(timezone.utc)
        diff = reset_at - now
        diff_sec = int(diff.total_seconds())
        if diff_sec <= 0:
            return 'now'
        diff_min = diff_sec // 60
        if diff_min < 60:
            return f'{diff_min}m'
        h = diff_min // 60
        m = diff_min % 60
        if h < 24:
            return f'{h}h {m}m' if m > 0 else f'{h}h'
        d = h // 24
        rh = h % 24
        return f'{d}d {rh}h' if rh > 0 else f'{d}d'
    except Exception:
        return ''

def main():
    s = serial.Serial()
    s.port = SERIAL_PORT
    s.baudrate = 115200
    s.dtr = False
    s.rts = False
    s.timeout = 1
    s.open()

    base = f'http://localhost:{BRIDGE_PORT}'
    print(f'ESP32 relay: bridge={base} serial={SERIAL_PORT}')

    cycle = 0
    gw_cache = [False]  # mutable cache for gateway status

    while True:
        try:
            # 1. state_update (every cycle)
            health = fetch_json(f'{base}/health')
            if health:
                # Check gateway from daemon (port 9120) every 30s
                if cycle % 6 == 0:
                    daemon = fetch_json('http://localhost:9120/health')
                    gw_cache[0] = bool(daemon and daemon.get('gateway') == 'connected')

                msg = {
                    'type': 'state_update',
                    'state': health.get('state', 'idle'),
                    'projectName': health.get('projectName', ''),
                    'agentType': health.get('agentType', 'claude-code'),
                    'gatewayAvailable': gw_cache[0],
                }
                s.write((json.dumps(msg) + '\n').encode())

            # 2. usage_update (every 3rd cycle = 15s)
            if cycle % 3 == 0:
                usage = fetch_json(f'{base}/usage')
                if usage and 'usage' in usage:
                    u = usage['usage']
                    msg = {'type': 'usage_update'}
                    msg.update(u)
                    # Pre-format reset times for ESP32 (no NTP clock)
                    if 'fiveHourResetsAt' in msg:
                        msg['fiveHourResetsAt'] = format_reset_time(msg['fiveHourResetsAt'])
                    if 'sevenDayResetsAt' in msg:
                        msg['sevenDayResetsAt'] = format_reset_time(msg['sevenDayResetsAt'])
                    s.write((json.dumps(msg) + '\n').encode())

            s.flush()
            sys.stdout.write('.')
            sys.stdout.flush()
            cycle += 1

        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stdout.write('x')
            sys.stdout.flush()

        time.sleep(POLL_INTERVAL)

    s.close()
    print('\nRelay stopped')

if __name__ == '__main__':
    main()
