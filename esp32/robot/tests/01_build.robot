*** Settings ***
Documentation       ESP32 firmware build verification (BDD style).
...                 Runs without hardware — validates PlatformIO build
...                 produces correct firmware binaries with sane sizes.
...                 Uses Test Template to run the same scenarios across
...                 all board variants.
Resource            ../resources/bdd_keywords.robot
Force Tags          no-hw    smoke

*** Test Cases ***
# ── Per-board build & size verification ──────────────────────────

Box 86 Build And Verify
    [Template]    Build And Verify Scenario
    box_86

IPS 3.5 Build And Verify
    [Template]    Build And Verify Scenario
    ips_35

Round AMOLED Build And Verify
    [Template]    Build And Verify Scenario
    round_amoled

Ulanzi TC001 Build And Verify
    [Template]    Build And Verify Scenario
    ulanzi_tc001

# ── Boot test environment ────────────────────────────────────────

Boot Test Environment Builds Successfully
    [Documentation]    Minimal boot_test must compile and be smaller than 500KB.
    Given the "boot_test" firmware is built
    Then the firmware binary should exist for "boot_test"
    ${size}=    Get File Size    ${BUILD_DIR}/boot_test/firmware.bin
    Should Be True    ${size} < 500000
    ...    msg=boot_test firmware unexpectedly large: ${size} bytes

# ── QSPI boot test environment ──────────────────────────────────

Boot Test QSPI Environment Builds Successfully
    [Documentation]    QSPI boot_test variant must compile.
    ...    Note: pioarduino FRAMEWORK_DIR issue may cause CI failure.
    [Tags]    no-hw    smoke    local-only
    Given the "boot_test_qspi" firmware is built
    Then the firmware binary should exist for "boot_test_qspi"

# ── Source and config sanity ─────────────────────────────────────

Source Files Are Present
    [Documentation]    Key source files must exist before build.
    [Tags]    quick
    Then key source files should exist

PlatformIO Configuration Parses Cleanly
    [Documentation]    platformio.ini must parse without errors.
    [Tags]    quick
    Given the PlatformIO configuration is valid

*** Keywords ***
Build And Verify Scenario
    [Documentation]    Given a board, build firmware and verify outputs.
    [Arguments]    ${board}
    Given the "${board}" firmware is built
    Then the firmware binary should exist for "${board}"
    And the firmware size should be sane for "${board}"
    And the partitions binary should exist for "${board}"
