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
- VS Code 실제 extension host의 shell integration 및 WSL 토큰 저장은 별도 실기기 검증 필요. 순수 Node 테스트가 이를 대체하지 않는다.

## 구현상 제한
- shell 변수 확장, command substitution, 파이프, 세미콜론, 다중 소스 컴파일, `-c/-E/-S`, `python -m/-c`는 추정 연결하지 않는다.
- 성공한 컴파일을 관찰하지 못한 `./실행파일`은 snapshotId=null / linkage=unavailable로 기록한다.
- 큰 편집은 unknown으로 표시한다. 실제 입력 주체를 VS Code API만으로 증명할 수 없다.
- 이미 동기화된 이벤트도 로컬에 남는다. 로컬 기록 삭제는 VS Code 확장 globalStorage의 해당 세션 폴더 삭제로 관리하며 웹 삭제가 로컬 원본 삭제를 의미하지 않는다.
