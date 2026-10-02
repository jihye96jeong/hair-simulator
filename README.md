# 모수 — 실시간 헤어 시뮬레이터

`moisu-simulator-steps.md` STEP 01~11과 `prd-hair-simulator.md`를 반영한 Node 20.9+ / Express / 바닐라 HTML·JS 앱입니다. 앱 빌드 과정이나 CDN 없이 설치된 Decart SDK 0.2.3을 네이티브 ES 모듈로 제공합니다. 이미지 저장은 Node 20을 지원하는 Drive 전용 패키지 `@googleapis/drive` 22를 사용합니다. 기존 Python 예제는 그대로 두었으며 시뮬레이터 실행에는 사용하지 않습니다.

## 실행

```bash
npm ci
cp .env.example .env # .env에 서버 전용 키와 Drive 이미지 저장 설정을 입력
npm start
```

일반 화면: <http://localhost:3000>. 키가 없어도 화면은 열리지만 실제 체험 연결은 실패 메시지를 표시합니다. API 키를 클라이언트에 직접 넣지 마세요.

## 구현 범위와 기본값

- 첫 화면에서 부위·모수 선택 → 로컬 카메라 준비 → 최대 2분 체험 → 캡처 후 연락처·동의 → 완료·PNG 다운로드.
- 헤어라인과 정수리의 부분 / 1천 모 / 2천 모, 총 6개 조합을 한 연결에서 전환합니다. 부위를 바꾸면 같은 모수를 유지하고, 해당 이미지가 없으면 사용 가능한 모수로 전환합니다.
- 정수리는 카메라 준비 및 실시간 화면에서 고개 숙임을 안내합니다. 캡처 라벨·리드의 부위와 모수·다운로드 파일명에도 정수리가 반영됩니다.
- 기본 설정은 `SIMULATOR_MODE=ref`, `SIMULATOR_ANCHOR=on`, 모바일 세로 UI입니다. 모델은 `lucy-2.5`, 표준 속도, 720p입니다. 실제 출력 비율은 원격 영상의 해상도를 그대로 표시합니다.
- 일반 화면의 URL 파라미터는 조건을 바꾸지 않습니다. STEP 07 사람 검증이 끝나면 환경변수로 확정값을 고정하세요.
- 캡처가 성공하면 폼을 표시하기 **전에** 연결과 카메라를 종료합니다. 개인정보는 동의 후 제출 시에만 전송합니다. 폼을 닫으면 캡처를 메모리에서 버립니다.
- 병원 소개 요청은 리드로 기록합니다. 병원으로 자동 전달하거나 매칭하지 않습니다.

## 탭: 모수 시뮬레이션 / 레퍼런스 헤어

상단 탭으로 두 체험을 분리합니다. 기본 탭은 **모수 시뮬레이션**입니다.

### 모수 시뮬레이션
기존 6개 조합·리드 저장·병원 소개 흐름입니다.

### 레퍼런스 헤어
원하는 헤어스타일 사진을 업로드해, 카메라 속 얼굴·정체성은 유지한 채 헤어만 바꿔 봅니다.

1. JPG/PNG/WebP(최대 8MB) 선택 또는 드래그앤드롭
2. 원본과 전처리(얼굴 보호) 미리보기 확인. 자동 얼굴 감지가 없거나 실패하면 수동 크롭·얼굴 위치를 확정
3. 카메라 준비 → 헤어 적용 시작 (`lucy-2.5`, anchor 기본 on)
4. 같은 연결에서 다른 레퍼런스로 교체 가능 (`rt.set`, 120초 타이머 유지)
5. 결과 캡처 후 PNG 다운로드. 캡처 시 세션·카메라 종료

레퍼런스 탭에는 모수 선택·병원 소개 폼이 없습니다. 업로드 이미지는 브라우저 메모리에서만 전처리하며 서버에 영구 저장하지 않습니다. 얼굴 무변형을 100% 보장한다고 표시하지 않습니다.

수동 검증(실제 API 키 필요): 레퍼런스와 사용자 얼굴이 다른 경우, 짧은/긴 머리·앞머리·가르마·컬, 정면/좌우/숙임/표정 변화, 얼굴·피부 변화 여부, 레퍼런스 얼굴·배경 전이, 헤어 경계 안정성.

## 머리 참고 이미지

현재 다음 여섯 PNG 원본을 부위·모수별 참고 이미지로 사용합니다.

```text
public/assets/01_hairline_partial.png  # 헤어라인 부분
public/assets/02_hairline_1000.png     # 헤어라인 1천 모
public/assets/03_hairline_2000.png     # 헤어라인 2천 모
public/assets/04_crown_partial.png    # 정수리 부분
public/assets/05_crown_1000.png       # 정수리 1천 모
public/assets/06_crown_2000.png       # 정수리 2천 모
```

