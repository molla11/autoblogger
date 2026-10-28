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
- Docker 소켓 권한 불가. Docker 없이 PGlite(실제 PostgreSQL 엔진) 로컬 모드 및 Redis 별도 실행 경로로 검증 예정.
- Supabase 정보 없음. 로컬 전용 인증으로 검증하고 운영용 Supabase JWT 검증 경로 구현.
- 외부 서비스 키 연결 점검 진행 중. 실제 결과만 기록할 것.

## 다음 작업
- docs/API-CONTRACT.md와 공유 타입을 기준으로 병렬 구현.
- 테스트·빌드·브라우저 통합 검증 후 빠진 기능 및 보안 경계 재검토.
- 개발 데이터 검증과 사람의 정식 파일럿/베타 평가를 구분해 보고.
