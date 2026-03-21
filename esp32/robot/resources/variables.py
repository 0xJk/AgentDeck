"""
Dynamic variables for Robot Framework ESP32 tests.

Robot Framework imports this as a variable file:
  Variables    ../resources/variables.py

Provides board configurations, firmware size limits, and paths.
"""

import os
import platform

# --- Paths ---
PROJECT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
BUILD_DIR = os.path.join(PROJECT_DIR, '.pio', 'build')

# --- Board configurations ---
BOARDS = {
    'box_86': {
        'name': '86 Box 4" 480x480',
        'env': 'box_86',
        'min_firmware_bytes': 1_000_000,    # ~1MB minimum
        'max_firmware_bytes': 3_500_000,    # ~3.5MB maximum
    },
    'ips_35': {
        'name': 'IPS 3.5" 480x320',
        'env': 'ips_35',
        'min_firmware_bytes': 1_000_000,
        'max_firmware_bytes': 3_500_000,
    },
    'round_amoled': {
        'name': 'Round AMOLED 1.8" 360x360',
        'env': 'round_amoled',
        'min_firmware_bytes': 1_000_000,
        'max_firmware_bytes': 3_500_000,
    },
}

ALL_BOARD_ENVS = ['box_86', 'ips_35', 'round_amoled']

# --- Serial settings ---
SERIAL_BAUDRATE = 115200
BOOT_TIMEOUT_SEC = 30

# --- Firmware paths ---
def firmware_path(board_env: str) -> str:
    return os.path.join(BUILD_DIR, board_env, 'firmware.bin')

def partitions_path(board_env: str) -> str:
    return os.path.join(BUILD_DIR, board_env, 'partitions.bin')

# --- Robot Framework variable interface ---
def get_variables():
    """Called by Robot Framework to get variables."""
    return {
        'PROJECT_DIR': PROJECT_DIR,
        'BUILD_DIR': BUILD_DIR,
        'BOARDS': BOARDS,
        'ALL_BOARD_ENVS': ALL_BOARD_ENVS,
        'SERIAL_BAUDRATE': SERIAL_BAUDRATE,
        'BOOT_TIMEOUT_SEC': BOOT_TIMEOUT_SEC,
        'IS_MACOS': platform.system() == 'Darwin',
        'IS_LINUX': platform.system() == 'Linux',
    }
