# 6개의 LLM을 감으로 라우팅하는 것을 그만두기로 했다

*AgentDeck 에 APME(Agent Performance Monitoring & Evaluation)를 붙인 이유*

---

## 1. 어느 날의 하루

오전에 Opus로 복잡한 리팩토링 하나.
점심쯤 Opus 토큰이 부족할 것 같아서 Codex로 세컨드 오피니언.
오후에 Gemini Antigravity한테 "이 라이브러리 조사해줘".
저녁엔 로컬 Qwen MLX한테 변경 사항 요약 시켜놓고 퇴근.

이게 내 일상이다. 내가 쓰고 있는 모델은 다음과 같다.

```
Claude Opus 4.6      ← 메인 드라이버. 비쌈
Claude Sonnet 4.6    ← Opus 리밋 소진 시
Codex (GPT-5.4)      ← 세컨드 오피니언
Gemini Antigravity   ← 대용량 context, research
GLM-5.1              ← 중간 난이도
Qwen3.5-30B (MLX)    ← 로컬, 무료
```

그리고 질문이 생겼다.

**"이게 효율적인 건가?"**

근거가 없었다. "감"이었다.

---

## 2. 감이 무서운 이유

"감"이 그 자체로 나쁜 건 아니다. 경험이 쌓이면 어떤 도메인에서는 감이 꽤 정확해진다.

문제는 6개 모델을 **각자 다른 카테고리의 태스크에** 감으로 분배할 때 생긴다:

- 내가 기억하는 건 **극단적 사건**뿐이다. "지난주에 Codex가 정말 잘했지" 같은 스냅샷. 수십 개의 평범한 run은 잊혀진다.
- 모델은 **한 카테고리에서는 훌륭하고 다른 카테고리에서는 평범**할 수 있다. "Codex가 좋다"는 문장 자체가 의미가 없다.
- **비용**은 감으로 못 잡는다. "이 태스크, Opus 값을 할 만큼 중요한가?" — 매번 이걸 눈감고 결정하고 있다는 걸 깨달았다.

특히 두 번째 문제가 컸다. Opus는 어떤 태스크에서는 Codex보다 명백히 낫고, 어떤 태스크에서는 거의 차이 없다. 후자의 경우 돈을 그냥 태우고 있는 셈이다.

이걸 **측정**하고 싶었다.

---

## 3. 범용 벤치마크는 답이 아니다

처음엔 기존 벤치마크 결과를 참고하면 되지 않나 생각했다. HumanEval, SWE-bench, LMSys arena 같은 것들.

안 된다. 이유 3가지:

```
  범용 벤치마크          ≠   내 작업
  평균 사용자            ≠   내 선호
  "overall 점수"          ≠   "내 코드베이스에서 debugging"
```

모델 A가 SWE-bench에서 5%p 높다고 해도, **내 레포에서, 내 스타일로, 내 기준에서** 그 차이가 유의미한지는 별개 문제다. 내가 쓰는 태스크 분포는 벤치마크와 같지 않다 — 사실 내 경우 **절반은 코딩도 아니다**. "에러 로그 설명해줘", "이 라이브러리 어떻게 쓰는 건지 조사해줘" 같은 conversation/research가 훨씬 많다.

결론: **개인화된 평가 시스템**이 필요하다. 내 작업 위에서, 내 기준으로.

그래서 AgentDeck에 APME — Agent Performance Monitoring & Evaluation 모듈을 붙였다.

---

## 4. 카테고리별로 평가 방법이 달라야 한다

APME를 만들면서 가장 중요한 설계 결정 하나는 **"카테고리마다 평가 방법이 아예 다르다"**는 것이었다.

처음엔 나도 하나의 공통 루브릭으로 모든 run을 평가하려고 했다. "task_completion, code_quality, efficiency" 같은 3축. 근데 이건 망한다.

