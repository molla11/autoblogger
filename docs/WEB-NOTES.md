# 웹 구현·검증 메모

## 실행

- `pnpm --filter @autoblogger/web dev` → `http://127.0.0.1:3000`
- 기본 API: `http://127.0.0.1:4000/api`. 변경은 `NEXT_PUBLIC_API_URL`.
- 로컬 관리자: `admin@local.test`, 일반 사용자: `tester@local.test`. 로컬 인증은 API가 제한한다.
- 운영 OAuth는 `NEXT_PUBLIC_AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. GitHub OAuth callback `/auth/callback`. 실제 운영 연결은 사용자 지시에 따라 미실행.
- 모든 데이터 조회·변경은 Nest API를 사용한다. Supabase 클라이언트는 로그인에만 사용한다.

## 경로·흐름

- `/`: 로컬 로그인 → 대시보드 → 샘플 체험 또는 프로젝트 생성 → 세션 타임라인 → 파일별 초안 → 에디터.
- `/connect`: 확장 연결. challenge/name/state/callback을 보관하며 로그인 후 PKCE pair 요청. 허용된 VS Code URI에 code와 state만 전달.
- `/privacy`: 수집 범위·보관·모델 API 전송·삭제 안내. 운영자·리전 등 실제 배포 정보는 배포 시 확정.
- 글 보관함: 검색·열기·삭제. 설정: Ghost 연결, 기기 인증 폐기, 전체 데이터 내보내기, 계정 삭제와 Ghost 삭제 선택.
- 관리자: 비용·모델 호출·실패 작업·키 한도·사용자 상한·모델/provider 설정. 일반 계정에는 메뉴가 없고 API가 권한을 다시 검사한다.

## 편집과 발행

- `docs/EDITOR-SPIKE.md`의 명세상 대체 경로 적용.
- 자동 저장 1.1초 debounce. optimistic version 충돌은 내용 보존 후 명시적 복구. 브라우저 닫기 전에 미저장 변경 경고.
- 글 제목 `aria-label=글 제목`, 본문 contenteditable `aria-label=글 본문`.
- 근거는 의미 있는 사건 이름·시각으로 표시. 원본 코드·실행 결과·메모를 확인하고 연결/해제 가능.
- 선택한 사건을 본문에 삽입 시 근거 ID를 함께 붙인다.
- 작업 상태는 Authorization fetch SSE, 연결이 끊겨도 2초 작업 polling으로 복구. 세션은 SSE와 10초 polling.
- Ghost 원격 충돌이 있으면 로컬/원격 비교 화면을 보여 주고 자동 덮어쓰기하지 않는다.
- 로컬 이미지의 signed URL은 API origin에 맞춰 절대 URL로 표시. Ghost 전송은 API가 소유자를 검증하고 이미지를 업로드한 뒤 URL을 교체해야 한다.

## 체크

- `pnpm --filter @autoblogger/web typecheck` 통과.
- `pnpm exec vitest run apps/web/src/lib/editor-model.test.ts` 7개 통과.
- 통합 브라우저 검증과 production build는 root 에이전트가 진행한다. `next dev`와 production build를 동일 .next 디렉터리에서 동시에 실행하지 않는다.
- Next 16.4.3이 생성한 `apps/web/AGENTS.md`를 읽고 관련 bundled CSS/lazy loading 문서를 확인했다.
