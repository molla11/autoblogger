# 확장 구현·검증 메모

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
