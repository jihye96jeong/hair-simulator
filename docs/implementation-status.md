# 구현 및 검증 기록

기준 문서: `moisu-simulator-steps.md`, `prd-hair-simulator.md`. 전체 구현 요청에 따라 STEP 01~11을 구현했습니다. STEP 07은 자동 판정하지 않았습니다. PRD의 6개 조합 구상 중 정수리는 단계 문서의 명시적 이후 범위에 맞춰 준비 중으로 남겼습니다. 배포·실제 병원 전달·보관 기간 자동 삭제는 수행하지 않았습니다.

## 구현 파일

| 파일 | 역할 |
| --- | --- |
| `package.json`, `package-lock.json`, `.env.example`, `.gitignore` | 실행, 의존성, 환경변수, 키·산출물 제외 |
| `server.js`, `lib/config.js`, `lib/quota.js` | 정적 앱, 토큰, 일별 발급 상한, 리드·세션 API |
| `lib/google-store.js`, `lib/validation.js` | 비공개 Drive 이미지 저장, 동의·입력 검증 |
| `lib/browser-vendor.js` | SDK·의존성을 CDN·빌드 없이 제공 |
| `lib/assets.js`, `scripts/create-placeholders.js`, `public/assets/*` | 회색 WebP 3장·예비 이미지, 실제 에셋 감지 |
| `public/index.html`, `styles.css`, `app.js` | 모바일 사용자 흐름, `/lab` 검증 흐름 |
| `public/combos.js`, `shared.js`, `session.js`, `capture.js` | 전체 상태 전환, 세션 종료·시간 제한, 캡처 |
| `scripts/check-prompts.js`, `scripts/setup-google.js` | 프롬프트 검사, Drive 폴더 확인 |
| `tests/*.test.js`, `tests/browser.test.mjs` | HTTP·세션·Google 대역·Chrome 검증 |
| `README.md` | 실행, Google 준비, HTTPS 터널, 실제 검증 방법 |

## 완료 기준별 결과

| STEP | 자동·로컬 확인 | 실제 환경에서 남은 확인 |
| --- | --- | --- |
| 01 | HTTP 화면·SDK 제공, 토큰 응답 구조·실패 500·키 비노출 | 실제 DECART_API_KEY로 토큰 발급 |
| 02 | WebP 1280×720, 프롬프트 302/294/300자, 모듈 import | 얼굴 없는 머리 참고 이미지 3장 교체 |
| 03 | SDK 타입, 중첩 initialState, 동일 연결 set 전환, reconnecting 비활성화, ref/text·anchor, track 종료 | 실제 첫 프레임·얼굴 유지·전환 결과 |
| 04 | tick 120초·보조 125초 종료, hidden/pagehide, 중복 로그·disconnect 방지, tick 재설정 누적 | Decart 실제 재연결 tick 규칙을 콘솔 로그로 기록 |
| 05 | PNG 조건 파일명, 예상 이미지·조합 라벨 삽입, lab 캡처 후 연결 유지. 빨강 좌·파랑 우 출력과 저장 픽셀 방향 일치 | 실제 전면 카메라 mirror:auto 방향 |
| 06 | 390×844 화면 가로 넘침 없음, 세로 카메라 요청, 출력 해상도. 대역은 1280×720(16:9) | 휴대폰 연결·전환·캡처, 실제 출력 비율 |
| 07 | 사람 검증 순서 유지 | 3명 모수 순서 판별, 포즈·anchor·탈모 정도별 비교. 통과 판정 미수행 |
| 08 | 준비까지 토큰 0회, 체험 시 1회. 일반 URL 조건 무시, 예상 이미지·조합 표시 | STEP 07 결과로 mode/anchor/방향 확정 |
| 09 | 캡처 즉시 reason=capture, 폼 중 연결 없음, 양쪽 동의, 전화번호 숫자 저장, 폼 닫기 메모리 폐기 | 운영자·보관 기간·제공받는 자 설정 |
| 10 | Drive 업로드, 공개 폴더 거절, 업로드 재시도, 서버 동의 검증 | 실제 서비스 계정·공유 드라이브 저장 |
| 11 | 같은 IP 4번째 429, 전체 상한 503, 한국 자정 초기화, 실제 Chrome 탭 닫기 beacon, 중복 종료 처리. 종료 기록의 외부 저장 없음 | 실기기 탭 종료 요청 |

`mirror:auto`는 입력을 SDK에서 뒤집습니다. 출력은 CSS/canvas에서 추가로 뒤집지 않습니다. 자동 테스트의 좌우 확인은 렌더링·캡처 경로에 대한 확인이며 실제 모델 얼굴 결과 확인은 아닙니다.

새 체험은 billedSeconds=0에서 시작합니다. 모의 재연결의 70→0→50 tick은 120으로 합산해 종료했습니다. 실제 공급자의 재연결 tick 규칙은 API 키가 없어 확인하지 못했습니다.

Google Drive 연동과 유료 연결은 자격증명 없이 대역으로 검증했습니다. 실제 토큰·영상·Drive 업로드·휴대폰 실기기·사람의 모수 판별은 완료로 보고하지 않습니다.

## 테스트 실행

실행 환경은 Node 24.2.0이며, 의존성의 Node 20 지원 조건에 맞춰 최소 버전은 20.9.0입니다. 이미지 저장은 Drive 전용 패키지 `@googleapis/drive` 22를 사용합니다. 프롬프트·HTTP·세션·Drive·Chrome 검증을 아래 명령으로 실행합니다.

최종 검증: Node·Chrome 테스트 총 21개, 프롬프트 검사 3개, 기존 Python 테스트 1개, JavaScript 구문 검사와 Python Ruff 검사 통과. 지정한 외부 저장용 환경변수 없이 CLI 서버가 시작되고 API·리드 생성·이미지 업로드·종료 요청 흐름이 유지되는 것을 확인했습니다.

```bash
npm run check:prompts
npm test
npm run test:browser
```

브라우저 스크린샷은 `test-results/`에 생성되며 저장소 제외 대상입니다. 기존 Python 테스트도 변경 없이 실행할 수 있습니다.
