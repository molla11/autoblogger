# Autoblogger Recorder

C·C++·Python 한 파일 풀이 과정을 기록하는 VS Code 확장입니다. 확장이 코드를 컴파일하거나 실행하지 않습니다. 통합 터미널의 shell integration으로 사용자가 실행한 명령만 관찰합니다.

0.2.0부터 사이드바와 편집기 탭에서 기록·탐색·설정을 사용할 수 있습니다.

1. VSIX를 설치하고 문제 풀이 작업 폴더를 엽니다. 왼쪽 Activity Bar의 **Autoblogger** 아이콘을 누릅니다.
2. **현재 기록**에서 작업 폴더를 선택하고 **기록 시작**을 누릅니다.
3. 파일을 저장하고 통합 터미널에서 `g++ solve.cpp -o solve`, `./solve`, `python3 solve.py` 등으로 직접 실행합니다.
4. 사이드바의 **판단을 남기기**에서 메모를 입력하고 필요하면 북마크를 체크합니다. 입력을 시작한 파일·줄이 고정됩니다. 종료 코드 0은 정답 판정이 아닙니다.
5. **세션** 목록에서 기록을 열면 타임라인 / 파일·실행 / 메모·북마크 탭을 사용할 수 있습니다. 사건을 선택하면 코드·실행 결과를 확인하고 읽기 전용 코드 비교를 열 수 있습니다.
6. **설정·연결**에서 브라우저로 계정을 연결합니다. 연결·동기화 뷰에서 대기 수와 오류를 확인하고 재시도할 수 있습니다. 연결 없이도 기록·조회·JSON 내보내기가 가능합니다.
7. **기록 중지** 후 세션 탭의 **JSON 내보내기**로 저장하거나, 동기화 완료 후 **웹에서 글 작성**을 누릅니다. 웹 로그인 후에도 선택한 세션·파일이 유지됩니다.

설정·연결 탭에서 제외 규칙, 자동 동기화, 주기, 출력 상한, API·웹 주소를 수정합니다. 사용자/원격 사용자·작업 영역·선택 폴더의 저장 범위와 현재 유효 값의 출처를 표시합니다. API 주소를 바꾸면 계정을 다시 연결해야 합니다.

탭을 닫아도 기록과 동기화는 계속됩니다. 선택한 내부 탭·필터·저장 전 메모는 로컬에 보존하고 다시 열거나 host를 재시작하면 복원합니다. 종료한 세션의 메모는 읽기 전용이며 남아 있는 입력을 복사할 수 있습니다.

상태 표시줄은 기록 여부, 전송 대기 수, 오류를 보여 주며 클릭하면 사이드바를 엽니다. 명령 팔레트는 같은 동작의 보조 진입점입니다. 터미널 밖 실행과 shell integration이 꺼진 터미널은 수집하지 않고 「실행 정보 없음」을 표시합니다.

확장은 workspace extension으로 실행됩니다. WSL에서는 WSL extension host의 파일과 globalStorageUri에 기록하고 토큰은 VS Code SecretStorage에만 보관합니다. `.c`, `.cpp`, `.py` 외 파일, 1MB 초과, 바이너리, 프로젝트 밖 심볼릭 링크는 제외합니다. 리다이렉션 입력은 프로젝트 내부의 작은 텍스트 파일에 한해 수집합니다.

제외 설정은 `autoblogger.excludePatterns`입니다. 현재 파일 제외 명령은 이후 수집을 중지합니다. 기존 기록을 삭제하려면 웹 데이터 관리 화면을 사용하세요. 비밀값 패턴 필터는 보조 수단이므로 비밀이 들어간 폴더는 제외하세요.

로컬 기록은 확장 globalStorage의 `sessions/<id>/events.jsonl`에 저장됩니다. 서버 수신 확인 전에는 대기 상태로 남고, 확인 후에도 세션 내보내기를 위해 로컬 기록을 유지합니다. 확장 host 재시작 시 최근 기록 세션을 복구하며 30분 이상 유휴 상태면 종료합니다.

개발: 저장소 루트에서 `pnpm install`, `pnpm --filter autoblogger-recorder build`, `pnpm --filter autoblogger-recorder package`. 배포물은 `apps/extension/dist/autoblogger-recorder.vsix`입니다.

Shell integration API 참고: https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution

구현 구조·적용한 UI/UX 스킬·검증 범위는 [확장 구현 안내](https://github.com/molla11/autoblogger/blob/main/docs/EXTENSION.md)를 참고하세요.