참고 이미지는 1254×1254이며 SDK에 원본 Blob으로 전달합니다. 파일명 변경 시 `public/combos.js`의 경로도 수정하세요. 기존 헤어라인 조합 키는 `partial`, `1k`, `2k`, 정수리 조합 키는 `crown_partial`, `crown_1k`, `crown_2k`입니다. 리드 API에는 각각 `area: hairline|crown`, `density: partial|1k|2k`로 전송합니다.

일반 `ref` 화면은 누락되거나 플레이스홀더인 조합을 비활성화하며, 새로고침하면 같은 경로의 이미지 교체를 감지합니다. `npm run assets:placeholders`는 검증 화면의 누락 시 예비 이미지(`placeholder_*.webp`, 1280×720)만 생성하며 실제 참고 이미지를 생성하거나 덮어쓰지 않습니다.

## 기술 검증 화면

```text
http://localhost:3000/lab?mode=ref
http://localhost:3000/lab?mode=text
http://localhost:3000/lab?mode=text&anchor=off
```

검증 화면도 준비 단계까지는 Decart를 연결하지 않습니다. 체험 중 포즈를 고르고 PNG를 여러 장 내려받을 수 있으며, 캡처만으로 연결이 끊기지 않습니다. 120초 상한과 숨김·탭 종료 처리는 동일합니다. `ENABLE_LAB=false`로 검증 경로를 닫을 수 있습니다.

- 파일명: `{mode}_{anchor|noanchor}_{combo}_{정면|좌회전|우회전|숙임}_{ISO시각}.png`
- `mirror: "auto"`는 전면 카메라로 보고되는 입력을 SDK에서 뒤집습니다. 출력 video에는 CSS 반전을 적용하지 않고 동일한 원격 픽셀을 canvas에 그려 화면과 파일의 좌우를 일치시킵니다. 로컬 준비 미리보기만 CSS 반전합니다.
- 세로 화면은 `getUserMedia`에 `facingMode: "user"`와 모델 ideal width/height/fps를 요청합니다. 가로 화면도 동일합니다. 모델의 기본 출력은 1280×720(16:9)이고 실제 해상도는 화면 오른쪽 아래에서 확인하세요.
- 콘솔 `generationTick`에 원래 `seconds`, 누적 `billedSeconds`, 연결 상태를 표시합니다. 재연결에서 seconds가 줄면 누적값을 유지하고 `generationTick reset`을 출력합니다. 새 체험은 0부터 시작합니다.
- 종료 시 `{ reason, billedSeconds, wallSeconds, switches, mode, anchor, combo, captured }` 로그가 한 번 출력됩니다.

SDK 타입으로 확인한 첫 프레임 설정과 조합 전환 구조는 다릅니다.

```js
// connect()의 initialState
const initialState = { prompt: { text: prompt, enhance: true }, image: imageBlob };
// set()은 전체 상태를 교체. text 모드에는 image 필드 없음.
await rt.set({ prompt, image: imageBlob, enhance: true });
// anchor=off
const queryParams = { self_anchor: "false" };
```

