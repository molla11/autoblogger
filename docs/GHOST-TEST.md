# 실제 로컬 Ghost 검증

## 환경
- 2026-10-29, Ghost 6.67.0 / Node 22.23.4 / SQLite / Linux x64(WSL2).
- Docker 소켓 권한 문제를 우회하는 별도 로컬 설치를 `/tmp/autoblogger-ghost`에 구성했다. 저장소 및 운영 CMS 설치를 바꾸지 않았다.
- Node 공식 배포 아카이브의 SHA256을 확인했다. Ghost CLI 1.34.0, 별도 pnpm 12.16.1 bootstrap을 `/tmp/autoblogger-ghost-tools`에 설치했다. Ghost 자체 lockfile은 pnpm 12.7.0을 사용했다.
- 메일은 Nodemailer JSON transport로 설정하여 실제 발송하지 않는다. 공개 범위는 루프백 `127.0.0.1:2369`뿐이다.
- 초기 owner와 Custom Integration은 합성 테스트 데이터다. 통합에 Ghost 표준 Admin Integration 역할을 지정했다. 비밀키 파일은 `/tmp/autoblogger-ghost/test-credentials.json` (권한 0600)에만 저장했다.
- 키 파일 형식은 `{"url":"http://127.0.0.1:2369","key":"<id>:<secret>"}`이다. 테스트는 프로젝트 `.env.local`을 읽지 않고 loopback 주소 외에는 거부한다.

## 재현

Linux x64에서:

```sh
node scripts/setup-local-ghost.mjs
pnpm exec tsx tests/ghost-local/run.ts
```

설치 스크립트는 필요한 런타임을 임시 디렉터리에 내려받고 고정된 Ghost 버전을 설치한다. 서버를 새로 실행하면 PID는 `/tmp/autoblogger-ghost/server.pid`, 로그는 `server.log`에 남긴다. 종료 시 해당 PID의 프로세스가 이 테스트 서버인지 확인한 뒤 종료한다. 결과는 `/tmp/autoblogger-ghost/test-results.json`이다.

다른 OS는 [Ghost 공식 로컬 설치 가이드](https://docs.ghost.org/install/local/)를 따라 별도 테스트 Ghost를 만들고 동일한 키 파일 형식을 전달한다. `pnpm exec tsx tests/ghost-local/run.ts <키파일 경로>`로 실행하며 loopback 제약은 유지한다.

## 검증 결과: 11개 통과
1. Custom Integration 인증
2. HTML 카드로 실제 초안 생성
3. 초안 재조회와 블록 ID·근거 ID 제거
4. 응답 유실 상황의 동일 create 요청 재조정(중복 글 생성 없음)
5. 실제 공개 페이지에서 코드·diff 렌더링
6. 공개본 업데이트
7. stale updated_at 충돌 거절, 원격 원본 보존
8. PNG 업로드와 Ghost 이미지 URL 조회
9. 실제 공개 페이지의 업로드 이미지 표시
10. 공개 취소 후 원격 draft 상태 및 공개 URL 404 확인
11. 테스트 글 삭제와 HTTP 204 처리

테스트에서 발견한 실제 수정 사항: native FormData를 별도 undici.fetch에 넘기면 `[object FormData]` 문자열로 전송되는 문제를 undici FormData 사용으로 수정했다. HTTP 204 응답에 body를 넣어 Response를 생성하던 문제도 null body로 수정했다.

이 테스트는 실제 Ghost 엔진과 로컬 테마를 검증한다. `cms.shinem.dev`에는 쓰기 요청을 하지 않았으며, 기존 webhook → `shinem.dev` 정적 호스팅의 배포 반영은 여기서 검증한 것으로 간주하지 않는다.
