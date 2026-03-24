*** Settings ***
Documentation       ESP32 firmware flash and boot verification (BDD style).
...                 Requires physical ESP32 device connected via USB.
...                 Uses Test Template to run the same flash→boot→health
...                 scenario across all board variants.
Resource            ../resources/bdd_keywords.robot
Force Tags          hw
Suite Teardown      Disconnect Device

*** Test Cases ***
# ── Per-board flash and boot ─────────────────────────────────────

Box 86 Flash And Boot
    [Template]    Flash And Boot Scenario
    box_86

IPS 3.5 Flash And Boot
    [Template]    Flash And Boot Scenario
    ips_35

Round AMOLED Flash And Boot
    [Template]    Flash And Boot Scenario
    round_amoled

Ulanzi TC001 Flash And Boot
    [Template]    Flash And Boot Scenario
    ulanzi_tc001

# ── Full firmware boot (after flashing full env) ─────────────────

Box 86 Full Firmware Boot
    [Template]    Full Firmware Boot Scenario
    [Tags]    full
    box_86

IPS 3.5 Full Firmware Boot
    [Template]    Full Firmware Boot Scenario
    [Tags]    full
    ips_35

Round AMOLED Full Firmware Boot
    [Template]    Full Firmware Boot Scenario
    [Tags]    full
    round_amoled

# ── Recovery after disconnect ────────────────────────────────────

Box 86 Recovery After Reconnect
    [Template]    Recovery Scenario
    [Tags]    recovery
    box_86

*** Keywords ***
Flash And Boot Scenario
    [Documentation]    Flash firmware, verify boot and hardware health.
    [Arguments]    ${board}
    Given the "${board}" firmware is built if not exists
    And the "${board}" firmware is flashed to the device
    When the ESP32 device "${board}" is connected
    Then the ESP32 device "${board}" is booted
    And the boot message should contain "AgentDeck"
    And the heap should be greater than "100000" bytes
    And the device should still be responsive

Full Firmware Boot Scenario
    [Documentation]    Flash full firmware and verify boot completes.
    [Arguments]    ${board}
    Given the "${board}" firmware is built
    And the "${board}" firmware is flashed to the device
    When the ESP32 device "${board}" is connected
    Then the ESP32 device "${board}" is booted
    And the device should still be responsive

Recovery Scenario
    [Documentation]    Verify device survives serial disconnect/reconnect.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I reconnect after closing the serial port
    Then the device should still be responsive
