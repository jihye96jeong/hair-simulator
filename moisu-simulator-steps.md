# 실시간 모수 시뮬레이터 구현 STEP

에이전트에게는 STEP 하나씩 붙여넣는다. 각 STEP이 끝나면 완료 기준을 보고하고 멈춘다.

## 공통 규칙 (매 STEP 앞에 함께 붙여넣기)

```
너는 "실시간 모수 시뮬레이터"를 만드는 개발 에이전트다.

제품: 남자 30~50대가 카메라로 자기 얼굴 위에서 탈모 부위와 모수(부분/1천 모/2천 모)에 따른 머리 변화를 실시간으로 본다.
모델: Decart 실시간 API, lucy-2.5, WebRTC, 1280×720, 초당 $0.02, 연결 중에만 과금.

규칙
- 지금 STEP 범위만 구현한다. 다음 STEP 기능을 미리 만들지 않는다.
- DECART_API_KEY는 서버 환경변수에만 둔다. 브라우저 코드, 로그, 커밋에 넣지 않는다.
- 브라우저는 서버가 발급한 클라이언트 토큰으로만 Decart에 연결한다.
- 연결 시간은 비용이다. 연결은 필요한 순간에만 열고, 끝나면 바로 disconnect() 한다.
- realtime.set()은 상태 전체를 교체한다. prompt, image, enhance를 항상 한 묶음으로 보낸다.
- SDK 메서드나 옵션 이름이 확실하지 않으면 추측하지 말고 @decartai/sdk 문서나 타입을 확인한 뒤 보고한다.
- STEP이 끝나면 바꾼 파일, 실행 방법, 완료 기준별 확인 결과를 보고하고 멈춘다.

스택: Node 20, Express, 바닐라 HTML/JS (빌드 도구 없음), @decartai/sdk
```

---

## 1부. 기술 검증

목표는 하나다. lucy-2.5로 얼굴을 유지한 채 모수 차이를 보여줄 수 있는지 확인한다.

### STEP 01. 프로젝트 골격과 토큰 서버

```
STEP 01을 구현해줘.

할 일
- package.json 생성 ("type": "module"), express, @decartai/sdk, dotenv 설치
- .env.example에 DECART_API_KEY= 추가, .env는 .gitignore에 추가
- server.js 작성
  - public/ 정적 파일 제공
  - POST /token: decart.tokens.create()로 클라이언트 토큰을 만들어 { token } 반환
  - 토큰 발급 실패 시 500과 짧은 에러 메시지, 서버 로그에는 키를 찍지 않음
  - 포트 3000
- public/index.html은 "ok" 한 줄만 둔다
- README에 실행 방법 3줄

완료 기준
- npm start 후 http://localhost:3000 이 열린다
- curl -X POST localhost:3000/token 이 토큰을 돌려준다
- 저장소 어디에도 실제 API 키 문자열이 없다
```

### STEP 02. 에셋과 조합 설정

```
STEP 02를 구현해줘.

할 일
- public/assets/ 에 아래 3개 파일 자리를 만든다. 실제 이미지는 내가 넣는다.
  hairline_partial.webp, hairline_1k.webp, hairline_2k.webp
- 이미지가 없을 때 쓸 회색 플레이스홀더 3장을 16:9, 1280×720으로 생성해 둔다
- public/combos.js 작성 (ES module export)

const KEEP = "The hair stays attached to the scalp and moves with the person's head. Keep the person's face, eyes, eyebrows, skin, and identity unchanged.";

export const COMBOS = {
  partial: { label: "헤어라인 · 부분", image: "assets/hairline_partial.webp",
    prompt: "Replace the person's receding hairline with the short black hairline from the reference image, filling only the corners of the temples with natural-density hair. " + KEEP },
  "1k": { label: "헤어라인 · 1천 모", image: "assets/hairline_1k.webp",
    prompt: "Replace the person's receding hairline with the fuller short black hairline from the reference image, filling the temples with dense, evenly spaced hair. " + KEEP },
  "2k": { label: "헤어라인 · 2천 모", image: "assets/hairline_2k.webp",
    prompt: "Replace the person's receding hairline with the low, full short black hairline from the reference image, covering the whole front of the scalp with dense hair. " + KEEP },
};

- 같은 파일에 stateOf(key, mode, images) 함수
  - mode "ref": { prompt, image: images[key], enhance: true }
  - mode "text": { prompt에서 " from the reference image" 제거, enhance: true } (image 필드 없음)
- 각 prompt 길이가 750자 이하인지 확인하는 간단한 검사 스크립트 (npm run check:prompts)

완료 기준
- npm run check:prompts 가 3개 모두 통과
- 브라우저 콘솔에서 combos.js import 시 에러가 없다
```

### STEP 03. 카메라 연결과 조합 전환