- **conversation**은 code_quality가 말이 안 된다. 코드가 없는데.
- **planning**은 git diff가 없다. 파일이 안 바뀌었다고 "abandoned" 라고 할 수는 없다.
- **debugging**은 "근본 원인을 찾았는가"가 핵심인데, 일반 루브릭으로는 이걸 평가 못 한다.

그래서 10개 카테고리로 나누고, 각자 다른 루브릭을 쓰기로 했다:

```
┌─────────────────┬────────────────────────────────────┐
│ 카테고리         │ 루브릭 축                           │
├─────────────────┼────────────────────────────────────┤
│ general(coding) │ task_completion · code_quality ·    │
│                 │  efficiency                         │
│ debugging       │ diagnosis · fix_quality ·           │
│                 │  verification                       │
│ refactoring     │ safety · improvement · scope        │
│ conversation    │ accuracy · helpfulness · conciseness│
│ planning        │ completeness · feasibility · clarity│
│ research        │ thoroughness · relevance · synthesis│
│ review          │ coverage · insight · accuracy       │
└─────────────────┴────────────────────────────────────┘
```

**같은 모델이 "debugging 잘함 + conversation에선 장황함"일 수 있고, 그게 정상이다.**

---

## 5. 평가 타이밍도 카테고리마다 다르다

더 나아가서, **언제 평가할지**도 카테고리별로 다르게 설계했다.

### 코딩 3종 (coding / refactoring / debugging)
- git diff가 있어야 의미 있는 평가가 가능함
- → **run 종료 후에** run-level eval
- → 결정론 레이어(lint/build/tests 실행) + LLM judge

### 비코딩 4종 (conversation / planning / research / review)
- git diff가 의미 없음. 응답 텍스트 자체가 결과물
- → **턴마다 즉시** turn-level eval
- → LLM judge만 (결정론 레이어 없음)

이게 왜 중요하냐면, conversation 세션에서 내가 10턴 대화했다면 **10개의 평가 데이터**가 쌓인다. 기존 구조처럼 세션 종료 후 한 번만 평가하면 1개밖에 안 쌓인다. 비코딩 태스크에서 **데이터 밀도가 10배 차이**나는 셈이다.

그리고 대시보드에서 턴별로 점수 + 이유가 즉시 보인다. 실시간 피드백 루프가 짧아진다.

---

## 6. 점수 하나를 믿지 않는다 — Composite Score

"judge 점수가 0.8이었다" 만으로는 그 run이 좋았는지 나빴는지 판단할 수 없다. LLM judge는 같은 응답에 대해서도 모델마다, 프롬프트마다 다른 점수를 낸다.

그래서 **4개의 독립적인 신호를 가중합**한다:

```
composite = 0.40 × outcome      ← 실제로 끝났는가 (git diff/응답 캡처)
          + 0.40 × judge         ← LLM 판단
          + 0.15 × efficiency    ← 자원 낭비 안 했나 (토큰/시간)
          + 0.05 × vibe          ← 내가 승인했나
```

차원이 독립이라서 한쪽이 틀려도 다른 쪽이 잡아준다. judge가 후하게 줘도 outcome이 "abandoned"면 전체 점수는 낮아진다.

`outcome`은 특히 카테고리별로 다르게 판정한다. 코딩 태스크의 outcome은:

```
  committed    1.00   ← 커밋까지 감
  iterated     0.60   ← 여러 번 시도
  exploratory  0.50   ← 변경은 있지만 미커밋
  abandoned    0.20   ← 변경 없음
```

반면 비코딩 태스크는 "응답 텍스트만 있으면 committed = 1.0" 으로 본다. research에서 어떤 파일도 안 바뀐 게 실패는 아니니까.

---

## 7. LLM judge 먼저 만들지 않았다

이 부분이 가장 반직관적이다. **LLM judge를 잘 만들어두면 내가 수작업할 필요 없지 않나?** 그런데 안 했다.

이유: **judge가 내 기준에 맞는지 검증할 방법이 없다.** 사람 데이터가 없으면 judge가 엉뚱한 방향으로 가도 그걸 발견할 수 없다.

