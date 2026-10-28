# 개발 재개 메모

## 사용자 지시
- docs의 최신 명세 1~6주차 전체 구현. 기능 단위 commit/push. 실제 불가능한 항목과 배포 절차는 docs/message.txt.
- 이번 작업은 로컬 서버 검증까지. 실서비스 로그인·배포는 지금 하지 않는다(2026-10-29 추가 지시).
- OpenRouter는 openai/gpt-6.1-terra / Azure만. 자동 fallback 금지. 테스트 예산 $20. 관리자에서 이후 설정 변경 지원.
- .env.local에 OpenRouter/Ghost 자격 증명이 있다. 출력·커밋 금지.
- ps-blogself는 테스트 데이터 필요 시 코드 작성 기록만 확인. 기존 구현/프롬프트/생성 글을 읽지 않는다. 없으면 mock. 정식 평가로 간주하지 않는다.
- 이메일 발송 없음. 기존 CMS webhook → shinem.dev 배포는 유지.

## 구조와 분담
- pnpm workspace: apps/web Next.js, apps/api NestJS, apps/extension VS Code, packages/shared, packages/ai.
- root: 공유 계약, AI/Ghost 어댑터, 실행 환경, 통합 검증, 평가 도구·문서.
- API 담당: 저장소·인증·소유권·동기화·작업·문서/발행/관리자 API.
- Web 담당: 로그인·프로젝트·타임라인·Lexical·관리자·설정 웹.
- Extension 담당: 로컬 기록·터미널 관찰·내구 큐·인증·동기화·VSIX.
- Git commit/push는 root만 수행. 에이전트는 자기 담당 경로만 수정.

## 현재 사실
- GitHub push 정상. 초기 문서 커밋 e6451fc, f7f4c38.
- Docker 소켓 권한 불가. 기본 PGlite 로컬 모드 구현. /tmp/autoblogger-postgres에 Ubuntu 패키지를 추출해 실제 PostgreSQL16.15 포트55432, /tmp/autoblogger-redis Redis7 포트56379 실행 성공.
- Supabase 정보 없음. 로컬 전용 인증으로 검증하고 운영용 Supabase JWT 검증 경로 구현.
- Ghost6.67 read-only 사이트·글 조회 인증 성공. User-Agent 명시 필요. 기존 운영 글은 수정하지 않음.
- OpenRouter 초기 $20 잔액 확인. 논리 provider Azure → 정확한 라우팅 slug azure/eu 필요(상위 azure는 regional surcharge 필터에서 제외). 데이터 수집 거부와 fallback 금지 유지. 소액 호출 성공 $0.000132.
- 실제 Azure mock A/B/C6건 총 $0.0234042, C 첫 토큰 5569/4639ms. .data/evaluations/2026-10-28T18-45-49-483Z. 정식 평가·30분 세션 성능 아님.
- ps-blogself WSL20+Windows93 workspace storage 제한 탐색: 설정만 발견, 기록 없음. 소스/프롬프트/생성 글 미열람. .data/imported mock exports cpp/python 각9 events 재생용. apps/extension/scripts/create-mock-sessions.ts.
- 에디터 스파이크 Ghost lexical0.13.1 vs BlockIdExtension0.53 불가 → 명세상 Tiptap fallback. 실제 HTML 카드 JSON 사용, canonical blocks + autobloggerEditor document 저장.
- 중간 검증:43 unit/integration 통과, PostgreSQL3 동시성 별도 통과, Playwright2 통과. 이후 테스트 추가 진행 중.
- root 실행 API4000 session22137(코드 변경 후 재시작 필요), Next3000 session53933. API AUTO_SUMMARIES=false 테스트용. PostgreSQL/Redis는 daemon, 비밀키는 .env.local.
- 현재 팀: api 보안/동시성/게시물 rich HTML 보존 최종 수정; web 추가 브라우저 conflict QA; extension /tmp에 실제 Ghost6.67 로컬 설치 테스트 중.

## 다음 작업
- API 최신 restart하고 실제 PG+Redis 별도 worker 테스트. 생성→백그라운드 검토→제안→수락/거절→요약·취소·예산 거절 실제 흐름.
- 모든 unit/typecheck/build 및 추가 browser 회귀. production Next build는 dev 종료 후.
- 실제 로컬 Ghost 테스트 결과 수집. VSIX 최신 빌드·배포물 제공.
- docs/message.txt 최종 결과·배포 절차 갱신. Git 작은 commit/push 유지.