```
STEP 03을 구현해줘.

할 일
- public/index.html, public/app.js 작성
- 화면: 출력 video 1개, 현재 조합 라벨(좌상단), "예상 이미지" 문구(좌하단, 항상 표시), 조합 버튼 3개, 연결 버튼, 끊기 버튼
- URL 파라미터
  - ?mode=ref|text (기본 ref)
  - ?anchor=off 이면 connect 시 queryParams: { self_anchor: "false" }
- 페이지 로드 시 에셋 3장을 미리 fetch해서 Blob으로 들고 있는다
- 연결 버튼을 누르면
  1) getUserMedia({ video: { facingMode: "user", width: 1280, height: 720 } })
  2) POST /token
  3) client.realtime.connect(stream, { model: models.realtime("lucy-2.5"), mirror: "auto", onRemoteStream, initialState })
     - initialState에는 현재 선택된 조합의 prompt와 image를 넣어 첫 프레임부터 결과가 나오게 한다
     - initialState의 정확한 필드 구조는 SDK 타입으로 확인하고 보고한다
- 조합 버튼: 연결 전에는 선택만 바꾸고, 연결 중이면 rt.set(stateOf(...)) 호출
- connectionChange 상태를 화면 구석에 표시, reconnecting 동안 조합 버튼 비활성화
- error 이벤트는 콘솔과 화면에 짧게 표시
- 끊기 버튼: rt.disconnect(), 카메라 트랙 stop

완료 기준
- 연결 후 첫 화면부터 선택한 조합이 적용된 영상이 나온다
- 연결을 끊지 않고 3개 조합을 오갈 수 있다
- ?mode=text, ?anchor=off 가 실제로 반영된다 (콘솔에 현재 모드 출력)
- 끊기 후 카메라 표시등이 꺼진다
```

### STEP 04. 120초 상한과 자동 종료

```
STEP 04를 구현해줘.

할 일
- CAP_SECONDS = 120
- generationTick 이벤트의 seconds로 남은 시간을 표시하고, CAP 이상이면 stop("cap")
- tick이 오지 않는 경우를 대비해 연결 시점부터 (CAP + 5)초 타이머로도 stop("cap")
- 탭이 숨겨지면(visibilitychange) stop("hidden"), pagehide에도 stop
- stop()은 여러 번 불려도 안전해야 한다 (중복 disconnect 없음)
- 재연결 시 generationTick이 0부터 다시 세는지 콘솔 로그로 확인할 수 있게 seconds와 연결 상태를 함께 로그
- 종료 시 콘솔에 { reason, billedSeconds, wallSeconds, switches, mode, anchor } 출력

완료 기준
- 아무것도 안 하고 두면 120초 근처에서 끊긴다
- 탭을 바꾸면 즉시 끊긴다
- 종료 로그가 한 번만 찍힌다
- 재연결 시 tick 동작을 보고서에 적는다
```

### STEP 05. 캡처 다운로드

```
STEP 05를 구현해줘.

할 일
- 캡처 버튼 추가 (연결 중에만 활성)
- 출력 video의 현재 프레임을 canvas로 그리고, 좌하단에 "예상 이미지" 문구를 같이 그린다
- PNG로 다운로드. 파일명: {mode}_{anchor|noanchor}_{comboKey}_{포즈}_{timestamp}.png
- 포즈는 캡처 버튼 옆 작은 선택(정면/좌회전/우회전/숙임)으로 고른다. 기본 정면
- 캡처해도 연결은 유지한다 (검증 단계에서는 여러 장을 찍어야 하므로)

완료 기준
- 캡처 파일이 화면과 같은 좌우 방향인지 확인하고 보고한다 (mirror: "auto" 영향)
- 파일명만 보고 조건을 구분할 수 있다
```

### STEP 06. 휴대폰 테스트 준비

```
STEP 06을 구현해줘.

할 일
- 모바일 세로 화면에서 video가 화면 폭에 맞고, 버튼이 한 손으로 눌리도록 CSS 정리
- 세로 방향일 때 getUserMedia를 width/height 대신 facingMode만으로 요청하는 분기
- README에 HTTPS 터널로 휴대폰에서 여는 방법 추가 (ngrok 또는 cloudflared 예시 1개)
- 화면에 현재 출력 해상도(videoWidth × videoHeight)를 작게 표시

완료 기준
- 휴대폰 전면 카메라로 연결, 전환, 캡처가 된다
- 출력이 9:16인지 16:9인지 보고한다
```

### STEP 07. 검증 판정 (에이전트 작업 아님)

에이전트에게 붙여넣지 않는다. 사람이 직접 한다.

1. 에셋 3장만 3명에게 보여주고 모수 순서를 맞히게 한다
2. ?mode=ref 로 부분 → 1천 → 2천 → 부분, 포즈별 캡처
3. ?mode=text 로 반복
4. 더 나은 쪽에 &anchor=off 로 반복, 2천 → 부분 전환 시 잔상 확인
5. 휴대폰으로 1회
6. 탈모 정도가 다른 1~2명으로 반복

판정

