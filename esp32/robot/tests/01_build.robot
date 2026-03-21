*** Settings ***
Documentation       ESP32 firmware build verification.
...                 Runs without hardware — validates PlatformIO build
...                 produces correct firmware binaries with sane sizes.
Library             Process
Library             OperatingSystem
Library             Collections
Variables           ../resources/variables.py
Force Tags          no-hw    smoke

*** Variables ***
${PIO_TIMEOUT}      300s

*** Test Cases ***
Build Default Board (box_86)
    [Documentation]    Build the default board variant and verify binary output.
    ${result}=    Run Process    pio    run    -e    box_86
    ...    cwd=${PROJECT_DIR}    timeout=${PIO_TIMEOUT}    stderr=STDOUT
    Log    ${result.stdout}
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=PlatformIO build failed:\n${result.stdout}
    File Should Exist    ${BUILD_DIR}/box_86/firmware.bin
    File Should Exist    ${BUILD_DIR}/box_86/partitions.bin

Firmware Binary Size Is Sane (box_86)
    [Documentation]    Firmware should be between 1MB and 3.5MB.
    [Setup]    Build If Not Exists    box_86
    ${size}=    Get File Size    ${BUILD_DIR}/box_86/firmware.bin
    ${min}=    Set Variable    ${BOARDS}[box_86][min_firmware_bytes]
    ${max}=    Set Variable    ${BOARDS}[box_86][max_firmware_bytes]
    Should Be True    ${size} >= ${min}
    ...    msg=Firmware too small: ${size} bytes (min ${min})
    Should Be True    ${size} <= ${max}
    ...    msg=Firmware too large: ${size} bytes (max ${max})
    Log    firmware.bin size: ${size} bytes

Partitions Binary Exists (box_86)
    [Documentation]    Partition table must be generated alongside firmware.
    [Setup]    Build If Not Exists    box_86
    File Should Exist    ${BUILD_DIR}/box_86/partitions.bin
    ${size}=    Get File Size    ${BUILD_DIR}/box_86/partitions.bin
    Should Be True    ${size} > 0    msg=partitions.bin is empty

Build All Board Variants
    [Documentation]    Build all three board variants sequentially.
    [Tags]    full
    FOR    ${env}    IN    @{ALL_BOARD_ENVS}
        Log    Building ${env}...
        ${result}=    Run Process    pio    run    -e    ${env}
        ...    cwd=${PROJECT_DIR}    timeout=${PIO_TIMEOUT}    stderr=STDOUT
        Should Be Equal As Integers    ${result.rc}    0
        ...    msg=${env} build failed:\n${result.stdout}
        File Should Exist    ${BUILD_DIR}/${env}/firmware.bin
        ${size}=    Get File Size    ${BUILD_DIR}/${env}/firmware.bin
        ${min}=    Set Variable    ${BOARDS}[${env}][min_firmware_bytes]
        Should Be True    ${size} >= ${min}
        ...    msg=${env} firmware too small: ${size} bytes
        Log    ${env}: firmware.bin = ${size} bytes
    END

Build Boot Test Environment
    [Documentation]    Minimal boot_test environment should compile (smaller, no LVGL).
    ${result}=    Run Process    pio    run    -e    boot_test
    ...    cwd=${PROJECT_DIR}    timeout=${PIO_TIMEOUT}    stderr=STDOUT
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=boot_test build failed:\n${result.stdout}
    File Should Exist    ${BUILD_DIR}/boot_test/firmware.bin
    # boot_test is minimal — should be much smaller than full firmware
    ${size}=    Get File Size    ${BUILD_DIR}/boot_test/firmware.bin
    Should Be True    ${size} < 500000
    ...    msg=boot_test firmware unexpectedly large: ${size} bytes
    Log    boot_test firmware.bin: ${size} bytes

Source Files Exist
    [Documentation]    Verify key source files are present before build.
    [Tags]    quick
    File Should Exist    ${PROJECT_DIR}/src/main.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/protocol.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/serial_client.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/wifi_manager.cpp
    File Should Exist    ${PROJECT_DIR}/src/net/ws_client.cpp
    File Should Exist    ${PROJECT_DIR}/src/state/agent_state.h
    File Should Exist    ${PROJECT_DIR}/platformio.ini

PlatformIO Configuration Is Valid
    [Documentation]    Verify platformio.ini can be parsed without errors.
    [Tags]    quick
    ${result}=    Run Process    pio    project    config
    ...    cwd=${PROJECT_DIR}    timeout=30s    stderr=STDOUT
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=PlatformIO config invalid:\n${result.stdout}

*** Keywords ***
Build If Not Exists
    [Documentation]    Build a board variant only if firmware.bin doesn't exist yet.
    [Arguments]    ${env}
    ${exists}=    Run Keyword And Return Status
    ...    File Should Exist    ${BUILD_DIR}/${env}/firmware.bin
    IF    not ${exists}
        ${result}=    Run Process    pio    run    -e    ${env}
        ...    cwd=${PROJECT_DIR}    timeout=${PIO_TIMEOUT}    stderr=STDOUT
        Should Be Equal As Integers    ${result.rc}    0
    END
