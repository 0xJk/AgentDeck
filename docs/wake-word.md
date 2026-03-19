# Wake Word Detection

AgentDeck는 두 가지 wake word 감지 시스템을 지원한다.

## 1. Porcupine (Mac — 현재 운영)

Mac Studio 모니터 마이크로 "오픈클로" 키워드 감지.

- **엔진**: Picovoice Porcupine (`@picovoice/porcupine-node`)
- **키워드**: `~/.agentdeck/wake-word/*.ppn` (한국어 커스텀 모델)
- **언어모델**: `~/.agentdeck/wake-word/*.pv` (Korean)
- **Access key**: `~/.agentdeck/picovoice-key.txt`
- **코드**: `bridge/src/wake-word.ts` — `WakeWordListener` class
- **설정**: `~/.agentdeck/settings.json` — `wakeWordMic`, `wakeWordSensitivity`
- **제한**: 모니터 sleep 시 마이크 비활성 → 감지 불가

## 2. microWakeWord (ESP32 — 개발 중)

ESP32-S3 Round AMOLED의 내장 I2S PDM 마이크로 상시 감지. 모니터 꺼져도 동작.

- **엔진**: microWakeWord (TFLite Micro, MixConv streaming)
- **모델**: `esp32/models/openclaw_wake_word.tflite` (62KB, INT8 양자화)
- **타겟 보드**: Round AMOLED JC3636W518 (ESP32-S3, I2S PDM mic GPIO45/46)
- **추론**: ~0.026M MACs, <10ms per frame on ESP32-S3

### 모델 훈련 환경

```
~/github/microWakeWord-Trainer-AppleSilicon/
├── .venv/                    # arm64 Python 3.11 + TF 2.16 + Metal
├── generated_samples/        # Edge-TTS 한국어 945개 WAV (16kHz mono)
├── generate_korean_samples.py  # Edge-TTS 샘플 생성 스크립트
├── train_openclaw_ko.sh      # 한국어 훈련 래퍼
├── trained_models/           # 훈련된 모델
└── micro-wake-word/          # microWakeWord 소스 (TaterTotterson fork)
```

### 훈련 파이프라인

1. **샘플 생성** (Edge-TTS — Piper에 한국어 없음)
   - 3 음성: SunHi(여), InJoon(남), Hyunsu(남 다국어)
   - 7 속도 × 3 피치 × 3 볼륨 × 5 텍스트변형 = 945개
   - `uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py`

2. **증강 데이터셋** (자동 다운로드)
   - MIT RIR (270 room impulse responses)
   - AudioSet (18,683 clips)
   - FMA xsmall (210 music clips)
   - WHAM (28,000 noise clips)
   - CHiME-Home (실패 — archive.org 불안정, 다른 3개로 충분)

3. **Feature 생성** — 40-feature spectrograms, SpecAugment, background noise 5-10dB SNR

4. **훈련** — 40,000 steps, Metal GPU (M1 Max), ~30분
   - MixConv: `[5], [7,11], [9,15], [23]` kernels, 64 pointwise filters
   - 최종: Accuracy 1.000, Recall 1.000, Precision 1.000, Loss 0.0002
   - FRR 0%, FAPH 0.19 at cutoff 0.07

5. **출력** — `stream_state_internal_quant.tflite` (62KB INT8)

### 재훈련

```bash
cd ~/github/microWakeWord-Trainer-AppleSilicon
source .venv/bin/activate

# 샘플 재생성 (필요시)
WAKE_WORD="오픈클로" uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py

# 훈련 (기존 샘플 + 데이터셋 재사용)
export TARGET_WORD="오픈클로" MWW_LANGUAGE="ko"
python scripts_macos/make_features.py
python scripts_macos/fetch_negatives.py
python scripts_macos/write_training_yaml.py
python -m microwakeword.model_train_eval \
  --training_config=training_parameters.yaml \
  --train 1 --restore_checkpoint 1 \
  --test_tflite_streaming_quantized 1 \
  --use_weights "best_weights" \
  mixednet \
  --pointwise_filters "64,64,64,64" \
  --repeat_in_block "1,1,1,1" \
  --mixconv_kernel_sizes "[5], [7,11], [9,15], [23]" \
  --residual_connection "0,0,0,0" \
  --first_conv_filters 32 \
  --first_conv_kernel_size 5 \
  --stride 2

# 모델 복사
cp trained_models/wakeword/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite \
   ~/github/AgentDeck/esp32/models/openclaw_wake_word.tflite
```

### 환경 의존성

- **Python**: 3.11 arm64 (`uv python install 3.11`)
- **TensorFlow**: 2.16.2 + tensorflow-metal 1.2.0 (Metal GPU)
- **ffmpeg**: arm64 (`/opt/homebrew/opt/ffmpeg@7`), symlink `/opt/homebrew/opt/ffmpeg` 필수
- **torchcodec**: ffmpeg@7 rpath 의존 — symlink 없으면 import 실패

### ESP32 통합 (BLOCKED — 마이크 하드웨어 없음)

현재 보유한 ESP32 보드 3종 모두 MEMS 마이크 미탑재:
- Round AMOLED (JC3636W518): 핀 정의만 있고 칩 미실장 — I2S PDM 테스트 결과 DC offset(~1310) 고정
- 86 Box (4848S040): 오디오 핀 없음
- IPS 3.5" (JC3248W535): 오디오 핀 없음

**준비된 코드 (마이크 달린 보드에서 즉시 사용 가능):**
- `esp32/src/audio/wake_word.cpp/h` — I2S PDM RX (ESP-IDF 5.x new API) + VAD + status reporting
- `esp32/models/openclaw_wake_word.tflite` — 훈련된 TFLite 모델 (62KB)
- TFLite Micro 추론은 미완성 — pioarduino GCC 14와 호환되는 라이브러리 필요

**재개 조건:**
- MEMS 마이크 내장 ESP32-S3 보드 구매 (예: ESP32-S3-BOX-3, INMP441 모듈 납땜)
- `BOARD_HAS_AUDIO=1` 빌드 플래그 + main.cpp에서 Audio::wakeWordInit/Start 호출 복원
- TFLite Micro: ESP-IDF 네이티브 빌드 또는 GCC 14 호환 라이브러리 포팅

### Porcupine vs microWakeWord

| | Porcupine (Mac) | microWakeWord (ESP32) |
|---|---|---|
| 플랫폼 | macOS arm64 | ESP32-S3 |
| 모델 | .ppn (Picovoice Console) | .tflite (자체 훈련) |
| 비용 | Picovoice 라이선스 | 무료 (오픈소스) |
| 한국어 | 지원 (커스텀 키워드) | TTS 합성 훈련 |
| 항상 켜짐 | 모니터 의존 | 독립 (ESP32 상시 전원) |
| 정확도 | 높음 (상용) | 높음 (TTS 훈련 한계 있음) |