- 통과: 3개 조합 모두 같은 사람으로 보이고, 캡처만 보고 모수 순서를 맞힌다 → 2부 진행
- 애매: 얼굴은 유지되는데 모수 차이가 흐리다 → 에셋, 프롬프트 수정 후 재시험
- 실패: 모든 조건에서 얼굴이 바뀐다 → 2부 중단, 캡처 1장 편집 방식 검토

2부로 넘어갈 때 결정해서 공통 규칙에 추가할 것: mode(ref/text), anchor(on/off), 화면 방향

---

## 2부. 프로토타입

목표는 타깃 사용자가 시작부터 연락처 입력까지 한 번에 겪어보는 것이다.

### STEP 08. 사용자 흐름 화면

```
STEP 08을 구현해줘. 1부 판정 결과: mode=___, anchor=___, 방향=___ (이 값으로 고정)

할 일
- 테스트용 버튼과 URL 파라미터 제거, 판정 결과 값으로 고정
- 화면을 단계로 나눈다 (한 페이지 안에서 상태로 전환)
  1) 시작: 제목, "예상 이미지이며 수술 결과를 보장하지 않습니다" 고지, 시작 버튼
  2) 선택: 부위(헤어라인만 활성), 모수 3개
  3) 준비: 카메라 권한 요청, 로컬 미리보기 위에 얼굴 정면 가이드 프레임. 아직 연결하지 않음
  4) 체험: "지금부터 최대 2분" 표시 후 연결, 남은 시간 막대, 조합 전환, "이 결과 저장" / "병원 소개 받기" 버튼
  5) 시간 종료: "시간이 끝났어요" + 다시 하기
- 모바일 세로 화면 우선 디자인. 큰 글씨, 단색 배경, 장식 최소화
- 3)까지는 Decart 연결이 일어나지 않아야 한다

완료 기준
- 체험 단계 진입 전까지 /token 호출이 없다 (네트워크 탭으로 확인)
- 한 번의 연결 안에서 조합 전환이 된다
- 결과 화면 동안 조합 라벨과 "예상 이미지" 문구가 계속 보인다
```

### STEP 09. 캡처 후 종료와 연락처 폼

```
STEP 09를 구현해줘.

할 일
- "이 결과 저장" 또는 "병원 소개 받기"를 누르면
  1) 출력 프레임 1장 캡처 ("예상 이미지" 문구 포함)
  2) 즉시 stop("capture")
  3) 멈춘 캡처 이미지 위에 폼 표시
- 폼 항목: 이름, 휴대폰, 지역(시/도 선택), 개인정보 수집·이용 동의(필수)
- "병원 소개 받기"로 들어온 경우 제3자 제공 동의 체크박스를 추가로 표시(필수)
- 휴대폰 형식 검증, 하이픈 없이 숫자만 저장
- 동의 전에는 제출 버튼 비활성, 캡처 이미지는 브라우저 메모리에만 있음
- 폼을 닫으면 캡처 이미지를 버린다
- 제출은 STEP 10에서 연결한다. 지금은 콘솔에 payload만 출력

완료 기준
- 캡처 버튼을 누른 순간 연결이 끊긴다 (종료 로그 reason=capture)
- 폼 입력 중 과금 시간이 늘지 않는다
- 동의 없이 제출할 수 없다
```

### STEP 10. 리드 생성과 이미지 저장

```
STEP 10을 구현해줘.

할 일
- POST /leads 추가 (server.js)
  - body: name, phone, region, area, density, action(save|referral), consentAt, thirdPartyConsentAt?, image(base64 webp)
  - 필수 동의가 없으면 400
  - 리드 생성과 중복 제출 처리를 유지한다
  - 이미지는 구글 드라이브 비공개 폴더에 저장한다
- .env.example에 이미지 저장용 환경변수 추가, README에 드라이브 준비 방법
- 클라이언트 폼 제출을 /leads로 연결, 성공 시 완료 화면

완료 기준
- 제출하면 리드 생성 요청이 처리되고, 이미지가 비공개 폴더에 저장된다
- 동의 없는 요청은 서버에서도 거절된다
- 서비스 계정 키가 저장소에 없다
```

### STEP 11. 비용 보호와 기록

```
STEP 11을 구현해줘.

할 일
- /token에 IP당 하루 발급 횟수 제한 (메모리 기반, 기본 3회, 환경변수로 조정)
- 하루 전체 발급 상한 (환경변수, 넘으면 503과 "잠시 후 다시" 화면)
- 세션 종료 시 navigator.sendBeacon으로 POST /session-end 전송
  { reason, billedSeconds, wallSeconds, switches, combo, captured }
- /session-end의 입력 검증과 중복 종료 처리를 유지한다

완료 기준
- 같은 IP로 4번째 연결 시도가 거절된다
- 탭을 닫으면 종료 요청이 서버에 전달된다
```

---

## 2부 이후 (지금 구현하지 않음)

- 정수리 조합: 고개 숙임 안내와 함께 별도 검증 후 추가
- 이미지 보관 기간 자동 삭제
- 병원 소개 구조 법률 검토 후 실제 전달
