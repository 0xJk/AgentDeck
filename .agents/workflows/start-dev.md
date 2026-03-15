---
description: Start Dev Mode (Watch all packages)
---
이 워크플로우는 모든 패키지를 watch 모드로 실행하여 개발 환경을 시작합니다.
작업 시 터미널을 백그라운드로 돌리거나, 개발용 세션을 유지할 때 사용합니다.

1. 전체 의존성 패키지를 설치합니다.
// turbo
pnpm install

2. Watch 모드로 개발 환경을 구동합니다. (parallel mode)
// turbo
pnpm -r --parallel dev
