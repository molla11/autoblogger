# 풀이의 기록 · Autoblogger

VS Code에서 알고리즘 풀이의 코드 변경·실행·메모를 기록하고, 근거가 연결된 글을 작성해 Ghost에 보내는 로컬 개발 가능한 서비스입니다.

## 빠른 시작

Node.js 24와 pnpm 11을 사용합니다.

```sh
pnpm install --frozen-lockfile
# .env.example을 참고해 .env.local 설정 (이미 있는 키 파일은 덮어쓰지 마세요)
pnpm dev
```

웹: http://localhost:3000 · API: http://127.0.0.1:4000/api/health

로컬 로그인에서 `admin@local.test` 또는 `tester@local.test`를 선택하세요. 실제 계정 비밀번호는 사용하지 않습니다. 로컬 인증은 루프백 인터페이스·개발 환경에서만 허용합니다. 기본 데이터 저장소는 `.data/`의 PGlite(PostgreSQL 엔진)이며, 큐는 API 프로세스 안에서 실행합니다. 종료 후에도 기록은 보존됩니다.

첫 화면의 **샘플로 둘러보기**로 mock 풀이 기록 → 타임라인 → AI 초안 → 근거 검토 → 편집 흐름을 체험할 수 있습니다. OpenRouter 키가 없으면 기록·편집·내보내기는 가능하고 AI 요청은 오류를 표시합니다. AI 테스트는 실제 비용이 발생하며 개발 예산은 $20입니다. 초기 모델은 `openai/gpt-6.1-terra`, provider는 Azure이며 현재 정확한 라우팅 slug는 `azure/eu`입니다. 다른 provider로 자동 대체하지 않습니다.

## VS Code 확장

```sh
pnpm --filter autoblogger-recorder build
pnpm --filter autoblogger-recorder package
```

생성된 `apps/extension/dist/autoblogger-recorder.vsix`를 VS Code의 **Install from VSIX**로 설치합니다. 자세한 연결·기록·오프라인 복구 절차는 [확장 안내](docs/EXTENSION.md)를 참고하세요. 확장은 코드를 실행하지 않고 shell integration이 동작하는 통합 터미널만 관찰합니다.

## 검사

```sh
pnpm test
pnpm typecheck
pnpm build
# pnpm dev 실행 후
pnpm exec playwright install chromium
pnpm test:e2e
# 실제 API 인증 + 소액 모델 호출. 키 값은 출력하지 않음
pnpm exec tsx scripts/check-services.ts --model
# mock 데이터 A/B/C 개발 평가. 정식 사람 평가가 아님
pnpm exec tsx scripts/evaluate.ts --all
```

## PostgreSQL과 별도 worker

`docker compose up -d`로 선택적 로컬 PostgreSQL·Redis를 시작하고 `.env.local`에 다음을 추가합니다.

```dotenv
DATABASE_URL=postgresql://autoblogger:local-only@127.0.0.1:5432/autoblogger
REDIS_URL=redis://127.0.0.1:6379
```

API와 웹을 다시 시작한 뒤 별도 터미널에서 `pnpm worker`를 실행하세요. PGlite 디렉터리를 여러 프로세스가 동시에 여는 방식은 지원하지 않습니다.

## 문서

- [결과 및 배포 안내](docs/message.txt)
- [기능 명세](<docs/문제 해결 기록 블로그 서비스 — 1~6주차 기능 명세.md>)
- [API 계약](docs/API-CONTRACT.md)
- [개발 재개 기록](docs/WORKLOG.md)

실서비스 로그인·배포는 이번 작업 범위에서 제외했습니다. 사람의 실제 파일럿·베타 참여·정식 채점 결과를 mock 데이터로 대체하지 않습니다.
