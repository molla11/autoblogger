# Editor spike — 2026-10-29

## 결론

명세의 첫 번째 실패 조건에 따라 **Tiptap 3.32.0 + Ghost HTML 카드** 경로를 선택했다. Lexical과 Ghost 노드를 함께 쓰는 방식의 호환성이 확인되었다고 주장하지 않는다.

## 재현 가능한 확인

1. npm 메타데이터에서 `@tryghost/kg-default-nodes@2.2.6`의 `lexical`, `@lexical/utils`, `@lexical/rich-text` 의존성이 모두 **0.13.1**로 고정되어 있음을 확인했다.
2. `@tryghost/kg-lexical-html-renderer@1.5.2` 역시 `lexical@0.13.1` 및 Ghost 기본 노드를 사용한다.
3. `npm pack lexical@0.13.1`, `npm pack @lexical/extension@0.53.0`의 실제 배포 파일을 `/tmp/autoblogger-editor-spike`에서 확인했다. Lexical 0.13.1 배포 소스에는 `createState` 및 `BlockIdExtension`이 없고, extension 0.53.0은 `lexical@0.53.0`에 의존한다.
4. 따라서 Ghost 패키지가 사용하는 Lexical 버전에서 NodeState 기반 BlockIdExtension을 함께 사용하는 조건을 충족하지 못한다. 다른 Lexical 버전을 강제로 주입하거나 Ghost 패키지를 비공식으로 패치하지 않고, 명세에 정해진 대체 경로로 진행했다.

공식 근거: [Lexical NodeState](https://lexical.dev/docs/getting-started/node-state), [BlockIdExtension](https://lexical.dev/docs/api/modules/lexical_extension/BlockIdExtension), [Ghost Koenig 이동 안내](https://github.com/TryGhost/Koenig).

## 구현

- Tiptap StarterKit + Image + Placeholder + UniqueID. 블록의 `id` 속성은 편집/저장/복원/재배열에 걸쳐 유지한다.
- 제목, 문단, 목록, 인용, 코드(언어 선택), diff 코드, 이미지 제공. `/` 메뉴, 툴바, 드래그 가능한 목차, 위아래 이동 버튼을 제공한다. 표는 v1에 포함하지 않는다.
- Article의 canonical blocks가 블록 ID·근거 ID·검토 상태를 가진다. Tiptap 원본은 `lexical.autobloggerEditor`에 저장한다.
- `lexical.root`는 Ghost의 HTML 카드 JSON 형식이다. Ghost 발행 전 내부 편집 메타데이터를 제외하고 콘텐츠를 검증해야 한다.
- 본문 변경 시 해당 블록의 검토 상태를 `needs_review`로 바꾼다. 서버도 동일 검증을 수행한다.
- 자동 저장은 예상 버전과 함께 요청한다. 409 충돌이면 로컬 편집을 유지하고 내려받기/서버 버전 불러오기를 제공한다.
- AI 제안은 원문과 제안을 나란히 비교하고 블록별로 수락/거절한다. 기준 버전이 바뀐 제안은 자동 적용하지 않는다.
- 발행 미리보기는 스크립트·same-origin 권한이 없는 sandbox iframe에서 표시한다.

## 검증

`pnpm exec vitest run apps/web/src/lib/editor-model.test.ts` 7개 검사 통과:

- ID 및 근거의 저장/로드 유지
- 본문 변경 후 검토 무효화
- 이미지 소스 변경 후 검토 무효화
- 재배열 후 근거 연결 유지
- 코드 내부 HTML을 데이터로 취급
- Ghost 카드와 내부 편집 데이터의 분리
- 기존 리치 에디터 데이터가 없는 AI 생성 글 로드

웹 전체 타입 검사 통과. 브라우저의 편집·저장·근거·버전 경로 및 실제 Ghost 왕복 검증 결과는 통합 테스트와 최종 `docs/message.txt`에서 별도로 기록한다. 아직 수행하지 않은 외부 Ghost 렌더링 검증을 완료로 처리하지 않는다.