설치된 `node_modules/@decartai/sdk/dist/realtime/client.d.ts`, `types.d.ts`, `methods.d.ts`, `tokens/client.d.ts`와 [공식 Realtime 문서](https://docs.platform.decart.ai/sdks/javascript-realtime), [클라이언트 토큰 문서](https://docs.platform.decart.ai/getting-started/client-tokens)를 확인했습니다. `/token`의 `{ token }`에는 `tokens.create()` 결과의 임시 `apiKey`를 담습니다.

## Google Drive 이미지 저장 준비

1. Google Cloud에서 **Google Drive API**를 활성화하고 서비스 계정을 만듭니다.
2. 서비스 계정 키 JSON은 저장소 밖에 두고 `GOOGLE_APPLICATION_CREDENTIALS` 환경변수에 파일 경로를 지정합니다.
3. **Google Workspace 공유 드라이브**에 비공개 이미지 폴더를 만듭니다. 서비스 계정에 파일 업로드 권한을 주고 폴더 ID를 `GOOGLE_DRIVE_FOLDER_ID`에 넣습니다. 일반 내 드라이브의 공유 폴더와 공유 드라이브는 다릅니다. [서비스 계정에는 소유 파일 저장 할당량이 없으므로 공유 드라이브가 필요합니다.](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)
4. 폴더를 링크 전체 공개 또는 도메인 전체 공개로 공유하지 않습니다. 서버는 저장 전 폴더 권한을 확인하며 공개 권한이 있으면 거절합니다. 이미지에 링크 공개 권한을 생성하지 않습니다.
5. `.env`의 운영자, 개인정보 보관 기간, 제3자 제공받는 자를 실제 값으로 설정합니다. 보관 기간 자동 삭제는 이번 범위에 없으므로 설정한 기간에 맞는 별도 운영 처리가 필요합니다.
6. `npm run setup:google`으로 공유 드라이브 폴더를 확인합니다. 앱도 첫 이미지 저장 전에 같은 검사를 수행합니다.

리드 폼 데이터는 서버 메모리 세션으로만 처리하고, 캡처 이미지는 비공개 Drive에 WebP(`{sessionId}.webp`)로 저장합니다. 개인정보·이미지·키는 로그에 출력하지 않습니다.

## 비용 보호와 제한

- `/token`: IP당 하루 기본 3회(`TOKEN_DAILY_IP_LIMIT`), 전체 하루 기본 100회(`TOKEN_DAILY_TOTAL_LIMIT`). 동일 IP 4번째는 429, 전체 상한은 503과 재시도 안내입니다. 동시 요청도 예약 카운터로 제한하고 토큰 발급 실패는 횟수를 복구합니다.
- 토큰: 300초 유효, `lucy-2.5`와 `APP_ORIGIN` 제한, `constraints.realtime.maxSessionDuration=120`. 토큰 만료만으로 기존 연결은 종료되지 않으므로 클라이언트 종료와 서버 제약을 함께 적용합니다.
- 클라이언트: tick 누적 120초 종료, SDK 연결 시작부터 125초 보조 타이머, `visibilitychange`/`pagehide` 종료, 중복 disconnect·종료 로그 방지.
- 현재 SDK connect에는 AbortSignal이 없습니다. 연결 완료 전에 떠나면 카메라는 즉시 중지하고 늦게 반환되는 SDK 연결을 즉시 disconnect합니다. 대기 구간에도 서버 세션 상한이 적용됩니다.
- 종료 기록은 `navigator.sendBeacon`으로 보내고 큐 등록 실패 시 `fetch(..., {keepalive:true})`로 재시도합니다. 실제 Chrome 탭 닫기 전송을 확인했지만 오프라인·브라우저 강제 종료에서는 전송을 보장하지 않습니다.
- `/session-end`는 입력 검증과 중복 종료 처리를 유지하며 외부 저장소에는 전송하지 않습니다.
- 횟수와 중복 저장 상태는 단일 서버 메모리 기준입니다. 재시작 시 초기화되고 여러 인스턴스가 카운터를 공유하지 않습니다. 토큰 발급 제한은 SDK 토큰을 일회용으로 만들지는 않습니다.
- Google Drive 저장 실패 시 폼을 유지합니다. 동일 sessionId로 재시도하면 진행 중인 업로드를 재사용합니다.

프록시 사용 시에만 `TRUST_PROXY`에 신뢰할 hop 수를 지정하세요. 직접 접속에서는 기본 0을 유지합니다. POST API는 다른 웹 출처 요청을 거절하고 저장 요청에는 서버가 발급한 sessionId가 필요합니다.

## 휴대폰 HTTPS 테스트

```bash
# 서버 실행 후 별도 터미널
ngrok http 3000
```

ngrok의 **HTTPS origin**을 `.env`의 `APP_ORIGIN`에 넣고 서버를 다시 실행한 뒤 휴대폰에서 엽니다. 경로·슬래시 없이 origin만 설정하세요. ngrok 프록시가 한 hop인 구성은 `TRUST_PROXY=1`로 접속자별 횟수를 구분합니다. 휴대폰 카메라는 HTTPS가 필요합니다.

## 검증

```bash
npm run check:prompts
npm test
npm run test:browser
```

브라우저 테스트는 macOS의 설치된 Google Chrome, 다른 환경에서는 Playwright Chromium을 사용합니다. `CHROME_BIN`으로 실행 파일 경로를 지정하거나 `npx playwright install chromium`으로 설치하세요. 유료 Decart 연결과 실제 Google 쓰기는 대역으로 바꾸고, 설치된 SDK·LiveKit·재시도 라이브러리의 실제 브라우저 import도 확인합니다.

실제 토큰 확인은 `curl -X POST http://localhost:3000/token`으로 합니다. 응답의 임시 토큰도 공개 로그에 붙여 넣지 마세요. 실제 키가 없으면 500이며 외부 서비스 검증 결과로 간주하지 않습니다.

단계별 결과와 남은 사람 검증: [구현 검증 기록](docs/implementation-status.md).
