# D200H Display Rendering — 이어서 작업할 프롬프트

아래를 그대로 복사해서 사용하세요.

---

ULANZI D200H (SigmaStar SSD210, FlythingsOS V2.1) 기기에 커스텀 화면을 렌더링해야 한다.

## 상황
- fbdev (`/dev/fb0`) mmap과 write는 화면에 전혀 반영 안 됨 (ioctl 전부 성공하지만 화면 변화 없음)
- MI_DISP API (`MI_SYS_ChnInputPortGetBuf/PutBuf`)도 ret=0 성공이지만 화면 변화 없음
- zkgui (기기의 기본 UI 앱)가 실행 중이면 화면 정상 — zkgui는 `libnanovg.so` + `MI_GFX` 하드웨어 2D 가속으로 렌더링
- zkgui를 죽이면 화면이 검게 변함

## 기기 스펙
- SoC: SSD210 (dual Cortex-A7), 33MB RAM, glibc 2.30
- LCD: nv3052c 540×960 TTL 6-bit
- ADB 접속 가능 (USB sysfs chmod 444 잠금 필요)
- 쉘: busybox 극도 최소 (grep/sleep/head 없음), awk만 가용

## 핵심 질문
zkgui가 화면에 그릴 때 실제 어떤 MI API 호출 경로를 사용하는가? 그리고 우리 C 프로그램에서 같은 경로로 픽셀을 그리려면 어떻게 해야 하는가?

## 시도해볼 접근법 (우선순위순)
1. **MI_GFX 직접 사용**: `MI_GFX_Open()` → `MI_GFX_QuickFill()` 또는 `MI_GFX_BitBlit()`로 DISP 출력 서피스에 직접 그리기
2. **zkgui 프로세스의 mmap 영역 공유**: `/proc/{zkgui_pid}/maps`에서 MI 프레임버퍼 물리주소를 찾아 같은 주소를 mmap
3. **zkdisplay 역어셈블**: `objdump -d /tmp/zkdisplay`로 정확한 MI 초기화 시퀀스 복제
4. **DISP VideoLayer z-order 변경**: fbdev 레이어를 최상위로 올리기
5. **FlythingsOS 소켓 프로토콜**: `/dev/socket/zkdisp` UNIX 소켓으로 zkdisplay와 통신

## 참조 파일
- `zkswe/DISPLAY_RESEARCH.md` — 전체 조사 결과 (시도한 것, 실패한 것, MI SDK 구조체)
- `zkswe/agent/src/fb_test.c` — 최신 테스트 코드 (MI_DISP API dlopen 방식)
- `zkswe/agent/src/mi_render.c` — MI 렌더러 초안
- 기기 라이브러리 pull: `adb -s 0123456789ABCDEF shell "cp /lib/libmi_*.so /tmp/" && adb pull /tmp/libmi_*.so`
- MI SDK 헤더: https://github.com/steward-fu/nds/blob/master/inc/mini/ (SSD202D, 동일 계열)
- FlythingsOS 샘플: https://github.com/loop0728/zkgui_sample

## 빌드 방법
```bash
# 동적 빌드 (MI dlopen 사용 시)
zig cc -target arm-linux-gnueabihf.2.30 -O2 -std=c99 src/fb_test.c -o fb-test -ldl -lc

# 정적 빌드 (GPIO/일반 용도)
zig cc -target arm-linux-musleabihf -O2 -std=c99 -static src/main.c ... -o agentdeck-d200h -lc -lm

# 배포
adb -s 0123456789ABCDEF push fb-test /tmp/fb-test
adb shell "chmod +x /tmp/fb-test; LD_LIBRARY_PATH=/lib /tmp/fb-test"
```

## 성공 기준
기기 화면에 우리가 지정한 색상(예: 빨간색 전체 채우기)이 보이면 성공. 이후 14키 대시보드 렌더링으로 확장.
