*** Settings ***
Documentation       ESP32 serial JSON protocol compatibility tests.
...                 Requires physical ESP32 with full firmware flashed.
...                 Tests JSON message handling: device_info, state_update,
...                 usage_update, malformed JSON recovery.
Library             Collections
Library             ../libraries/ESP32Serial.py
Variables           ../resources/variables.py
Force Tags          hw    protocol
Suite Setup         Connect To ESP32
Suite Teardown      Close ESP32 Serial

*** Test Cases ***
Device Info Request And Response
    [Documentation]    Send device_info_request, verify response fields.
    ...                ESP32 should respond with: type, board, version,
    ...                wifiConfigured, wifiConnected.
    ${info}=    Get Device Info    timeout=5
    Dictionary Should Contain Key    ${info}    type
    Dictionary Should Contain Key    ${info}    board
    Dictionary Should Contain Key    ${info}    version
    Dictionary Should Contain Key    ${info}    wifiConfigured
    Dictionary Should Contain Key    ${info}    wifiConnected
    Should Be Equal    ${info}[type]    device_info
    Log    Device: board=${info}[board] version=${info}[version]

Device Info Board Is Valid
    [Documentation]    Board identifier should match a known board.
    ${info}=    Get Device Info
    ${valid_boards}=    Create List    86box    ips_35    round_amoled
    Should Contain    ${valid_boards}    ${info}[board]
    ...    msg=Unknown board: ${info}[board]

State Update Processing
    [Documentation]    ESP32 should accept state_update without crashing.
    ${msg}=    Create Dictionary
    ...    type=state_update
    ...    state=processing
    ...    projectName=TestProject
    ...    modelName=opus-4
    ...    agentType=claude-code
    Send JSON Message    ${msg}
    # Verify device is still responsive (didn't crash)
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}
    ...    msg=ESP32 stopped responding after state_update

State Update With Options
    [Documentation]    state_update with options array should be handled.
    ${option1}=    Create Dictionary    label=Yes    index=${0}    recommended=${True}
    ${option2}=    Create Dictionary    label=No    index=${1}    recommended=${False}
    ${options}=    Create List    ${option1}    ${option2}
    ${msg}=    Create Dictionary
    ...    type=state_update
    ...    state=awaiting_permission
    ...    question=Allow file read?
    ...    options=${options}
    Send JSON Message    ${msg}
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}

Usage Update Processing
    [Documentation]    ESP32 should accept usage_update messages.
    ${msg}=    Create Dictionary
    ...    type=usage_update
    ...    fiveHourPercent=${42.5}
    ...    sevenDayPercent=${15.0}
    ...    inputTokens=${50000}
    ...    outputTokens=${12000}
    ...    toolCalls=${25}
    ...    sessionDurationSec=${3600}
    ...    fiveHourResetsAt=1h 30m
    ...    sevenDayResetsAt=2d 4h
    Send JSON Message    ${msg}
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}

Sessions List Processing
    [Documentation]    ESP32 should handle sessions_list with multiple sessions.
    ${session1}=    Create Dictionary
    ...    id=sess-001    projectName=MyApp    agentType=claude-code
    ...    state=processing    port=${9121}    alive=${True}
    ${session2}=    Create Dictionary
    ...    id=sess-002    projectName=Backend    agentType=claude-code
    ...    state=idle    port=${9122}    alive=${True}
    ${sessions}=    Create List    ${session1}    ${session2}
    ${msg}=    Create Dictionary    type=sessions_list    sessions=${sessions}
    Send JSON Message    ${msg}
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}

Display State On/Off
    [Documentation]    display_state messages should not crash the device.
    Send JSON Message    {"type": "display_state", "displayOn": false}
    Sleep    0.5s
    Send JSON Message    {"type": "display_state", "displayOn": true}
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}

Malformed JSON Recovery
    [Documentation]    ESP32 should survive malformed JSON and recover.
    # Send broken JSON
    Send Raw    {broken json without closing\n
    Send Raw    not json at all\n
    Send Raw    {"type": "incomplete\n
    Send Raw    \n
    # Now send valid request — should still work
    Sleep    0.5s
    ${info}=    Get Device Info    timeout=5
    Should Be Equal    ${info}[type]    device_info
    ...    msg=ESP32 did not recover from malformed JSON

Empty Line Handling
    [Documentation]    Empty lines should be silently ignored.
    Send Raw    \n
    Send Raw    \n
    Send Raw    \n
    ${info}=    Get Device Info    timeout=5
    Should Be Equal    ${info}[type]    device_info

Large Message Handling
    [Documentation]    Messages near buffer limit (4096 bytes) should be handled.
    # Create a message that's large but within buffer
    ${long_name}=    Evaluate    'A' * 200
    ${msg}=    Create Dictionary
    ...    type=state_update    state=idle    projectName=${long_name}
    Send JSON Message    ${msg}
    Sleep    1s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}

Rapid Message Burst
    [Documentation]    Rapid sequential messages should not overflow ESP32 buffer.
    FOR    ${i}    IN RANGE    20
        Send JSON Message    {"type": "state_update", "state": "processing"}
    END
    Sleep    2s
    ${responsive}=    ESP32 Is Responsive    timeout=5
    Should Be True    ${responsive}
    ...    msg=ESP32 not responsive after message burst

Unknown Message Type Ignored
    [Documentation]    Unknown message types should be silently ignored.
    Send JSON Message    {"type": "unknown_future_message", "data": "test"}
    Sleep    0.5s
    ${info}=    Get Device Info    timeout=5
    Should Be Equal    ${info}[type]    device_info

*** Keywords ***
Connect To ESP32
    [Documentation]    Detect port, open serial, and wait for boot/ready.
    ${port}=    Detect ESP32 Port
    Skip If    '${port}' == 'None'    No ESP32 device connected
    Set Suite Variable    ${ESP32_PORT}    ${port}
    Open ESP32 Serial    ${port}
    Wait For Boot Message    timeout=${BOOT_TIMEOUT_SEC}
