*** Settings ***
Documentation       ESP32 serial JSON protocol compatibility tests (BDD style).
...                 Requires physical ESP32 with full firmware flashed.
...                 Uses Test Template to run the same protocol scenarios
...                 across all board variants.
Resource            ../resources/bdd_keywords.robot
Force Tags          hw    protocol
Suite Teardown      Disconnect Device

*** Test Cases ***
# ═══════════════════════════════════════════════════════════════════
# Device Info
# ═══════════════════════════════════════════════════════════════════

Box 86 Device Info
    [Template]    Device Info Scenario
    box_86

IPS 3.5 Device Info
    [Template]    Device Info Scenario
    ips_35

Round AMOLED Device Info
    [Template]    Device Info Scenario
    round_amoled

Ulanzi TC001 Device Info
    [Template]    Device Info Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# State Updates
# ═══════════════════════════════════════════════════════════════════

Box 86 State Update
    [Template]    State Update Scenario
    box_86

IPS 3.5 State Update
    [Template]    State Update Scenario
    ips_35

Round AMOLED State Update
    [Template]    State Update Scenario
    round_amoled

Ulanzi TC001 State Update
    [Template]    State Update Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# State Update With Options
# ═══════════════════════════════════════════════════════════════════

Box 86 State Update With Options
    [Template]    State Update With Options Scenario
    box_86

IPS 3.5 State Update With Options
    [Template]    State Update With Options Scenario
    ips_35

Round AMOLED State Update With Options
    [Template]    State Update With Options Scenario
    round_amoled

Ulanzi TC001 State Update With Options
    [Template]    State Update With Options Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# Usage & Sessions
# ═══════════════════════════════════════════════════════════════════

Box 86 Usage Update
    [Template]    Usage Update Scenario
    box_86

Box 86 Sessions List
    [Template]    Sessions List Scenario
    box_86

# ═══════════════════════════════════════════════════════════════════
# Display Control
# ═══════════════════════════════════════════════════════════════════

Box 86 Display On Off
    [Template]    Display On Off Scenario
    box_86

IPS 3.5 Display On Off
    [Template]    Display On Off Scenario
    ips_35

Round AMOLED Display On Off
    [Template]    Display On Off Scenario
    round_amoled

# ═══════════════════════════════════════════════════════════════════
# Error Recovery (critical for all devices)
# ═══════════════════════════════════════════════════════════════════

Box 86 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    box_86

IPS 3.5 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    ips_35

Round AMOLED Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    round_amoled

Ulanzi TC001 Malformed JSON Recovery
    [Template]    Malformed JSON Recovery Scenario
    ulanzi_tc001

# ═══════════════════════════════════════════════════════════════════
# Stress / Edge Cases
# ═══════════════════════════════════════════════════════════════════

Box 86 Empty Lines
    [Template]    Empty Line Handling Scenario
    box_86

Box 86 Large Message
    [Template]    Large Message Scenario
    box_86

Box 86 Rapid Burst
    [Template]    Rapid Burst Scenario
    box_86

Box 86 Unknown Message Type
    [Template]    Unknown Message Type Scenario
    box_86

*** Keywords ***
# ───────────────────────────────────────────────────────────────────

Device Info Scenario
    [Documentation]    Request device_info and verify all fields.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a device info request
    Then the device should respond with device info
    And the device info should contain valid fields
    And the device info board should be valid

State Update Scenario
    [Documentation]    Send state_update and verify no crash.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with state "processing"
    Then the device should still be responsive

State Update With Options Scenario
    [Documentation]    Send state_update with options array.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a state update with options
    Then the device should still be responsive

Usage Update Scenario
    [Documentation]    Send usage_update and verify acceptance.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a usage update
    Then the device should still be responsive

Sessions List Scenario
    [Documentation]    Send multi-session list.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a sessions list
    Then the device should still be responsive

Display On Off Scenario
    [Documentation]    Toggle display on/off.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send display state "off"
    And I send display state "on"
    Then the device should still be responsive

Malformed JSON Recovery Scenario
    [Documentation]    Send broken JSON, verify recovery.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send malformed JSON data
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

Empty Line Handling Scenario
    [Documentation]    Empty lines should be silently ignored.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send empty lines
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info

Large Message Scenario
    [Documentation]    Messages near buffer limit should be handled.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send a large message with project name of "200" characters
    Then the device should still be responsive

Rapid Burst Scenario
    [Documentation]    Rapid sequential messages should not overflow.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send "20" rapid messages
    Then the device should still be responsive

Unknown Message Type Scenario
    [Documentation]    Unknown types should be silently ignored.
    [Arguments]    ${board}
    Given the ESP32 device "${board}" is connected and booted
    When I send an unknown message type
    Then the device should still be responsive
    When I send a device info request
    Then the device should respond with device info