그래서 순서를 뒤집었다:

```
Step 1  — 데이터 수집 (자동)
Step 2  — 분류 (자동, 10 카테고리)
Step 3  — 내가 직접 레이블링 (vibe check 👍/👎)  ← 여기가 ground truth
Step 4  — judge가 내 레이블과 일치하도록 자동 튜닝
```

Step 3이 **ground truth**다. Step 4는 Step 3의 데이터가 쌓여야 의미 있다.

### Step 4를 어떻게 자동 튜닝하는가

이 부분은 OPRO (Optimization by PROmpting) 스타일의 루프를 쓴다. 원리는 이렇다:

1. judge 점수와 내 vibe 레이블의 **불일치 샘플**을 모은다
   - 예: "내가 👎 눌렀는데 judge는 0.85"
2. judge에게 그 샘플을 보여주고 **"왜 이런 차이가 났는지 설명하고, 더 나은 루브릭을 제안하라"** 고 요청
3. 제안된 루브릭을 **shadow mode**로 기존 데이터에 적용
4. vibe와의 **상관관계가 실제로 개선**되는 경우에만 accept
5. 개선 안 되면 reject, 현재 루브릭 유지

시간이 지날수록 judge는 내 판단과 일치하는 방향으로 수렴한다. 그리고 이 과정이 **내 데이터 안에서** 일어난다 — 범용 벤치마크로는 할 수 없는 일이다.

---

## 8. 의도적인 제약: "싸게 돌아가야 한다"

judge는 모든 run에 돌아가야 하므로 비용이 감당 안 되면 내가 judge를 꺼버릴 것이다. 껐다가 데이터 축적이 멈추면 Step 4 튜닝도 끝장난다. 그래서:

```
  Judge 백엔드      = 로컬 MLX (Qwen3.5-30B)
  보조              = OpenClaw Gateway (그것도 로컬)
  클라우드 API       = 안 씀
  sampleRate        = 1.0 (전수 평가)
```

로컬에서만 돌리니까 `sampleRate: 1.0` — 전수 평가가 기본이다. 성능 차이(로컬 < 프론티어 모델)는 **Step 4의 auto-tune이 채운다**는 게 가설이다. **싼 judge + 튜닝 루프 > 비싼 judge + 정적 루브릭**. 검증은 아직 못 했지만 설계 원칙은 이렇게 정했다.

---

## 9. 데이터 수집이 가장 어려웠다

생각지도 못한 기술적 어려움은 "3개 서로 다른 에이전트의 이벤트 형태를 하나의 스키마로 수렴시키기" 였다.

- **Claude Code** 는 hook HTTP POST를 쓴다. 근데 Stop 훅이 불안정해서(v2.1.104 기준 발화율 ~18%) 응답 텍스트를 놓친다. 결국 PTY 출력에서 `⏺` 마커를 찾아 tail 파싱하는 자체 파서를 만들었다. 그리고 "응답 spinner_stop"과 "새 UserPromptSubmit" 사이의 race condition 때문에 3개 경로 fallback을 구현해야 했다.
- **OpenClaw / OpenCode** 는 구조화된 timeline 이벤트를 준다. 이건 상대적으로 쉬움.
- **Codex CLI** 는 hook도 timeline도 없다. PTY 파서 + spinner_stop 이벤트 + tail 파싱이 유일한 경로. 그리고 tail에서 spinner 문자(`✢✳✶✻✽`), 모드 마커(`⏸⏵`), 프롬프트 echo 등을 전부 필터링해야 한다.

서로 다른 에이전트의 다른 형태의 신호들을 다 받아내서 **단일 ApmeCollector API**(`ingestHook`, `setTurnResponse`, `closeTurn`, `closeRun`)로 수렴시킨 게 이 프로젝트에서 제일 노동 집약적인 부분이었다. 이 부분이 완성되어야 그 위에 평가가 의미 있기 때문이다.

