*** Settings ***
Documentation       Shared BDD (Given/When/Then) keywords for ESP32 tests.
...                 Provides reusable step definitions that accept a board
...                 parameter, enabling the same scenario to run across all
...                 ESP32 board variants via Robot Framework Test Templates.
Library             Process
Library             OperatingSystem
Library             Collections
Library             ../libraries/ESP32Serial.py
Variables           ../resources/variables.py

*** Variables ***
${PIO_TIMEOUT}          300s
${FLASH_TIMEOUT}        180s

*** Keywords ***
# ═══════════════════════════════════════════════════════════════════
# Given — Preconditions
# ═══════════════════════════════════════════════════════════════════

the "${board}" firmware is built
    [Documentation]    Build firmware for the specified board env.
    ${result}=    Run Process    pio    run    -e    ${board}
    ...    cwd=${PROJECT_DIR}    timeout=${PIO_TIMEOUT}    stderr=STDOUT
    Log    ${result.stdout}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=PlatformIO build failed for ${board}:\n${result.stdout}

the "${board}" firmware is built if not exists
    [Documentation]    Build only if firmware.bin doesn't already exist.
    ${exists}=    Run Keyword And Return Status
    ...    File Should Exist    ${BUILD_DIR}/${board}/firmware.bin
    IF    not ${exists}
        the "${board}" firmware is built
    END

the "${board}" firmware is flashed to the device
    [Documentation]    Flash firmware via PlatformIO upload.
    ${result}=    Run Process    pio    run    -e    ${board}    -t    upload
    ...    cwd=${PROJECT_DIR}    timeout=${FLASH_TIMEOUT}    stderr=STDOUT
    Log    ${result.stdout}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Flash failed for ${board}:\n${result.stdout}

the ESP32 device "${board}" is connected
    [Documentation]    Open serial connection using port from device inventory.
    ${port}=    Get Board Port    ${board}
    Skip If    '${port}' == 'None'    No device found for ${board}
    Open ESP32 Serial    ${port}
    Set Suite Variable    ${CURRENT_BOARD}    ${board}
    Set Suite Variable    ${CURRENT_PORT}    ${port}

the ESP32 device "${board}" is booted
    [Documentation]    Wait for boot message after flash/reset.
    ${line}=    Wait For Boot Message    timeout=${BOOT_TIMEOUT_SEC}
    Log    Boot line: ${line}
    Set Suite Variable    ${BOOT_LINE}    ${line}

the ESP32 device "${board}" is connected and booted
    [Documentation]    Connect + wait for boot (combined Given step).
    the ESP32 device "${board}" is connected
    the ESP32 device "${board}" is booted

the PlatformIO configuration is valid
    [Documentation]    Verify platformio.ini can be parsed without errors.
    ${result}=    Run Process    pio    project    config
    ...    cwd=${PROJECT_DIR}    timeout=30s    stderr=STDOUT
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=PlatformIO config invalid:\n${result.stdout}

# ═══════════════════════════════════════════════════════════════════
# When — Actions
# ═══════════════════════════════════════════════════════════════════

I send a device info request
    [Documentation]    Send device_info_request JSON message.
    Send JSON Message    {"type": "device_info_request"}

I send a state update with state "${state}"
    [Documentation]    Send a state_update message.
    ${msg}=    Create Dictionary
    ...    type=state_update    state=${state}
    ...    projectName=TestProject    modelName=opus-4    agentType=claude-code
    Send JSON Message    ${msg}

I send a state update with options
    [Documentation]    Send state_update with permission options array.
    ${opt1}=    Create Dictionary    label=Yes    index=${0}    recommended=${True}
    ${opt2}=    Create Dictionary    label=No    index=${1}    recommended=${False}
    ${options}=    Create List    ${opt1}    ${opt2}
    ${msg}=    Create Dictionary
    ...    type=state_update    state=awaiting_permission
    ...    question=Allow file read?    options=${options}
    Send JSON Message    ${msg}

I send a usage update
    [Documentation]    Send usage_update message with realistic values.
    ${msg}=    Create Dictionary
    ...    type=usage_update
    ...    fiveHourPercent=${42.5}    sevenDayPercent=${15.0}
    ...    inputTokens=${50000}    outputTokens=${12000}
    ...    toolCalls=${25}    sessionDurationSec=${3600}
    ...    fiveHourResetsAt=1h 30m    sevenDayResetsAt=2d 4h
    Send JSON Message    ${msg}

I send a sessions list
    [Documentation]    Send sessions_list with multiple sessions.
    ${s1}=    Create Dictionary
    ...    id=sess-001    projectName=MyApp    agentType=claude-code
    ...    state=processing    port=${9121}    alive=${True}
    ${s2}=    Create Dictionary
    ...    id=sess-002    projectName=Backend    agentType=claude-code
    ...    state=idle    port=${9122}    alive=${True}
    ${sessions}=    Create List    ${s1}    ${s2}
    ${msg}=    Create Dictionary    type=sessions_list    sessions=${sessions}
    Send JSON Message    ${msg}

I send display state "${on_off}"
    [Documentation]    Send display_state on/off message.
    ${is_on}=    Evaluate    '${on_off}'.lower() == 'on'
    ${msg}=    Create Dictionary    type=display_state    displayOn=${is_on}
    Send JSON Message    ${msg}

