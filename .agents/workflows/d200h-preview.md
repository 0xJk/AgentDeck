---
description: Preview latest D200H set_buttons dump
---
이 워크플로우는 D200H 실기기 전송 ZIP을 로컬 preview로 변환해 버튼 배치와 manifest를 확인합니다.

1. 최신 `set_buttons` dump로 contact sheet와 HTML preview를 생성합니다.
// turbo
pnpm d200h:preview -- --out /tmp/agentdeck-d200h-preview

2. 생성물을 확인합니다.
- `/tmp/agentdeck-d200h-preview/d200h-contact-sheet.png`
- `/tmp/agentdeck-d200h-preview/preview.html`
