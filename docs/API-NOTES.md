# API 구현과 로컬 검증

## 실행

- `pnpm --filter @autoblogger/api start`: NestJS, 기본 `127.0.0.1:4000/api`.
- `AUTH_MODE=local` 기본값은 개발 전용이다. `NODE_ENV=production` 또는 루프백 외 bind에서는 기동을 거절한다.
- 최초 로그인 이메일 `admin@local.test`는 로컬 관리자. 그 외 로컬 이메일은 일반 사용자. 서비스용 실제 인증으로 사용하지 않는다.
- `DATABASE_URL` 없음: `.data/postgres`의 PGlite 영속 PostgreSQL 엔진, 작업은 API 프로세스 내 실행.
- `DATABASE_URL=postgresql://... REDIS_URL=redis://...` 사용 시 작업을 BullMQ에 등록. 별도로 `pnpm --filter @autoblogger/api worker`를 실행한다. 두 프로세스는 같은 PostgreSQL과 `ENCRYPTION_KEY`/`DATA_DIR`를 사용한다. PGlite에 별도 Redis worker를 붙이는 구성은 거절한다.
- `AUTO_SUMMARIES=false`: 개발 fixture 업로드 때 자동 유료 요약을 끄는 옵션. 명시적 생성·요약은 여전히 실제 OpenRouter를 호출한다.
- `ALLOW_LOCAL_GHOST=true`: 로컬 개발에만 테스트 Ghost의 loopback URL을 허용. 운영에서는 적용되지 않는다. 기본은 false.

## 데이터/보안

- 모든 데이터 조회는 Bearer 인증과 owner 검사. 관리자 기능은 저장된 user.role을 확인한다. Supabase 모드에서는 issuer/audience/JWKS 서명 검증 후 사용자 식별자를 사용한다.
- 기기 토큰은 해시만 저장. 브라우저→확장 연결 코드는 PKCE와 5분 만료, 원자적 일회용 소비. 기기 폐기는 이후 API/SSE 인증에 반영된다.
- 주요 엔터티별 PostgreSQL 테이블과 owner FK, events의 `(session_id,sequence)` unique, 정규화된 snapshots/edits/runs/memos. RLS는 켜고 클라이언트 역할 정책은 주지 않는다. DB 연결은 서버 역할만 사용한다.
- 원본 스냅샷은 현재 PostgreSQL에 저장한다. 업로드 이미지의 로컬 파일 저장과 Supabase 서명 업로드·인증된 다운로드 경로를 지원한다. 서비스 배포 시 private Storage bucket, MIME·용량 제한, 서버 서비스 키를 구성해야 한다.
- Snapshot/Run/Memo 등 전송 내용에서 키·토큰 패턴을 가린다. 중복 재전송은 수신 시각·JSON 객체 키 순서와 무관하게 판별한다. 충돌하는 순번·ID는 409.
- SQL upsert는 기존 owner와 parent가 같을 때만 수정한다. 다른 계정이 같은 클라이언트 ID를 경쟁 제출해도 덮어쓰지 못한다.
- Ghost 키는 AES-256-GCM 암호화. 로컬에서는 `.data/encryption.key` 자동 생성, 운영에서는 외부 `ENCRYPTION_KEY` 지정. DB와 키를 함께 백업/복원한다.
- 업로드 URL은 이미지 한 개에만 유효한 7일 서명 URL. `GET /uploads/:id/url`로 소유자가 갱신할 수 있다. 범용 로그인 토큰을 이미지 URL에 넣지 않는다.
- JSON과 multipart 용량 제한, 이미지 MIME·magic 검사. 외부 Ghost·이미지 요청은 AI 패키지의 DNS 고정 SSRF 검사를 거친다.

## 문서와 작업

