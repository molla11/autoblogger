# 내부 구현 계약 v1

공통: API http://127.0.0.1:4000/api, Web http://localhost:3000. JSON 요청/응답. Authorization: Bearer token. 오류 {message,code?}. UUID 또는 불투명 문자열 ID. 날짜 ISO8601. 금액 USD.

## 인증
- GET /health 무인증.
- POST /auth/local {email} -> {token,user:{id,email,role}}. AUTH_MODE=local일 때만, API 루프백에 바인딩. 첫 seed 관리자 admin@local.test, 일반 사용자 tester@local.test. 운영에서 활성화 금지.
- GET /me -> {id,email,role,dailyLimit,monthlyLimit,usage:{day,month}}.
- GET /devices -> 배열; POST /devices {name} -> {id,token}; DELETE /devices/:id.
- POST /devices/pair {challenge,name} -> {code}; POST /devices/exchange {code,verifier} -> {token,device}. 브라우저 로그인 후 코드만 vscode URI로 전달. challenge는 SHA256(verifier) base64url.

## 기록
- GET /projects -> Project[]; POST /projects {name,rootPath?,excludePatterns?} -> Project; PATCH /projects/:id {name?,excluded?,excludePatterns?}; DELETE /projects/:id.
- POST /projects/:id/sessions {id?,startedAt?,deviceId?} -> Session.
- GET /projects/:id/sessions -> Session[]; GET /sessions/:id -> {session,files,events,summaries,gaps}; PATCH /sessions/:id {endedAt?,recording?}.
- POST /sessions/:id/events {events:RecordEvent[]} -> {ackThrough:number,received:number[],gaps:number[]}. ロ컬 순번 1부터. 중복 허용. ID/순번 충돌은 409.
- GET /sessions/:id/export -> {session,files,events}; DELETE /sessions/:id.
- POST /samples -> {project,session}. 명시적 mock C++ 실패→수정→성공 세션 생성.
- RecordEvent {id,sessionId,sequence,type:'snapshot'|'edit'|'run'|'memo'|'session_start'|'session_stop',fileId?,filePath?,occurredAt,documentVersion?,data:object}. snapshot data:{content,hash}; edit:{before,after,diff,source}; run:{command,cwd,kind,status,exitCode,output,startedAt,endedAt,durationMs,snapshotId,inputSnapshot?,signal?}; memo:{text,line?,bookmark?}.

## 글
- GET /articles -> Article[]; POST /articles {sessionId,fileId?,title?} -> Article; GET /articles/:id -> Article.
- Article {id,ownerId,sessionId,fileId?,title,version:number,lexical:object,blocks:ArticleBlock[],status,publication?,createdAt,updatedAt}.
- ArticleBlock {id,type:'heading'|'paragraph'|'quote'|'code'|'list'|'image',text,language?,url?,evidenceIds:string[],review:'needs_review'|'supported'|'insufficient'|'conflict'|'unknown'}.
- PUT /articles/:id {expectedVersion,title,lexical,blocks,kind?:'auto'|'manual'|'ai'|'generated'} -> Article. 409 stale version; edited block review resets.
- GET /articles/:id/revisions -> Revision[]; POST /articles/:id/restore {revisionId,expectedVersion} -> Article.
- GET /articles/:id/markdown -> {markdown}; GET /articles/:id/preview -> {html}.
- DELETE /articles/:id. GET /articles/:id/suggestions -> Suggestion[]; POST /suggestions/:id/resolve {action:'accept'|'reject',expectedVersion} -> Article or suggestion.

## AI/작업
- POST /jobs {kind:'generate'|'summarize'|'suggest'|'verify'|'publish',sessionId?,fileId?,articleId?,blockId?,instruction?,targetStatus?:'draft'|'published',expectedRemoteUpdatedAt?} -> Job.
- GET /jobs -> Job[]; GET /jobs/:id -> Job; POST /jobs/:id/cancel; POST /jobs/:id/retry.
- Job {id,kind,status:'queued'|'running'|'completed'|'failed'|'cancelled',progress:number,result?,error?,createdAt}.
- GET /jobs/:id/events SSE. Fetch stream with Authorization; data JSON job/progress/delta. Poll fallback permitted.
- GET /sessions/:id/events/stream SSE live summaries/events. Save/run silence triggers summary debounce.

## Ghost/Storage/관리
- GET /ghost -> {connected,url?,lastCheckedAt?}; POST /ghost {url,key} -> connection safe fields; DELETE /ghost.
- GET /articles/:id/remote -> {remote,conflict}; publish job takes immutable revision and checks remote updated_at.
- POST /uploads multipart file -> {id,url}; local files routed via authenticated API, production signed URL API supported.
- GET /admin -> {users,modelRuns,jobs,settings:{model,provider},credit,alerts,metrics}.
- PATCH /admin/settings {model,provider}; PATCH /admin/users/:id {dailyLimit,monthlyLimit}.
- GET /account/export; DELETE /account {deleteGhostPosts?:boolean}; POST /retention/run admin only.

API 담당은 이 계약을 구현하고 변경 시 다른 담당에게 메시지. 추가 endpoint 허용. 루트 shared 타입은 계약과 같으며 패키지 import는 @autoblogger/shared. AI 어댑터 @autoblogger/ai는 루트가 작성해 API에 통합 지침 제공 예정.
