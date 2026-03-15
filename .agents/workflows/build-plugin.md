---
description: Build and Link Stream Deck Plugin
---
이 워크플로우는 Stream Deck 플러그인을 빌드하고, 로컬 Stream Deck 앱에 링크합니다.

1. 전체 의존성 패키지를 설치합니다.
// turbo
pnpm install

2. 모든 패키지(shared, bridge, plugin)를 순서대로 빌드합니다.
// turbo
pnpm build

3. 빌드된 플러그인을 데스크탑 Stream Deck 애플리케이션에 링크합니다. (이 과정 후 Stream Deck 앱이 플러그인을 인식하게 됩니다.)
// turbo
cd plugin && streamdeck link
