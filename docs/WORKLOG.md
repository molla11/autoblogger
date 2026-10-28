# 개발 재개 메모

2026-10-29. 상세 결과와 배포 절차의 기준 문서는 `docs/message.txt`다.

## 사용자 지시

- docs의 1~6주차 기능 구현, 기능 단위 commit/push. 실제 외부 의존과 사람 평가를 꾸며 완료하지 않는다.
- 이번 범위는 로컬 테스트까지다. 사용자가 실서비스 로그인·배포를 이후로 미뤘다.
- 초기 AI는 `openai/gpt-6.1-terra` / Azure만. 정확한 OpenRouter route는 `azure/eu`. 모든 호출에서 데이터 수집 거부·구조화 응답·fallback 금지. 이후 관리자 변경 지원.
- 테스트 예산 $20. `.env.local`의 OpenRouter/Ghost 키를 출력하거나 커밋하지 않는다.
- 이메일 발송 없음. 기존 CMS → webhook → shinem.dev를 변경하지 않는다.
- ps-blogself는 코드 작성 기록만 최소 탐색했다. WSL20/Windows93 workspace storage에서 설정만 발견했고 기존 구현·프롬프트·글·대화는 읽지 않았다. 명시적 mock으로 검사했다.

## 현재 구현

- pnpm workspace: Next 웹, Nest API, 별도 BullMQ/Redis worker, VS Code 확장, shared/AI packages.
- 로컬 기본은 PGlite + 내부 큐 + 루프백 개발 인증. `pnpm dev`로 웹3000/API4000. 테스트 때 `AUTO_SUMMARIES=false`로 자동 유료 호출을 끌 수 있다.
- 운영용 Supabase JWT/JWKS, PostgreSQL RLS, private Storage 및 Docker targets가 있다. 실제 운영 계정·배포는 제외했다.
- source blobs는 `.data/source-blobs` 또는 Supabase private bucket. owner/session/content의 해시 경로. 삭제 실패 복구 사본, 기존 inline 호환, 내보내기·AI hydrate 구현.
- 원본 변이는 전역 advisory lock으로 직렬화한다. 별도 lock pool과 프로세스 내부 mutex를 함께 사용해 일반 query pool 고갈을 막는다.
- Tiptap 사용은 명세의 대체 조건에 따른 결정이다. Ghost Lexical0.13.1과 BlockIdExtension0.53 충돌 근거는 `EDITOR-SPIKE.md`. canonical blocks + 편집 문서 + Ghost HTML 카드 보존.
- Ghost 키 암호화, DNS 고정/외부 URL 검증, 이미지 이관, 불변 버전 발행, 중복 방지, 초 단위 updated_at의 빈틈을 내용 fingerprint로 검사한다. Ghost 자체 read/write 사이 동시성 한계는 결과 문서에 명시했다.
- 임시 네트워크 실패 때 로그인 토큰을 지우지 않는다. 실제401만 같은 토큰을 제거한다.

## 실제 검증

- 전체 단위/통합77, typecheck, build 통과. API36에는 실제 PostgreSQL7과 source blob7 포함.
- 실제 Linux VS Code1.144 + Xvfb, WSL2 내부 두 host 프로세스12개 체크. Windows 클라이언트 RemoteWSL 왕복 검증과 구분한다.
- 실제 Ghost6.67 + SQLite11개 체크, API→Redis→worker→Ghost 이미지·공개·충돌·공개 취소4개 체크. 운영 Ghost는 읽기 인증만 확인했다.
- 새 source storage로 worker Azure 생성→검토→오래된 제안 거절→요약→상한 시 편집 유지 통과. 마지막 실행 초안9707ms/요약2037ms/$0.0315435.
- mock A/B/C/C−검토8개, $0.0559506, 작은 입력 관측 p95 6182ms. 채점0/미채점8. 프롬프트 동결과 실제 파일럿 절차는 `EVALUATION.md`.
- GitHub Actions는 unit/typecheck/build, production 웹 무료 브라우저 검사, Docker3targets 빌드, VSIX 업로드를 수행한다. 유료 모델은 CI에서 호출하지 않는다.
- 마지막 브라우저/컨테이너/크레딧 수치는 `message.txt`를 확인한다.
- 최종 production 웹 브라우저11개(실제 Azure 포함) 통과. 전체 테스트 크레딧 사용 $0.1915494, 잔여 $19.8084506. 검증용 서버는 모두 종료했고 .env.local과 .data는 보존했다.

## 기록·운영

- 원격: `https://github.com/molla11/autoblogger`, main. git 인증은 로컬 GitHub credential helper로 설정했고 push 정상.
- 주요 구현 커밋: 965126a(shared), 6319112(AI/Ghost), 2a9ffca(extension), 68d59af(web), 116682b(API), f7c9d65(rich edit/concurrency), da7c0fe(auth), 43fb81b(source storage). 최종 문서 커밋은 git log 참조.
- 임시 실제 PostgreSQL16.15/Redis7/Ghost6.67은 `/tmp/autoblogger-*`에 사용자 권한으로 설치했다. 재실행 방법은 `EXTENSION.md`/`GHOST-TEST.md`/테스트 스크립트 참조. 포트55432/56379/2369를 사용했다.
- 원자료는 `.data/evaluations`, `.data/reports`, `.data/imported`, `.data/screenshots`에 있고 Git에 올리지 않는다. VSIX는 `apps/extension/dist/autoblogger-recorder.vsix` 및 CI artifact다.
- `scripts/retention.ts`는 기본 읽기 집계, `--run` 때90일 정리. PGlite는 API 종료 후 사용하고 별도 운영 스케줄러는 PostgreSQL/동일 Storage 환경을 사용한다.
- 사람의 파일럿·동의받은 베타·교차 평가·인터뷰, 실제 Windows 클라이언트 연결, 운영 Supabase/공개 사이트 배포는 후속 수동 작업이다. 개발 mock 검사로 대신 완료하지 않는다.
