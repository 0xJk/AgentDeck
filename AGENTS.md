# AGENTS.md

## 프로젝트 지침 (Antigravity & AI Agents)

이 프로젝트(AgentDeck)에서 작업할 때 모든 AI 에이전트(Antigravity 포함)는 다음 지침을 **반드시** 따르십시오.

### 1. 컨텍스트 및 아키텍처 파악 (필수)
- 모든 작업(특히 새로운 기능 추가, 구조 변경, 디버깅) 시작 전에 **반드시 `CLAUDE.md`와 `DEVELOPMENT_LOG.md`를 먼저 읽으십시오.**
- `CLAUDE.md`는 프로젝트 아키텍처, 브릿지-플러그인 통신 규약, 포트 설정, UI/UX 비전(특히 Android E-ink 최적화 규칙)을 담고 있는 **단일 진실 공급원(SSOT)**입니다.
- 정보를 여러 문서로 분산시키지 마십시오. 만약 프로젝트의 핵심 구조적 변경이 발생하면, 이 정보들을 `CLAUDE.md`나 `DEVELOPMENT_LOG.md`에 업데이트하여 최신 상태로 유지해야 합니다.

### 2. 워크플로우 자동화 활용
- 빌드, 환경 설정 등의 반복 작업은 직접 스크립트 명령어를 유추해서 실행하지 말고, `.agents/workflows/` 디렉토리에 정의된 워크플로우를 사용하십시오.
  - 예: 안드로이드 APK 빌드 (`build-android.md`), 터미널 환경 세션 시작 등

### 3. 주요 개발 원칙 요약
- **Monorepo**: 프로젝트는 `pnpm workspaces` 기반으로 구성되어 있습니다. 항상 적절한 패키지(`bridge`, `plugin`, `shared`, `android` 등) 디렉토리를 확인하고 작업하세요.
- **Android / E-ink UX**: 안드로이드 환경(Jetpack Compose) 수정 시 E-ink 디스플레이(Crema/Onyx) 특성을 매우 엄격하게 고려해야 합니다. (그레이스케일 디더링, 하드웨어 부분 새로고침 등 `CLAUDE.md`에 명시된 규칙 준수)
- **명령어 안전성**: 데몬 스크립트나 시스템 환경에 영향을 주는 코드를 테스트할 때는 신중히 접근하십시오.