- 글 초기 상태는 `local`; 원격 응답이 확인된 뒤에만 `draft`/`published`로 바뀐다.
- 편집은 expectedVersion SQL CAS. 자동 버전 최근 50개, 수동/생성/AI/발행 버전은 보존.
- AI 제안 수락은 기준 버전과 일치할 때만 가능. 편집한 블록은 근거 검토 상태를 초기화한다. 다른 블록의 Tiptap JSON과 서식을 보존한다.
- 생성 결과 저장 후 근거 검토를 별도 작업으로 등록한다. 검토는 본문 버전을 올리지 않는 metadata CAS 업데이트이고, 그사이 수정됐으면 적용하지 않는다.
- AI 작업 등록은 사용자 행 lock과 트랜잭션으로 상한/동시 실행을 검사한다. 기록·편집·발행은 AI 한도와 분리되어 있다.
- 작업에는 등록 당시 모델/provider, 원본 이벤트, 사용자 입력 문제 지문, 문서 버전을 고정한다. 사용자별 한 번에 하나의 AI 작업을 허용한다.
- 저장·실행 후 2초 휴지에 미요약 이벤트만 요약. 다른 AI 작업이 실행 중이면 후속 재시도하고, 상한/설정 오류 때 원본을 보존한다.
- SSE는 로컬 변경 알림과 1초 DB 폴링을 결합해 별도 worker에서도 동작. 누적 `stream.text`로 청크 손실을 막는다. 작업 취소도 worker가 1초마다 확인하여 AbortSignal에 반영한다.
- 발행은 저장된 불변 문서의 rich HTML 카드를 유지한다. 로컬·외부 이미지는 Ghost에 업로드하고 src를 교체한다. 이미지 매핑과 준비된 Lexical을 작업에 저장해 응답 유실 후 재시도에서 같은 payload를 사용한다.
- 원격 updated_at과 title/status/Lexical fingerprint를 함께 비교해 같은 초 안의 원격 수정도 탐지한다. 충돌은 실패로 보고, 사용자가 비교한 updated_at으로 다시 등록해야 한다. 기존 글을 자동으로 덮어쓰지 않는다.

## 삭제/보관

- 프로젝트/세션 삭제는 관련 글·버전·근거·요약·시도·기록과 작업 복사본을 삭제한다. ModelRun은 비용 메타데이터를 남기고 input/output을 지운다.
- 90일 보관 작업은 원본 이벤트와 파생 요약/시도를 지우고, 현재/과거 문서의 만료 근거 링크와 AI 작업·입출력 복사본을 제거한다. 글 자체는 유지한다.
- 계정 삭제는 연결된 업로드 파일도 지운다. Ghost 글 삭제는 요청의 명시적 `deleteGhostPosts=true` 때만 실행하고, 기본은 Ghost 글을 보존한다. 외부 백업 보관은 제공자 정책에 따른다.

## 검증 명령

- `pnpm --filter @autoblogger/api typecheck`
- `pnpm exec vitest run apps/api/test/api.test.ts`
- `API_TEST_DATABASE_URL=postgresql://USER@HOST:PORT/postgres pnpm exec vitest run apps/api/test/postgres.test.ts`

PostgreSQL 테스트는 임시 데이터베이스를 만들고 마지막에 삭제하므로 CREATE DATABASE 권한이 있는 로컬 테스트 계정을 사용한다. 실제 PostgreSQL에서 동시 저장, PKCE 일회성, AI 등록 경합, 다른 소유자의 클라이언트 ID 경합을 검증한다. 사람의 베타/평가 완료를 뜻하지 않는다.

## 추가 운영 상태

- `POST /articles/:id/complete {expectedVersion}`는 발행 여부와 별개로 편집 완료를 기록한다. 내용 변경 시 현재 완료 표시를 지우며, 최초 완료 이력으로 세션 전환율을 집계한다.
- `PATCH /admin/settings {signupPaused:true}`로 신규 가입을 대기 목록으로 받는다. 키의 남은 크레딧 0 또는 측정한 테스트 예산 소진도 신규 가입을 대기 목록으로 보낸다. 기존 로그인과 로컬 관리자 진입은 유지한다. 대기 목록은 관리자 대시보드에만 노출하고 이메일은 보내지 않는다.
- 이미지가 연결된 마지막 글·버전을 삭제하면 해당 업로드도 삭제한다. 다른 글에서 사용하는 자산은 유지한다.
- Ghost의 원격 업데이트 시각은 초 단위일 수 있다. fingerprint를 읽기 직전 비교하지만 Ghost 자체가 내용 fingerprint를 쓰기 조건으로 지원하지 않으므로 원격 preflight와 PUT 사이 외부 동시 쓰기까지 완전한 원자성을 보장하지는 않는다.

- 같은 글의 동시 발행 등록은 사용자 행 lock 아래 한 건만 허용한다. 원격 전송도 글별 PostgreSQL advisory lock으로 직렬화한다. BullMQ가 중단된 running 작업을 다시 전달하면 재개하며, 실행 토큰으로 이전 worker의 상태 덮어쓰기를 차단한다. 최대 5회 실행 후 오류로 남겨 무한 재시도를 막는다.
