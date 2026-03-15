---
description: Build Android Release APK
---
이 워크플로우는 AgentDeck 안드로이드 앱의 릴리즈 빌드를 수행합니다. JDK 17+ 환경이 필요하며, 스크립트가 Homebrew JDK를 자동 감지합니다.

1. 의존성 패키지를 설치합니다.
// turbo
pnpm install

2. 안드로이드 릴리즈 빌드 스크립트를 실행합니다. 빌드된 APK는 `dist/` 폴더에 생성됩니다.
// turbo
bash scripts/build-android-release.sh
