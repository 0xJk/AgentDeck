*** Settings ***
Documentation       ESP32 firmware flash and boot verification.
...                 Requires physical ESP32 device connected via USB.
...                 Flashes boot_test firmware, verifies boot output,
...                 and checks hardware health (heap, PSRAM, flash).
Library             Process
Library             Collections
Library             ../libraries/ESP32Serial.py
Variables           ../resources/variables.py
Force Tags          hw
Suite Teardown      Close ESP32 Serial

*** Variables ***
${FLASH_TIMEOUT}    180s

*** Test Cases ***
Detect Connected ESP32 Device
    [Documentation]    Verify an ESP32 device is detected on USB.
    ${port}=    Detect ESP32 Port
    Skip If    '${port}' == 'None'    No ESP32 device connected
    Log    Detected device on ${port}
    Set Suite Variable    ${ESP32_PORT}    ${port}

Flash Boot Test Firmware
    [Documentation]    Flash minimal boot_test firmware and verify upload succeeds.
    [Tags]    flash
    Skip If    not $ESP32_PORT    No ESP32 device
    # Build and upload boot_test (minimal — no LVGL, fast build)
    ${result}=    Run Process    pio    run    -e    boot_test    -t    upload
    ...    cwd=${PROJECT_DIR}    timeout=${FLASH_TIMEOUT}    stderr=STDOUT
    Log    ${result.stdout}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Flash failed:\n${result.stdout}

Verify Boot Messages
    [Documentation]    After flash, ESP32 should boot and print diagnostics.
    [Tags]    flash
    Skip If    not $ESP32_PORT    No ESP32 device
    Open ESP32 Serial    ${ESP32_PORT}
    ${boot_line}=    Wait For Boot Message    timeout=${BOOT_TIMEOUT_SEC}
    Should Contain    ${boot_line}    Boot OK!
    ...    msg=Boot marker not found: ${boot_line}

Hardware Health Check
    [Documentation]    Verify heap, PSRAM, and flash from boot output.
    [Tags]    flash
    Skip If    not $ESP32_PORT    No ESP32 device
    ${info}=    Collect Boot Info
    Log    Boot info: ${info}
    # Heap should be >100KB on fresh boot
    Should Be True    ${info}[heap] > 100000
    ...    msg=Low heap at boot: ${info}[heap] bytes
    # PSRAM should be detected (ESP32-S3 boards have 8MB OPI PSRAM)
    Should Be True    ${info}[psram] > 0
    ...    msg=PSRAM not detected — board may be damaged
    # CPU should be 240MHz
    Should Be True    ${info}[cpu] == 240
    ...    msg=Unexpected CPU frequency: ${info}[cpu] MHz

Device Responds After Boot
    [Documentation]    ESP32 should continue sending alive messages after boot.
    [Tags]    flash
    Skip If    not $ESP32_PORT    No ESP32 device
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}
    ...    msg=ESP32 not responsive after boot

Flash Full Firmware
    [Documentation]    Flash full box_86 firmware (with LVGL/display/network).
    [Tags]    flash    full
    Skip If    not $ESP32_PORT    No ESP32 device
    ${result}=    Run Process    pio    run    -e    box_86    -t    upload
    ...    cwd=${PROJECT_DIR}    timeout=${FLASH_TIMEOUT}    stderr=STDOUT
    Log    ${result.stdout}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Full firmware flash failed:\n${result.stdout}

Full Firmware Boot
    [Documentation]    Full firmware should boot and initialize serial JSON listener.
    [Tags]    flash    full
    Skip If    not $ESP32_PORT    No ESP32 device
    Open ESP32 Serial    ${ESP32_PORT}
    ${boot_line}=    Wait For Boot Message    timeout=${BOOT_TIMEOUT_SEC}
    Log    Full firmware boot: ${boot_line}

Flash Recovery After Power Cycle
    [Documentation]    Simulate recovery: close/reopen serial, verify device still alive.
    [Tags]    recovery
    Skip If    not $ESP32_PORT    No ESP32 device
    Close ESP32 Serial
    Sleep    2s    Wait for port to settle
    Open ESP32 Serial    ${ESP32_PORT}
    ${responsive}=    ESP32 Is Responsive    timeout=10
    Should Be True    ${responsive}
    ...    msg=ESP32 not responsive after reconnect