---

## 10. 평가 결과를 내 시야에 강제로 가져오기

가장 큰 병목은 기술이 아니라 **습관**이다. "내가 실제로 vibe 레이블을 꾸준히 입력해야 한다." 안 하면 Step 4가 전진하지 못한다.

그래서 평가 결과를 **모든 디바이스에** 실시간으로 띄우도록 만들었다. 내가 데스크 위에서 쳐다볼 수밖에 없는 면들이다:

- Stream Deck에 ★ 아이콘으로
- iPhone/iPad/Mac 대시보드에 LED row로
- 책상 옆 ESP32 디스플레이에 timeline entry로
- 터미널 TUI 대시보드에도

run이 끝나면 **여러 면에 동시에 ★ 82%**가 뜬다. 시선이 간다. "👍 누를까?"라는 생각이 든다.

UX가 아키텍처의 일부다. "데이터 수집 행동을 유도하는 것" 자체가 이 시스템의 설계 목표 중 하나다.

---

## 11. 성공의 정의

APME가 "성공했다"고 말할 수 있는 6개월 후의 어느 날은 이런 모습일 거다.

새 태스크를 시작할 때:

> "이건 debugging이니까 Codex"

라고 **감으로** 생각하는 대신:

> "지난 50개 debugging run에서 Codex가 Opus 대비 품질 95%,
>  비용 40%. 이 태스크도 Codex로 가자."

라고 **데이터로** 판단할 수 있는 것.

혹은:

> "이 작업은 중요하니까 Opus"

대신:

> "이 카테고리는 내 vibe 기준 모델 간 갭이 크다 → Opus.
>  반대로 이 카테고리는 갭이 작음 → MLX."

판단의 근거가 내 SQLite 안에 있게 되는 것. 그것이 목적이다.

---

## 12. 지금 어디까지 왔나

- ✅ 데이터 수집 (3-path ingestion 전부 가동)
- ✅ 분류 (10 카테고리 rule + MLX fallback)
- ✅ 카테고리별 루브릭 7종
- ✅ Runner — 코딩은 run-level, 비코딩은 turn-level
- ✅ Composite score (outcome + judge + efficiency + vibe)
- ✅ 3가지 judge 백엔드 (MLX 기본)
- ✅ 데몬 30초 복구 루프
- ✅ 모든 디바이스 `★ eval_result` 렌더링
- 🧪 Auto-tuner — 구조는 완성, vibe 데이터 30개 쌓이면 첫 실행
- 🔧 **vibe 레이블링 습관** — 인프라 끝. 내가 실제로 누르는 게 남았다

아이러니한 건, 이렇게 복잡한 파이프라인을 만들어놓고 마지막 병목이 "내가 👍 버튼 누르는 습관"이라는 점이다. 그런데 이게 정상이다 — **사람 데이터가 시드**고, 인프라는 그걸 축적하고 활용하기 위한 빠른 길을 파는 것이다.

---

## 13. 마치며

LLM 라우팅 문제에 대한 해결책으로 제시되는 것들은 보통 두 가지다:

1. **더 큰 모델 하나만 쓰기** — 비용 감당 못 함
2. **범용 벤치마크 스코어 참고** — 내 작업과 상관 없음

세 번째 길을 열고 싶었다: **내 작업 위에서 개인화된 평가 데이터를 축적하고, 그 데이터로 라우팅을 결정하기.**

측정 없는 최적화는 감이다. 감이 꼭 나쁘진 않지만, 근거가 생기면 감을 더 잘 쓸 수 있다. 그게 지금 APME로 하려는 일이다.

*AgentDeck 은 [github.com/puritysb/AgentDeck](https://github.com/puritysb/AgentDeck) 에서 개발 중입니다. APME 모듈 구현 상세는 [docs/apme-pipeline.md](../apme-pipeline.md), 아키텍처 결정의 근거는 [docs/why-apme.md](../why-apme.md) 참조.*