I send malformed JSON data
    [Documentation]    Send various broken JSON to test recovery.
    Send Raw    {broken json without closing\n
    Send Raw    not json at all\n
    Send Raw    {"type": "incomplete\n
    Send Raw    \n

I send empty lines
    [Documentation]    Send multiple empty lines.
    Send Raw    \n
    Send Raw    \n
    Send Raw    \n

I send "${count}" rapid messages
    [Documentation]    Send N rapid state_update messages in burst.
    FOR    ${i}    IN RANGE    ${count}
        Send JSON Message    {"type": "state_update", "state": "processing"}
    END

I send a large message with project name of "${length}" characters
    [Documentation]    Send state_update with oversized projectName.
    ${long_name}=    Evaluate    'A' * ${length}
    ${msg}=    Create Dictionary
    ...    type=state_update    state=idle    projectName=${long_name}
    Send JSON Message    ${msg}

I send an unknown message type
    [Documentation]    Send a message type the firmware doesn't know about.
    Send JSON Message    {"type": "unknown_future_message", "data": "test"}

I reconnect after closing the serial port
    [Documentation]    Close serial, wait, then reopen.
    Close ESP32 Serial
    Sleep    2s    Wait for port to settle
    Open ESP32 Serial    ${CURRENT_PORT}

# ═══════════════════════════════════════════════════════════════════
# Then — Assertions
# ═══════════════════════════════════════════════════════════════════

the device should respond with device info
    [Documentation]    Wait for and validate device_info JSON response.
    ${info}=    Wait For JSON Field    type    device_info    timeout=5
    Set Test Variable    ${DEVICE_INFO}    ${info}

the device info should contain valid fields
    [Documentation]    Verify all required fields in device_info.
    Dictionary Should Contain Key    ${DEVICE_INFO}    type
    Dictionary Should Contain Key    ${DEVICE_INFO}    board
    Dictionary Should Contain Key    ${DEVICE_INFO}    version
    Dictionary Should Contain Key    ${DEVICE_INFO}    wifiConfigured
    Dictionary Should Contain Key    ${DEVICE_INFO}    wifiConnected
    Should Be Equal    ${DEVICE_INFO}[type]    device_info

the device info board should be valid
    [Documentation]    Board ID should match a known board identifier.
    ${valid}=    Create List    86box    ips_35    round_amoled    ulanzi_tc001
    Should Contain    ${valid}    ${DEVICE_INFO}[board]
    ...    msg=Unknown board: ${DEVICE_INFO}[board]

the device should still be responsive
    [Documentation]    Verify ESP32 is alive after an operation.
    Sleep    1s
    ${ok}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${ok}    msg=ESP32 not responsive

the firmware binary should exist for "${board}"
    [Documentation]    Verify firmware.bin was produced by the build.
    File Should Exist    ${BUILD_DIR}/${board}/firmware.bin

the firmware size should be sane for "${board}"
    [Documentation]    Firmware size within declared min/max bounds.
    ${size}=    Get File Size    ${BUILD_DIR}/${board}/firmware.bin
    ${min}=    Set Variable    ${BOARDS}[${board}][min_firmware_bytes]
    ${max}=    Set Variable    ${BOARDS}[${board}][max_firmware_bytes]
    Should Be True    ${size} >= ${min}
    ...    msg=${board} firmware too small: ${size} (min ${min})
    Should Be True    ${size} <= ${max}
    ...    msg=${board} firmware too large: ${size} (max ${max})
    Log    ${board} firmware.bin: ${size} bytes

the partitions binary should exist for "${board}"
    [Documentation]    Partition table binary should be present.
    File Should Exist    ${BUILD_DIR}/${board}/partitions.bin
    ${size}=    Get File Size    ${BUILD_DIR}/${board}/partitions.bin
    Should Be True    ${size} > 0    msg=partitions.bin is empty

the boot message should contain "${marker}"
    [Documentation]    Verify boot output contains expected marker text.
    Should Contain    ${BOOT_LINE}    ${marker}
    ...    msg=Boot marker "${marker}" not found in: ${BOOT_LINE}

the heap should be greater than "${min_bytes}" bytes
    [Documentation]    Verify free heap exceeds minimum at boot.
    ${info}=    Collect Boot Info
    Log    Boot info: ${info}
    Should Be True    ${info}[heap] > ${min_bytes}
    ...    msg=Low heap at boot: ${info}[heap] bytes (min ${min_bytes})

the PSRAM should be detected
    [Documentation]    Verify PSRAM is present (ESP32-S3 boards).
    ${info}=    Collect Boot Info
    Should Be True    ${info}[psram] > 0
    ...    msg=PSRAM not detected — board may be damaged

the CPU frequency should be "${freq}" MHz
    [Documentation]    Verify CPU clock speed.
    ${info}=    Collect Boot Info
    Should Be True    ${info}[cpu] == ${freq}
    ...    msg=Unexpected CPU: ${info}[cpu] MHz (expected ${freq})

key source files should exist
    [Documentation]    Verify critical source files are present.
    File Should Exist    ${PROJECT_DIR}/src/main.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/protocol.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/serial_client.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/wifi_manager.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/ws_client.cpp
    File Should Exist    ${PROJECT_DIR}/src/state/agent_state.h
    File Should Exist    ${PROJECT_DIR}/platformio.ini

# ═══════════════════════════════════════════════════════════════════
# Helpers (not BDD steps, used internally)
# ═══════════════════════════════════════════════════════════════════

Get Board Port
    [Documentation]    Resolve serial port for a board from inventory or auto-detect.
    [Arguments]    ${board}
    # First try auto-detection (handles port changes between sessions)
    ${detected}=    Detect ESP32 Port
    IF    '${detected}' != 'None'
        RETURN    ${detected}
    END
    # Fallback: return None to trigger skip
    RETURN    None

Disconnect Device
    [Documentation]    Safely close serial connection.
    Close ESP32 Serial
