"""
AgentDeck ESP32 Serial Communication — Robot Framework Keyword Library.

Provides keywords for serial port detection, JSON protocol messaging,
and boot verification of ESP32 devices.

Protocol: newline-delimited JSON at 115200 baud.
ESP32 parses lines starting with '{' via Protocol::parseMessage().
"""

import json
import glob
import time
import platform
import re
from typing import Optional

import serial
from robot.api import logger
from robot.api.deco import keyword, library


@library(scope='SUITE')
class ESP32Serial:
    """Keywords for ESP32 serial communication and verification."""

    ROBOT_LIBRARY_SCOPE = 'SUITE'

    # Port detection patterns per platform
    _MACOS_PATTERNS = [
        '/dev/cu.usbserial-*',   # CH340 (86 Box)
        '/dev/cu.usbmodem*',     # Native USB (IPS 3.5", Round AMOLED)
    ]
    _LINUX_PATTERNS = [
        '/dev/ttyUSB*',          # CH340
        '/dev/ttyACM*',          # Native USB CDC
    ]

    # Known non-ESP32 patterns to exclude
    _EXCLUDE_RE = re.compile(r'Bluetooth|WLAN|debug', re.IGNORECASE)

    # Boot message markers from main_minimal.cpp and main.cpp
    _BOOT_MARKERS = ['Boot OK!', '[Serial] JSON listener ready', 'AgentDeck']

    def __init__(self):
        self._ser: Optional[serial.Serial] = None
        self._port: Optional[str] = None
        self._boot_lines: list[str] = []

    @keyword('Detect ESP32 Port')
    def detect_esp32_port(self) -> Optional[str]:
        """Auto-detect an ESP32 serial port. Returns port path or None."""
        patterns = (self._MACOS_PATTERNS if platform.system() == 'Darwin'
                    else self._LINUX_PATTERNS)
        for pattern in patterns:
            for port in sorted(glob.glob(pattern)):
                if not self._EXCLUDE_RE.search(port):
                    logger.info(f'Detected ESP32 port: {port}')
                    return port
        logger.warn('No ESP32 device detected')
        return None

    @keyword('Open ESP32 Serial')
    def open_esp32_serial(self, port: str, baudrate: int = 115200,
                          timeout: float = 2.0):
        """Open serial connection to ESP32."""
        if self._ser and self._ser.is_open:
            self._ser.close()
        self._ser = serial.Serial(port, baudrate=baudrate, timeout=timeout)
        self._port = port
        self._boot_lines = []
        # Flush any stale data
        self._ser.reset_input_buffer()
        logger.info(f'Opened {port} at {baudrate} baud')

    @keyword('Close ESP32 Serial')
    def close_esp32_serial(self):
        """Close serial connection."""
        if self._ser and self._ser.is_open:
            self._ser.close()
            logger.info(f'Closed {self._port}')
        self._ser = None
        self._port = None

    @keyword('Wait For Boot Message')
    def wait_for_boot_message(self, timeout: float = 30) -> str:
        """Wait for ESP32 boot completion. Returns the matched boot line.

        Watches serial output for known boot markers:
        - "Boot OK!" (boot_test minimal firmware)
        - "[Serial] JSON listener ready" (full firmware)
        - "AgentDeck" (any firmware variant)
        """
        self._assert_open()
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            line = self._read_line(timeout=1.0)
            if line is None:
                continue
            self._boot_lines.append(line)
            logger.debug(f'Boot: {line}')
            for marker in self._BOOT_MARKERS:
                if marker in line:
                    logger.info(f'Boot complete: {line}')
                    return line
        # Dump collected boot output for diagnostics
        boot_log = '\n'.join(self._boot_lines)
        raise TimeoutError(
            f'Boot message not found within {timeout}s.\n'
            f'Collected output ({len(self._boot_lines)} lines):\n{boot_log}'
        )

    @keyword('Collect Boot Info')
    def collect_boot_info(self) -> dict:
        """Parse hardware info from boot output lines.

        Expected lines from main_minimal.cpp:
          Board: 86 Box 4"
          CPU: 240 MHz
          Free heap: 123456
          PSRAM: 8192 KB
          Flash: 16384 KB
        """
        info = {'board': '', 'cpu': 0, 'heap': 0, 'psram': 0, 'flash': 0}
        for line in self._boot_lines:
            if line.startswith('Board:'):
                info['board'] = line.split(':', 1)[1].strip()
            elif line.startswith('CPU:'):
                m = re.search(r'(\d+)', line)
                if m:
                    info['cpu'] = int(m.group(1))
            elif line.startswith('Free heap:'):
                m = re.search(r'(\d+)', line)
                if m:
                    info['heap'] = int(m.group(1))
            elif line.startswith('PSRAM:'):
                m = re.search(r'(\d+)', line)
                if m:
                    info['psram'] = int(m.group(1))
            elif line.startswith('Flash:'):
                m = re.search(r'(\d+)', line)
                if m:
                    info['flash'] = int(m.group(1))
        return info

    @keyword('Send JSON Message')
    def send_json_message(self, message: str):
        """Send a JSON message to ESP32 (appends newline).

        Args:
            message: JSON string or dict. If dict, serialized to JSON.
        """
        self._assert_open()
        if isinstance(message, dict):
            message = json.dumps(message)
        data = message.strip() + '\n'
        self._ser.write(data.encode('utf-8'))
        self._ser.flush()
        logger.info(f'Sent: {message[:200]}')

    @keyword('Send Raw')
    def send_raw(self, data: str):
        """Send raw data to ESP32 (no processing, \\n escape supported)."""
        self._assert_open()
        data = data.replace('\\n', '\n').replace('\\r', '\r')
        self._ser.write(data.encode('utf-8'))
        self._ser.flush()

    @keyword('Read Serial Line')
    def read_serial_line(self, timeout: float = 5) -> Optional[str]:
        """Read one line from serial. Returns None on timeout."""
        self._assert_open()
        return self._read_line(timeout=float(timeout))

    @keyword('Wait For JSON Field')
    def wait_for_json_field(self, field: str, value: str,
                            timeout: float = 5) -> dict:
        """Wait for a JSON message with a specific field value.

        Reads serial lines until a JSON object with field==value is found.
        Non-JSON lines and non-matching JSON are skipped.

        Returns the parsed JSON dict.
        """
        self._assert_open()
        deadline = time.time() + float(timeout)
        while time.time() < deadline:
            line = self._read_line(timeout=1.0)
            if line is None:
                continue
            if not line.startswith('{'):
                continue
            try:
                obj = json.loads(line)
                if obj.get(field) == value:
                    logger.info(f'Matched {field}={value}: {line[:200]}')
                    return obj
            except json.JSONDecodeError:
                continue
        raise TimeoutError(
            f'No JSON with {field}="{value}" within {timeout}s')

    @keyword('Read All JSON Messages')
    def read_all_json_messages(self, duration: float = 2) -> list[dict]:
        """Read all JSON messages for a duration. Non-JSON lines are skipped."""
        self._assert_open()
        messages = []
        deadline = time.time() + float(duration)
        while time.time() < deadline:
            line = self._read_line(timeout=0.5)
            if line and line.startswith('{'):
                try:
                    messages.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return messages

    @keyword('Get Device Info')
    def get_device_info(self, timeout: float = 5) -> dict:
        """Request and return device_info from ESP32.

        Sends device_info_request and waits for device_info response.
        Expected response fields: board, version, wifiConfigured, wifiConnected.
        """
        self.send_json_message('{"type": "device_info_request"}')
        return self.wait_for_json_field('type', 'device_info',
                                        timeout=timeout)

    @keyword('Assert Device Healthy')
    def assert_device_healthy(self, info: dict):
        """Verify device_info indicates a healthy device.

        Checks:
        - board field is non-empty
        - version field is present
        """
        board = info.get('board', '')
        version = info.get('version', '')
        if not board:
            raise AssertionError(f'Device has no board identifier: {info}')
        if not version:
            raise AssertionError(f'Device has no version: {info}')
        logger.info(f'Device healthy: board={board}, version={version}')

    @keyword('ESP32 Is Responsive')
    def esp32_is_responsive(self, timeout: float = 5) -> bool:
        """Check if ESP32 responds to serial (reads any line within timeout)."""
        self._assert_open()
        line = self._read_line(timeout=float(timeout))
        return line is not None

    # --- Internal helpers ---

    def _assert_open(self):
        if not self._ser or not self._ser.is_open:
            raise RuntimeError('Serial port not open. Call "Open ESP32 Serial" first.')

    def _read_line(self, timeout: float = 2.0) -> Optional[str]:
        """Read one line with custom timeout. Returns stripped line or None."""
        old_timeout = self._ser.timeout
        self._ser.timeout = timeout
        try:
            raw = self._ser.readline()
            if raw:
                line = raw.decode('utf-8', errors='replace').strip()
                if line:
                    return line
            return None
        finally:
            self._ser.timeout = old_timeout
