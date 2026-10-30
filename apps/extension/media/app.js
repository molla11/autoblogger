/* Local, CSP-protected webview. Captured source/output is always escaped text. */
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app'), feedback = document.getElementById('feedback');
  const surface = document.body.dataset.surface;
  let saved = vscode.getState() || {}, view = saved.view || {}, model, sessionId = saved.sessionId;
  let settingsDraft = saved.settingsDraft, settingsRevision = saved.settingsRevision;
  let request = 0, booted = false, viewTimer, busy = false;
  const pending = new Map();
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value ? new Date(value).toLocaleString('ko-KR') : '아직 없음';
  const title = event => ({snapshot:'코드 저장',edit:'코드 수정',run:'터미널 실행',memo:event.label === '북마크' || event.data?.bookmark ? '북마크' : '메모',session_start:'기록 시작',session_stop:'기록 종료'}[event.type] || event.type);
  const status = value => ({success:'정상 종료',compile_error:'컴파일 에러',runtime_error:'런타임 에러',unknown:'판단 불가',manual:'직접 중지',idle:'30분 유휴 종료',remote:'웹 설정에 따라 종료'}[value] || value || '');
  const btn = (label, action, attrs = '', primary = false) => `<button type="button" data-action="${action}" ${attrs} class="${primary ? 'primary' : ''}">${h(label)}</button>`;
  const disabled = reason => reason ? `disabled title="${h(reason)}"` : '';
  const option = (value, label, current) => `<option value="${h(value)}" ${value === current ? 'selected' : ''}>${h(label)}</option>`;
  const store = () => vscode.setState({view, sessionId, settingsDraft, settingsRevision, scope:saved.scope});
  function send(type, payload = {}, action) { const id = String(++request); vscode.postMessage({id,type,payload,action}); return id; }
  function persist(immediate = false) {
    store(); clearTimeout(viewTimer);
    if (immediate) send('view', view); else viewTimer = setTimeout(() => send('view', view), 180);
  }
  function announce(text, error = false) { feedback.textContent = text || ''; feedback.dataset.error = String(error); }
  function act(action, payload = {}) {
    if (busy) return;
    busy = true; render();
    const id = send('action', payload, action); pending.set(id, {action, payload});
  }
  function folders(current) { return (model.folders || []).map(f => option(f.path, f.name, current)).join(''); }
  function connectionName() { return ({connected:'계정 연결됨',connecting:'브라우저 로그인 대기',changed:'서버 변경 · 재연결 필요',disconnected:'계정 미연결'}[model.connection]); }
  function errors() { return model.error ? `<div class="notice error" role="alert">${h(model.error)}<div class="actions">${btn('진단 로그 보기','logs')}</div></div>` : ''; }
  function connection() {
    return `<section class="section"><div class="status"><span class="dot ${model.connection === 'connected' ? 'live' : ''}"></span><strong>${connectionName()}</strong></div>
      ${model.account && model.connection === 'connected' ? `<p>${h(model.account)}</p>` : ''}
      <div class="row between"><span>${model.syncing ? '동기화 중…' : model.autoSync ? '자동 동기화 켜짐' : '자동 동기화 꺼짐'}</span><span class="badge">${model.pending}개 전송 대기</span></div>
      <p><small>최근 성공 ${h(when(model.lastSyncedAt))}</small></p>
      ${model.connection !== 'connected' ? '<p class="muted">연결 없이도 기록과 JSON 내보내기를 사용할 수 있습니다.</p>' : ''}
      <div class="actions">${model.connection === 'connecting' ? btn('연결 취소','cancelConnect') : model.connection !== 'connected' ? btn('브라우저로 계정 연결','connect','',true) : btn(model.syncing ? '동기화 중…' : '지금 동기화','sync', disabled(model.syncing ? '동기화 중입니다.' : ''),true)}${surface === 'settings' && model.deviceId ? btn('이 기기 연결 해제','disconnect') : ''}${surface !== 'settings' ? btn('설정·연결','settings') : ''}</div>${errors()}</section>`;
  }
  function memoForm() {
    const target = view.target || model.target;
    const writable = model.active && target?.sessionId === model.active.id && (surface !== 'session' || model.active.id === sessionId);
    return `<form id="memo-form" class="section"><h2>판단을 남기기</h2><label for="memo">메모</label>
      <textarea id="memo" maxlength="16384" placeholder="바꾼 이유, 실패 원인, 저지 결과를 남기세요.">${h(view.draft || '')}</textarea>
      <p class="file-context"><small>대상 ${h(target?.file ? target.file.split(/[\\/]/).pop() + (target.line ? ':' + target.line : '') : '세션 메모')}${view.target ? ' · 입력을 시작한 위치에 고정됨' : ''}</small></p>
      <label class="check"><input id="bookmark" type="checkbox" ${view.bookmark ? 'checked' : ''}> 중요한 사건으로 북마크</label>
      ${!writable ? '<p class="muted">이 세션은 기록 중이 아닙니다. 입력 내용은 보존됩니다.</p>' : ''}
      <div class="actions"><button type="submit" class="primary" ${disabled(!writable ? '기록 중인 세션에만 저장할 수 있습니다.' : '')}>메모 저장</button>${btn('입력 취소','clearDraft')}${btn('현재 파일로 대상 변경','retarget',disabled(!model.active ? '먼저 기록을 시작하세요.' : ''))}</div></form>`;
  }
  function recording() {
    const a = model.active;
    const selectedRoot = view.root || model.root;
    const elapsed = model.elapsedMinutes || 0;
    return `<section class="section"><div class="status"><span class="dot ${a ? 'live' : ''}"></span><strong>${a ? '풀이를 기록하고 있습니다' : '기록할 준비가 되셨나요?'}</strong></div>
      ${a ? `<div class="row between"><span class="path">${h(a.name)}</span><span class="badge">${elapsed}분 경과</span></div><p><small>${a.count}개 사건을 로컬에 보관했습니다.</small></p>` : `<label for="root">기록할 작업 폴더</label><select id="root" ${!model.folders.length ? 'disabled' : ''}>${!model.folders.length ? '<option>열린 작업 폴더 없음</option>' : folders(selectedRoot)}</select>`}
      <div class="actions">${a ? btn('기록 중지','stop','',true) + btn('세션 상세','session',`data-session="${h(a.id)}"`) : btn('기록 시작','start',disabled(!model.folders.length ? '작업 폴더를 먼저 여세요.' : !model.trusted ? '신뢰한 작업 폴더에서 시작하세요.' : ''),true)}${!model.folders.length ? btn('폴더 열기','folder') : ''}${!model.trusted ? btn('작업 영역 신뢰 관리','trust') : ''}</div></section>
      ${!a && model.lastStop ? `<p class="end-reason">${h(status(model.lastStop.reason))} / ${h(when(model.lastStop.at))}</p>` : ''}<section class="section"><h2>현재 파일</h2><p class="path">${h(model.currentFile?.split(/[\\/]/).pop() || '열린 코드 파일 없음')}</p><p class="muted">${h(model.collection)}</p>${btn('이후 수집 제외','exclude',disabled(!a || !model.target.file ? '기록 중인 수집 대상 파일을 여세요.' : ''))}</section>
      ${memoForm()}<section class="section"><h2>실행 관찰</h2><p class="muted">${model.terminals ? `${model.terminals}개 터미널에서 실행을 관찰할 수 있습니다.` : '실행 정보 없음. 통합 터미널의 shell integration을 확인하세요.'}</p><p class="muted">코드는 통합 터미널에서 직접 실행하세요.</p><div class="actions">${btn('터미널 열기','terminal')}${btn('설정 안내','shellHelp')}</div></section>${errors()}`;
  }
  function eventDetail(event) {
    if (!event) return '<div class="empty"><h2>사건을 선택하세요</h2><p class="muted">어떤 코드로 실행했는지, 무엇을 바꿨는지 확인할 수 있습니다.</p></div>';
    const d = event.data || {}, attrs = `data-event="${h(event.id)}"`;
    const code = (label, value) => `<h3>${h(label)}</h3><pre tabindex="0" aria-label="${h(label)}">${h(value ?? '없음')}</pre>`;
    return `${btn('사건 목록으로','backToEvents')}<h2>${h(title(event))}</h2><p class="muted">${h(when(event.occurredAt))} / ${event.sequence}번 사건</p><p class="path">${h(event.filePath || '세션 전체')}</p><div class="actions">${event.filePath ? btn('현재 파일 열기','file',attrs) : ''}${event.type === 'snapshot' || event.type === 'run' && d.snapshotId ? btn('기록된 코드 열기','snapshot',attrs) : ''}${['edit','snapshot'].includes(event.type) ? btn('코드 비교','diff',attrs) : ''}${event.filePath ? btn('이후 수집 제외','excludeEvent',attrs + disabled(!model.active || model.active.id !== sessionId ? '기록 중인 세션에만 적용할 수 있습니다.' : '')) : ''}</div>
      ${d.source === 'unknown' || d.truncated ? `<div class="notice">${d.source === 'unknown' ? '출처 미확인 편집입니다. ' : ''}${d.truncated ? '큰 편집의 원문 일부가 생략되었습니다. 저장 스냅샷을 확인하세요.' : ''}</div>` : ''}
      ${event.type === 'run' ? `<dl><dt>실행 상태</dt><dd class="${String(d.status).includes('error') ? 'error' : ''}">${h(status(d.status))}</dd><dt>종료 코드</dt><dd>${h(d.exitCode ?? '판단 불가')}</dd><dt>실행 시간</dt><dd>${h(d.durationMs)} ms</dd><dt>작업 폴더</dt><dd>${h(d.cwd)}</dd><dt>코드 연결</dt><dd>${d.snapshotId ? '관찰된 코드 버전' : '연결 불가'}</dd></dl>${code('명령',d.command)}${code('출력',d.output || '출력 없음')}<p class="muted">정상 종료는 정답 판정이 아닙니다. 출력 상한을 넘으면 앞뒤만 보존합니다.</p>${d.inputSnapshot ? code('리다이렉션 입력',d.inputSnapshot.content) : ''}` : event.type === 'snapshot' ? code('저장된 코드',d.content) : event.type === 'edit' ? code('변경 내용',d.diff) : event.type === 'memo' ? code(d.bookmark ? '북마크' : '메모',d.text) : `<p>${h(status(d.reason) || '세션을 시작했습니다.')}</p>`}`;
  }
  function session() {
    const s = model.session, tab = view.tab || 'timeline';
    return `<header><div class="row between"><h1>${h(s.name)}</h1><span class="badge">${s.recording ? '기록 중' : '기록 종료'}</span></div><p class="muted path">${h(s.rootPath)}</p><p class="muted">${h(when(s.startedAt))}${s.endedAt ? ' ~ ' + h(when(s.endedAt)) : ''}</p>
      <div class="header-meta"><div><strong>${model.count}</strong><small>기록된 사건</small></div><div><strong>${model.files.length}</strong><small>풀이 파일</small></div><div><strong>${model.sessionPending}</strong><small>전송 대기</small></div></div>
      <div class="actions">${btn('JSON 내보내기','export')}${btn('웹에서 글 작성','web',disabled(model.webReason),true)}${btn('지금 동기화','sync',disabled(model.connection !== 'connected' ? '계정을 연결하세요.' : model.syncing ? '동기화 중입니다.' : ''))}${model.connection !== 'connected' ? btn('계정 연결','connect') : ''}</div>${model.webReason ? `<p><small>${h(model.webReason)}</small></p>` : ''}${errors()}</header>
      <nav class="tabs" role="tablist" aria-label="세션 상세">${[['timeline','타임라인'],['files','파일·실행'],['notes','메모·북마크']].map(([id,label]) => `<button role="tab" id="tab-${id}" data-action="tab" data-tab="${id}" aria-selected="${tab === id}" aria-controls="session-content" tabindex="${tab === id ? 0 : -1}">${label}</button>`).join('')}</nav>
      <div role="tabpanel" id="session-content" aria-labelledby="tab-${tab}"><div class="filters"><label>풀이 파일<select id="file-filter">${option('','모든 파일',view.file || '')}${model.files.map(file => option(file.id,file.path,view.file)).join('')}</select></label>${tab !== 'notes' ? `<label>사건 종류<select id="kind-filter">${option('','모든 사건',view.kind || '')}${['snapshot','edit','run','memo','session_start','session_stop'].map(type => option(type,title({type}),view.kind)).join('')}</select></label>` : ''}</div>
      ${tab === 'notes' ? memoForm() : ''}
      <div class="split"><section aria-label="사건 목록">${model.total ? `<ol class="events">${model.events.map(event => `<li><button id="event-${h(event.id)}" class="event" data-action="selectEvent" data-event="${h(event.id)}" aria-pressed="${model.selected?.id === event.id}"><span class="event-number">${event.sequence}</span><span class="event-content"><strong>${h(title(event))}</strong><small>${h(event.filePath || '세션 전체')}</small><span class="preview">${h(event.preview || status(event.label))}</span><small>${h(new Date(event.occurredAt).toLocaleTimeString('ko-KR'))} / ${event.acknowledged ? '수신 확인' : '전송 대기'}</small></span></button></li>`).join('')}</ol>` : '<div class="empty"><h2>표시할 사건이 없습니다</h2><p class="muted">파일·종류 필터를 바꾸거나 코드를 저장해 보세요.</p></div>'}
      <div class="row between pager">${btn('이전','previous',disabled(model.page === 0 ? '첫 페이지입니다.' : ''))}<small>${model.page + 1} / ${Math.max(1,Math.ceil(model.total/60))}</small>${btn('다음','next',disabled((model.page+1)*60 >= model.total ? '마지막 페이지입니다.' : ''))}</div></section><section class="detail" aria-label="선택한 사건">${eventDetail(model.selected)}</section></div></div>
      <section class="section"><div class="row between"><h2>서버 요약</h2>${btn('요약 새로고침','summaries',disabled(model.webReason))}</div><p class="muted">원본 사건을 바탕으로 생성한 요약입니다. ${model.summary ? '마지막 갱신 ' + h(when(model.summary.fetchedAt)) : '동기화 후 요약을 불러올 수 있습니다.'}</p>${model.summaryError ? `<p class="error">${h(model.summaryError)} 기존 요약은 보존됩니다.</p>` : ''}${(model.summary?.summaries || []).map(summary => `<p class="summary">${h(summary.summary || summary.text || '')}</p>`).join('')}</section>
      <details><summary>전송 확인 범위</summary><p class="muted">${model.sessionPending ? `아직 수신 확인되지 않은 순번: ${h(model.gaps.join(', '))}${model.sessionPending > 100 ? ' … (앞 100개)' : ''}` : '모든 사건의 서버 수신을 확인했습니다.'}</p></details>`;
  }
  function settings() {
    const s = settingsDraft || model.settings, root = view.root || model.root;
    const source = key => h(model.settingSources[key] || '기본값');
    return `<div class="settings"><h1>설정·연결</h1><p class="muted">${h(model.host)} 환경에서 기록할 범위와 전송 방법을 정합니다.</p>${connection()}<form id="settings-form"><section class="section"><h2>적용 범위</h2><div class="settings-grid"><div class="field"><label for="settings-root">작업 폴더</label><select id="settings-root" ${settingsDraft ? 'disabled title="입력 내용을 저장하거나 취소한 뒤 폴더를 바꾸세요."' : ''}>${folders(root)}</select></div><div class="field"><label for="scope">저장 위치</label><select id="scope">${option('user','사용자 / 원격 사용자',saved.scope || 'workspace')}${model.folders.length ? option('workspace','작업 영역',saved.scope || 'workspace') + option('folder','선택한 폴더',saved.scope || 'workspace') : ''}</select></div></div><p class="muted">각 필드 아래에 현재 유효 값의 출처를 표시합니다. 폴더 설정이 작업 영역·사용자 설정보다 우선합니다.</p></section>
      <section class="section"><h2>수집 제외</h2><div class="field"><label for="excludePatterns">제외 규칙 (한 줄에 하나)</label><textarea id="excludePatterns" rows="5">${h(s.excludePatterns.join('\n'))}</textarea><small>출처: ${source('excludePatterns')}. 프로젝트 상대 경로에 **, *, ?를 사용할 수 있습니다.</small></div><p class="muted">제외는 이후 수집에 적용됩니다. 기존 기록은 삭제하지 않습니다.</p>${model.remoteExcludes.length ? `<p>서버에서도 적용 중: <span class="path">${h(model.remoteExcludes.join(', '))}</span></p>` : ''}${model.excludedFiles.length ? `<details><summary>기록된 파일 중 제외되는 파일</summary><p class="path">${h(model.excludedFiles.join(', '))}</p></details>` : ''}</section>
      <section class="section"><h2>동기화·실행 출력</h2><div class="field"><label class="check"><input type="checkbox" id="autoSync" ${s.autoSync ? 'checked' : ''}>자동 동기화</label><small>출처: ${source('autoSync')}</small></div><div class="settings-grid"><div class="field"><label for="syncIntervalSeconds">동기화 주기 (초)</label><input id="syncIntervalSeconds" type="number" min="5" max="300" step="1" required value="${h(s.syncIntervalSeconds)}"><small>5~300초 / 출처: ${source('syncIntervalSeconds')}</small></div><div class="field"><label for="outputLimitBytes">실행 출력 상한 (바이트)</label><input id="outputLimitBytes" type="number" min="1024" max="262144" step="1" required value="${h(s.outputLimitBytes)}"><small>1,024~262,144 / 출처: ${source('outputLimitBytes')}</small></div></div></section>
      <section class="section"><h2>서버 주소</h2><div class="field"><label for="apiUrl">API 주소</label><input id="apiUrl" type="url" required value="${h(s.apiUrl)}"><small>출처: ${source('apiUrl')}. 변경하면 계정을 다시 연결해야 합니다.</small></div><div class="field"><label for="webUrl">로그인·글 작성 웹 주소</label><input id="webUrl" type="url" required value="${h(s.webUrl)}"><small>출처: ${source('webUrl')}. 로컬 개발 외에는 HTTPS를 사용하세요.</small></div></section>
      ${settingsDraft && settingsRevision !== model.revision ? '<div class="notice error">다른 화면에서 설정이 바뀌었습니다. 입력을 복사한 뒤 최신 값을 불러와 다시 저장하세요.</div>' : ''}
      <div class="actions"><button class="primary" type="submit">설정 저장</button>${btn('입력 취소 / 최신 값 불러오기','reloadSettings')}${btn('기본값으로 채우기','defaults')}</div></form><section class="section"><h2>데이터 관리</h2><p class="muted">웹에서 기록 삭제·기기 폐기를 관리할 수 있습니다. 웹 삭제는 이 기기의 로컬 저널을 삭제하지 않습니다.</p>${btn('웹 데이터 관리','webSettings')}</section></div>`;
  }
  function render() {
    if (!model) return;
    const active = document.activeElement, focusId = active?.id, start = active?.selectionStart, end = active?.selectionEnd, scroll = window.scrollY;
    app.innerHTML = surface === 'recording' ? recording() : surface === 'connection' ? connection() : surface === 'settings' ? settings() : session();
    if (busy) app.querySelectorAll('button').forEach(button => { button.disabled = true; });
    app.setAttribute('aria-busy',String(busy));
    if (focusId) { const next = document.getElementById(focusId); next?.focus({preventScroll:true}); if (start != null && next?.setSelectionRange && !['number','checkbox'].includes(next.type)) next.setSelectionRange(start,end); }
    window.scrollTo(0,scroll);
  }
  function readSettings() {
    const get = id => document.getElementById(id);
    return {excludePatterns:get('excludePatterns').value.split('\n').map(s=>s.trim()).filter(Boolean),autoSync:get('autoSync').checked,syncIntervalSeconds:Number(get('syncIntervalSeconds').value),outputLimitBytes:Number(get('outputLimitBytes').value),apiUrl:get('apiUrl').value.trim(),webUrl:get('webUrl').value.trim()};
  }
  app.addEventListener('focusin', event => {
    if (event.target.id === 'memo' && !view.target && model?.active) { view.target = {...model.target}; persist(); }
  });
  app.addEventListener('input', event => {
    if (event.target.id === 'memo') { view.draft = event.target.value; persist(); }
    if (event.target.closest('#settings-form') && !['scope','settings-root'].includes(event.target.id)) { settingsRevision ||= model.revision; settingsDraft = readSettings(); store(); }
  });
  app.addEventListener('change', event => {
    const id = event.target.id, value = event.target.value;
    if (id === 'bookmark') { view.bookmark = event.target.checked; persist(); }
    if (id === 'root' || id === 'settings-root') { view.root = value; persist(true); }
    if (id === 'file-filter' || id === 'kind-filter') { view[id === 'file-filter' ? 'file' : 'kind'] = value; view.page=0; view.eventId=''; persist(true); }
    if (id === 'scope') { saved.scope = value; store(); }
  });
  app.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'memo-form') {
      view.draft = document.getElementById('memo').value;
      view.target ||= {...model.target};
      if (!view.draft.trim()) { announce('메모 내용을 입력하세요.',true); return; }
      act('memo',{text:view.draft,bookmark:!!view.bookmark,target:view.target});
    }
    if (event.target.id === 'settings-form') act('saveSettings',{values:readSettings(),revision:settingsRevision || model.revision,scope:document.getElementById('scope').value,root:view.root || model.root});
  });
  app.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'tab') { view.tab=button.dataset.tab; view.page=0; view.kind=''; persist(true); render(); return; }
    if (action === 'selectEvent') { view.eventId=button.dataset.event; persist(true); return; }
    if (action === 'backToEvents') { app.querySelector('.events')?.scrollIntoView({block:'start'}); app.querySelector('.event[aria-pressed=true]')?.focus({preventScroll:true}); return; }
    if (action === 'previous' || action === 'next') { view.page=model.page+(action==='next'?1:-1); persist(true); return; }
    if (action === 'clearDraft') { view.draft=''; delete view.target; persist(true); render(); return; }
    if (action === 'retarget') { view.target={...model.target}; persist(true); render(); return; }
    if (action === 'reloadSettings') { settingsDraft=undefined; settingsRevision=undefined; store(); render(); return; }
    if (action === 'defaults') { settingsRevision=model.revision; settingsDraft={...model.defaults}; store(); render(); return; }
    const payload = {eventId:button.dataset.event, sessionId:button.dataset.session || sessionId};
    if (action === 'start') payload.root=view.root || model.root;
    if (action === 'web') payload.fileId=view.file || '';
    if (action === 'exclude') payload.file=model.target.file;
    if (action === 'excludeEvent') { payload.file=model.session.rootPath + '/' + model.selected.filePath; act('exclude',payload); return; }
    act(action,payload);
  });
  app.addEventListener('keydown', event => {
    const tab = event.target.closest('[role=tab]'); if (!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const tabs=[...app.querySelectorAll('[role=tab]')], i=tabs.indexOf(tab);
    const next=tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
    next.click(); document.getElementById(next.id)?.focus();
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'model') {
      const previousEvent=model?.selected?.id;
      model=message.model; sessionId=message.sessionId;
      if (!booted) { view={...message.view,...view}; booted=true; persist(true); }
      store(); render();
      if (surface === 'session' && model.selected && previousEvent !== model.selected.id && window.innerWidth <= 700) app.querySelector('.detail')?.scrollIntoView({block:'start'});
    } else if (message.type === 'focusMemo') {
      view.bookmark=message.bookmark; persist(); render(); document.getElementById('memo')?.focus();
    } else if (message.type === 'result') {
      const completed = pending.get(message.id);
      if (pending.has(message.id)) { pending.delete(message.id); busy=false; }
      if (message.result?.clearDraft && completed?.action === 'memo' &&
          view.draft === completed.payload.text && !!view.bookmark === completed.payload.bookmark &&
          JSON.stringify(view.target) === JSON.stringify(completed.payload.target)) {
        view.draft=''; delete view.target; persist(true);
      }
      if (message.result?.settingsSaved && completed?.action === 'saveSettings') {
        if (!settingsDraft || JSON.stringify(settingsDraft) === JSON.stringify(completed.payload.values)) {
          settingsDraft=undefined; settingsRevision=undefined;
        } else {
          settingsRevision=message.result.revision;
        }
        store();
      }
      announce(typeof message.result === 'string' ? message.result : message.result?.message); render();
    } else if (message.type === 'error') {
      if (pending.has(message.id)) { pending.delete(message.id); busy=false; }
      announce(message.message,true); render();
    }
  });
  send('ready');
})();
