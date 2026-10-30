# 확장 구현·검증 메모

## GUI 구현 — 2026-10-29 / 0.2.0

[기능 명세의 GUI 설계](<문제 해결 기록 블로그 서비스 — 1~6주차 기능 명세.md#vs-code-확장-gui-상세>)를 구현했다. Activity Bar에 현재 기록·세션·연결/동기화 뷰를 제공하며, 세션 상세와 설정·연결은 편집기 탭에서 연다. 기존 명령 10개와 설정 6개 모두 GUI 진입점을 제공한다. 설치·사용 순서는 [확장 README](../apps/extension/README.md)를 따른다.

### 적용한 UI/UX 스킬과 디자인

웹에서 Anthropic의 [frontend-design SKILL.md](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)를 찾아 읽고 적용했다. 별도 전역 설치나 실행 스크립트 없이 설계·구현·화면 검토 지침을 사용했다. VS Code 확장이라는 제품 맥락에 맞춰 테마 토큰, 조밀한 사건 목록, 선택한 사건의 근거 확인을 중심으로 구성했다. 스킬 원문이나 외부 자산은 VSIX에 포함하지 않는다.

- 색: VS Code 테마 토큰을 우선한다. 기본 어두운 테마 검토 기준은 editor `#1F1F1F`, sidebar `#181818`, foreground `#CCCCCC`, secondary `#9D9D9D`, focus `#0078D4`, error `#F14C4C`. 밝은·고대비 테마에서는 호스트 토큰을 따른다.
- 글꼴: 본문은 VS Code UI 글꼴, 코드·출력만 editor 글꼴. 제목 24/16px, 본문은 사용자 기본 글자 크기, 왼쪽 정렬.
- 배치: 사이드바는 제어·짧은 입력, 세션 탭은 사건 목록과 상세의 두 열. 좁은 탭은 한 열로 전환하고 사건 선택 시 상세로 이동한다. 320px 이하 버튼은 두 열과 전체 폭으로 재배치한다.
- 검토: 실제 VS Code와 브라우저 캡처를 보고 좁은 사이드바의 버튼 줄바꿈과 사건 상세 탐색을 수정했다. 불필요한 이미지·장식·애니메이션은 추가하지 않았다.

### 구현 경계

- `src/ui/controller.ts`: View/Tree/Panel 수명, 같은 세션 탭 재사용, 메시지 전달, 화면 상태 복원. 숨겼던 webview가 다시 준비되면 상태를 재전송한다.
- `src/ui/protocol.ts`: 허용 동작, 메시지 크기·형식, 저장할 화면 상태, 설정 값 검증.
- `media/app.js`, `app.css`: CSP가 적용된 로컬 자산, 테마·키보드 탭·폼·피드백. 수집한 코드와 출력은 이스케이프한 텍스트로 렌더링한다.
- `extension.ts`: GUI와 명령의 공통 동작, 기록/인증/파일/API 접근. 토큰은 webview에 보내지 않는다. 설정은 기존 configuration을 사용한다.
- 세션 목록은 사건 본문을 복제하지 않는 메타데이터 조회를 사용하고 60개씩 표시한다. 코드·출력은 선택한 사건만 읽는다. 읽기 전용 코드와 diff는 기본 에디터를 사용한다.
- 입력 중 메모·대상 파일·필터·탭은 workspace별 `context.storageUri/gui-state.json`에 원자적으로 저장한다. 기록 저널과 분리하며 창 재시작 시 복원한다. 열린 폴더가 없으면 globalStorage의 `empty-workspace` 아래를 사용한다.
- 요약은 탭이 보이는 동안 15초 간격으로 기존 세션 API에서 갱신하고 로컬 캐시를 제공한다. 유료 생성 요청은 보내지 않는다. 웹 이동은 `/?session=<id>&file=<id>`를 사용하고 로그인 복귀 후에도 대상을 복원한다. 데이터 관리는 `/?view=settings`로 연다.

### 새 GUI 검증

- 확장 단위/통합 22개: 기존 기록·동기화 18개, 메시지·설정 검증 3개, 큰 저널 조회 1개.
- 10,000개 합성 사건의 메타데이터 조회: 4.9ms, 관측 heap 증가 2.76MiB, 60개 목록 전송 11,503바이트. WSL2/Node 테스트의 단일 관측이며 전체 화면 p95를 뜻하지 않는다.
- Playwright webview 4개: 메모 대상 고정·실패 시 입력 보존, HTML 출력 이스케이프·키보드 탭, 설정 충돌, 260px 사이드바.
- 실제 Linux VS Code 1.144.0/Xvfb, 두 프로세스 총 19개 체크: GUI 시작·중지, 실제 C++/Python 실행, 메모·북마크 대상 유지, 사건 필터·코드 열기, 탭 닫기와 재시작 후 입력 복원, 설정 저장, 저널 연속성.
- 확장·웹 TypeScript 검사, 확장 빌드와 웹 프로덕션 빌드 통과. Next의 TypeScript CLI 조회는 샌드박스 밖에서 검증했다. VSIX 0.2.0에 JS/CSS/아이콘·UI host 모듈이 포함되는지 확인했다.
- 웹 연결 Playwright 2개: 로그인 후 선택한 세션·파일 복원, 접근할 수 없는 세션 안내. 격리된 로컬 API에서 수행했고 AI 작업을 생성하지 않았다.
- 실제 host 아티팩트 위치는 `/tmp/autoblogger-vscode-tools/latest-artifacts.txt`에 기록한다. 브라우저 화면 캡처는 `.data/screenshots/extension-*.png`다.

재현: `pnpm --filter autoblogger-recorder test`, `pnpm exec playwright test --config tests/extension-ui/playwright.config.ts`, `bash tests/vscode-host/run-linux.sh`. 웹 서버 실행 후 `pnpm exec playwright test tests/e2e/extension-link.spec.ts`; 별도 포트는 `GUI_API_URL`, `GUI_WEB_URL`로 지정한다.

Windows 클라이언트 → Remote WSL의 실제 URI 로그인 왕복, 사람의 스크린 리더 검증·베타 평가는 별도 확인 범위다. Linux host의 GUI 테스트로 이 항목까지 완료했다고 간주하지 않는다. 아래 기존 검증 기록은 최초 명령 중심 구현의 이력이다.

## 담당 파일
- apps/extension/src/extension.ts: VS Code 명령·이벤트·상태·PKCE URI 인증·SecretStorage
- recorder.ts: 파일별 스냅샷·편집·메모·컴파일/실행 연결
- parser.ts: 보수적인 shell 파싱, 지원하지 않는 복합 명령은 기록하지 않음
- journal.ts: fsync append-only JSONL, atomic manifest/ACK, 재시작 복구
- safety.ts: 1MB·바이너리·프로젝트 경계·심볼릭 링크·비밀값 필터·출력 상한
- sync.ts: 인증된 NestJS 요청, 사용자/API 귀속, 이벤트 수신 범위와 누락 재전송

## 계약
- extension ID: molla11.autoblogger-recorder. 로컬 웹 기본 주소 http://localhost:3000, API http://127.0.0.1:4000/api.
- /connect?challenge=...&state=...&callback=...&name=... 로 브라우저를 연다. callback에 code와 원래 state를 전달해야 한다.
- POST /devices/exchange에는 code, verifier를 전송한다. 토큰은 URI에 넣지 않는다.
- fileId는 세션 ID+상대 경로 SHA256 앞 32자리. snapshotId는 해당 snapshot 이벤트 ID.
- 동일 session ID의 생성 재요청은 멱등이어야 한다. 이벤트 순번은 세션별 1부터.
- 웹의 project.excluded 또는 session.recording=false/endedAt을 동기화 때 읽고 기록 중지. project.excludePatterns는 추가 적용.

## 검증
- parser.test.ts: C/C++/Python, 인용 경로, 리다이렉션, &&, 지원하지 않는 셸 조합, 종료 상태
- safety.test.ts: UTF-8 출력 256KB 상한·앞뒤 유지, 비밀값 가림, 경계·파일 크기·심볼릭 링크
- journal.test.ts: 병렬 순번, 부분 ACK/재시작/누락, 미완성 JSONL 복구, 컴파일 이후 편집·실패에서 올바른 실행 버전 연결
- 확장 host가 실행 도중 종료되면 pending-runs.json에서 복구하고 종료 상태를 unknown으로 기록한다. 완료 이벤트의 executionId로 중복 복구를 막는다.
- sync.test.ts: HTTP 응답 유실 후 동일 ID 재전송·멱등 확인, 로컬 저널 재시작 후 동기화 복원
- 2026-10-29: 단위/통합 성격의 Node 테스트 18개 통과, TypeScript 검사 통과, VSIX 빌드 성공.
- VS Code 실제 extension host의 shell integration은 아래 별도 headless 테스트로 검증했다. Windows 클라이언트 → Remote WSL host의 URI/SecretStorage 통합은 별도 검증 범위이며 Linux host 테스트로 대체했다고 표시하지 않는다.

## 구현상 제한
- shell 변수 확장, command substitution, 파이프, 세미콜론, 다중 소스 컴파일, `-c/-E/-S`, `python -m/-c`는 추정 연결하지 않는다.
- 성공한 컴파일을 관찰하지 못한 `./실행파일`은 snapshotId=null / linkage=unavailable로 기록한다.
- 큰 편집은 unknown으로 표시한다. 실제 입력 주체를 VS Code API만으로 증명할 수 없다.
- before/after/diff 합계가 1MB를 넘는 편집은 bounded diff와 전후 해시·truncated=true로 저장하며 전체 저장본은 Snapshot으로 보존한다. 큰 이벤트 하나가 동기화 큐 전체를 막지 않도록 한다.
- 이미 동기화된 이벤트도 로컬에 남는다. 로컬 기록 삭제는 VS Code 확장 globalStorage의 해당 세션 폴더 삭제로 관리하며 웹 삭제가 로컬 원본 삭제를 의미하지 않는다.

## ps-blogself 기록 탐색과 mock 전환

2026-10-29, 테스트용 기록이 필요해진 시점에 사용자 허용 범위 안에서 제한적으로 조사했다.

- WSL VS Code User/globalStorage·workspaceStorage(작업 공간 20개), Windows VS Code User/globalStorage·workspaceStorage(93개)의 확장 이름과 해당 확장 관련 SQLite 키만 확인했다.
- Windows 저장소에서 `undefined_publisher.ps-blogself` 상태를 찾았으나 값은 languages/rootFolder/isRecording 설정뿐이었다. 코드 작성 기록 payload나 전용 기록 디렉터리는 발견하지 못했다.
- 기록 대상 폴더의 `.vscode` 항목 이름까지 확인했으나 실행·디버깅 설정 파일 이름만 있었다. 그 설정 내용이나 기존 확장 구현·프롬프트·생성 글·대화 기록은 읽지 않았다.
- 탐색을 넓히지 않고 mock 데이터로 전환했다. `pnpm exec tsx apps/extension/scripts/create-mock-sessions.ts`가 C++/Python 실패→수정→종료 fixture를 현재 Recorder로 생성한다.
- 결과는 gitignored `.data/imported/mock-cpp.json`, `mock-python.json`, `provenance.json`에 있다. source=mock, simulated=true, officialEvaluation=false를 표시한다. 기록 구조·버전 연결·파이프라인 테스트용이며 실제 파일럿/정식 평가가 아니다.

## 실제 VS Code extension host 검증

2026-10-29, VS Code 1.144.0 Linux x64를 별도로 내려받아 WSL2 Linux 안의 Xvfb에서 실행했다. 사용자 VS Code 설정·확장·워크스페이스는 변경하지 않았다. 각 테스트는 임시 user-data-dir, extensions-dir, 합성 C++/Python 작업 폴더를 사용한다.

재현: Ubuntu 계열 Linux에서 `bash tests/vscode-host/run-linux.sh`. sudo 없이 apt 패키지를 `/tmp/autoblogger-vscode-tools`에 다운로드·추출하고 Xvfb를 실행한다. 기본 GTK/NSS/GBM/audio 라이브러리, cc, g++, Python3, npm이 필요하다. Xvfb에 내장된 xkbcomp 경로는 해당 임시 프로세스에서만 재지정한다. 실행이 끝나면 스크립트가 자신의 Xvfb 프로세스를 종료한다.

두 번의 실제 VS Code 프로세스 실행에서 다음을 통과했다.

- 개발 확장 활성화, 초기 C++/Python 스냅샷
- 실제 Python 프로세스 출력과 리다이렉션 입력 수집
- C++ 컴파일 후 파일을 바꾸어도 기존 실행파일이 기존 컴파일 스냅샷에 연결됨
- `g++ ... && ./...`의 새 디스크 버전 연결 및 실제 컴파일 에러 분류
- 명시적 중지 저장
- 기록 중인 세션을 남기고 VS Code 프로세스를 완전히 종료·재시작한 뒤 세션·이벤트 복구
- 재시작 후 새 편집·저장·Python 실행 연결, 로컬 순번 연속성과 이벤트 ID 유일성

테스트 하네스가 terminal.shellIntegration.executeCommand를 호출해 사용자의 직접 실행을 시뮬레이션한다. 기록 확장 자체는 실행 API를 호출하지 않는다. 터미널의 shell integration 객체와 cwd가 모두 준비된 뒤 실행해야 처음 명령의 작업 폴더를 확인할 수 있어 하네스가 이를 기다린다.

마지막 성공 아티팩트 경로는 `/tmp/autoblogger-vscode-tools/latest-artifacts.txt`, 각 실행의 체크 목록은 해당 폴더의 results-first.json/results-restart.json이다. Linux host 실검증이며, 사람의 문제 풀이 파일럿이나 Remote WSL의 Windows URI 전달·자격 증명 저장 검증을 뜻하지 않는다.
