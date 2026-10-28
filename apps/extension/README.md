# Autoblogger Recorder

C·C++·Python 한 파일 풀이 과정을 기록하는 VS Code 확장입니다. 확장이 코드를 컴파일하거나 실행하지 않습니다. 통합 터미널의 shell integration으로 사용자가 실행한 명령만 관찰합니다.

1. VSIX를 설치하고 문제 풀이 작업 폴더를 엽니다.
2. 명령 팔레트에서 **Autoblogger: 기록 시작**을 실행합니다.
3. 파일을 저장하고 통합 터미널에서 `g++ solve.cpp -o solve`, `./solve`, `python3 solve.py` 등으로 직접 실행합니다.
4. 메모·북마크 명령으로 당시 판단과 저지 결과를 남깁니다. 종료 코드 0은 정답 판정이 아닙니다.
5. **브라우저로 계정 연결** 후 로그인하면 로컬 큐를 서버에 동기화합니다. 연결 없이도 기록·JSON 내보내기가 가능합니다.

상태 표시줄은 기록 여부, 전송 대기 수, 오류를 보여 줍니다. 터미널 밖 실행과 shell integration이 꺼진 터미널은 수집하지 않으며 상태 보기에서 「실행 정보 없음」을 표시합니다.

확장은 workspace extension으로 실행됩니다. WSL에서는 WSL extension host의 파일과 globalStorageUri에 기록하고 토큰은 VS Code SecretStorage에만 보관합니다. `.c`, `.cpp`, `.py` 외 파일, 1MB 초과, 바이너리, 프로젝트 밖 심볼릭 링크는 제외합니다. 리다이렉션 입력은 프로젝트 내부의 작은 텍스트 파일에 한해 수집합니다.

제외 설정은 `autoblogger.excludePatterns`입니다. 현재 파일 제외 명령은 이후 수집을 중지합니다. 기존 기록을 삭제하려면 웹 데이터 관리 화면을 사용하세요. 비밀값 패턴 필터는 보조 수단이므로 비밀이 들어간 폴더는 제외하세요.

로컬 기록은 확장 globalStorage의 `sessions/<id>/events.jsonl`에 저장됩니다. 서버 수신 확인 전에는 대기 상태로 남고, 확인 후에도 세션 내보내기를 위해 로컬 기록을 유지합니다. 확장 host 재시작 시 최근 기록 세션을 복구하며 30분 이상 유휴 상태면 종료합니다.

개발: 저장소 루트에서 `pnpm install`, `pnpm --filter autoblogger-recorder build`, `pnpm --filter autoblogger-recorder package`. 배포물은 `apps/extension/dist/autoblogger-recorder.vsix`입니다.

Shell integration API 참고: https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution
