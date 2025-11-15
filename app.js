// AI 발표 리허설 코치 - Frontend only (no backend dependency)
// Replace API hooks (sendChatToBackend, sendAudioChunk) to integrate your model/prompt.

(function () {
  const els = {
    btnToggleRehearsal: document.getElementById('btnToggleRehearsal'),
    btnToggleMic: document.getElementById('btnToggleMic'),
    recStatusDot: document.getElementById('recStatusDot'),
    recTimer: document.getElementById('recTimer'),
    chat: document.getElementById('chat'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),
    btnSend: document.getElementById('btnSend'),
    referenceText: document.getElementById('referenceText'),
    wpm: document.getElementById('wpm'),
    paceGauge: document.getElementById('paceGauge'),
    paceHint: document.getElementById('paceHint'),
    fillerCount: document.getElementById('fillerCount'),
    fillerPerMin: document.getElementById('fillerPerMin'),
    fillerHint: document.getElementById('fillerHint'),
    prosodyVar: document.getElementById('prosodyVar'),
    prosodyBar: document.getElementById('prosodyBar'),
    alignment: document.getElementById('alignment'),
    levelMeter: document.getElementById('levelMeter'),
    reportSummary: document.getElementById('reportSummary'),
    btnCopyReport: document.getElementById('btnCopyReport'),
    btnDownloadReport: document.getElementById('btnDownloadReport'),
    // Auth elements
    authAreaLoggedOut: document.getElementById('authAreaLoggedOut'),
    authAreaLoggedIn: document.getElementById('authAreaLoggedIn'),
    btnOpenLogin: document.getElementById('btnOpenLogin'),
    btnOpenSignup: document.getElementById('btnOpenSignup'),
    btnUser: document.getElementById('btnUser'),
    userMenu: document.getElementById('userMenu'),
    btnLogout: document.getElementById('btnLogout'),
    userDisplayName: document.getElementById('userDisplayName'),
    // Modals
    modalLogin: document.getElementById('modalLogin'),
    modalSignup: document.getElementById('modalSignup'),
    modalProfile: document.getElementById('modalProfile'),
    closeLogin: document.getElementById('closeLogin'),
    closeSignup: document.getElementById('closeSignup'),
    closeProfile: document.getElementById('closeProfile'),
    // Forms
    formLogin: document.getElementById('formLogin'),
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    formSignup: document.getElementById('formSignup'),
    signupName: document.getElementById('signupName'),
    signupEmail: document.getElementById('signupEmail'),
    signupPassword: document.getElementById('signupPassword'),
    formProfile: document.getElementById('formProfile'),
    profileName: document.getElementById('profileName'),
    profileEmail: document.getElementById('profileEmail'),
    profilePassword: document.getElementById('profilePassword'),
    btnDeleteAccount: document.getElementById('btnDeleteAccount'),
    // Prompt settings
    promptSystem: document.getElementById('promptSystem'),
    promptGuidelines: document.getElementById('promptGuidelines'),
    promptRubric: document.getElementById('promptRubric'),
    btnSavePrompts: document.getElementById('btnSavePrompts'),
  };

  // State
  const state = {
    isRehearsing: false,
    startTs: 0,
    elapsedSec: 0,
    timerHandle: null,
    mediaRecorder: null,
    audioCtx: null,
    analyser: null,
    sourceNode: null,
    levelData: new Uint8Array(256),
    chunks: [],
    transcripts: [], // { t, text }
    transcriptFull: '',
    fillers: ['어', '음', '그', '에', '저기', '그러니까', '뭔가', '약간', '이제', 'like', 'umm', 'uh', 'you know'],
    metrics: null,
    micInputToChat: false,
    session: null,
    // Segmentation & triggers
    segments: [], // {start,end,text}
    currentSeg: { start: 0, end: null, text: '' },
    lastVoiceTs: 0,
    triggerWords: ['중간 피드백','잠깐','리허설 끝','여기까지','리허설끝','여기 까지','리허설 종료','끝'],
    speechSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  };

  // Utility
  const fmt = {
    pad2: (n) => (n < 10 ? '0' + n : '' + n),
    time: (s) => `${fmt.pad2(Math.floor(s / 60))}:${fmt.pad2(Math.floor(s % 60))}`,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  };

  // Chat UI helpers
  function addMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    els.chat.appendChild(wrap);
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function setStatusLive(live) {
    els.recStatusDot.classList.toggle('live', !!live);
  }

  function setButtonsDuringRehearsal(disabled) {
    els.btnToggleMic.disabled = disabled;
    els.chatInput.disabled = disabled;
    els.btnSend.disabled = disabled;
  }

  // Audio setup and recording
  async function startAudio() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
        // Try to detect if any audio-input device exists
        let haveInput = false;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          haveInput = devices.some((d) => d.kind === 'audioinput');
        } catch {}
        if (!haveInput) {
          addMessage('bot', '사용 가능한 마이크 장치를 찾을 수 없습니다. 시스템 설정에서 입력 장치를 연결/활성화한 뒤 다시 시도해 주세요.');
          throw err;
        }
        // Device 목록은 있으나 현재 constraint가 맞지 않는 경우: 기본 설정으로 재시도
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }
    if (!stream) throw new Error('mic_stream_unavailable');
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.sourceNode = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.sourceNode.connect(state.analyser);
    drawLevelMeter();

    // Pick a supported MIME type for wider browser support
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/mpeg'
    ];
    let mime = '';
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const c of candidates) { if (MediaRecorder.isTypeSupported(c)) { mime = c; break; } }
    }
    state.mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    state.chunks = [];
    state.mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        state.chunks.push(e.data);
        // Optional: stream chunk to backend
        // await sendAudioChunk(e.data, state.chunks.length);
      }
    };
    state.mediaRecorder.start(1000);
  }

  function stopAudio() {
    try { state.mediaRecorder && state.mediaRecorder.stop(); } catch {}
    try { state.sourceNode && state.sourceNode.disconnect(); } catch {}
    try { state.analyser && state.analyser.disconnect(); } catch {}
    try { state.audioCtx && state.audioCtx.close(); } catch {}
    state.mediaRecorder = null;
    state.sourceNode = null;
    state.analyser = null;
    state.audioCtx = null;
  }

  function drawLevelMeter() {
    if (!els.levelMeter || !state.analyser) return;
    const ctx = els.levelMeter.getContext('2d');
    const w = els.levelMeter.width, h = els.levelMeter.height;
    function loop() {
      if (!state.analyser) return;
      state.analyser.getByteTimeDomainData(state.levelData);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const slice = w / state.levelData.length;
      for (let i = 0; i < state.levelData.length; i++) {
        const v = (state.levelData[i] - 128) / 128;
        const y = h / 2 + v * (h / 2 - 2);
        const x = i * slice;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // rough silence detection and segmenting
      const peak = Math.max.apply(null, state.levelData);
      const trough = Math.min.apply(null, state.levelData);
      const amp = peak - trough; // 0..~ amplitude window
      const now = Date.now();
      if (amp > 10) state.lastVoiceTs = now; // heuristic threshold
      const silenceMs = now - (state.lastVoiceTs || now);
      const nowSec = Math.floor((now - state.startTs) / 1000);
      const segStart = state.currentSeg.start || nowSec;
      const segDur = nowSec - segStart;
      if (state.isRehearsing && silenceMs > 800 && segDur >= 10) {
        // close segment on natural pause if long enough
        closeCurrentSegment();
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  // Speech recognition (optional, browser dependent)
  let recog = null;
  function setupSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      addMessage('bot', '⚠️ 현재 브라우저에서는 Web Speech API(음성 인식)를 지원하지 않아 속도/자동 종료 기능을 사용할 수 없습니다. Chrome 최신 버전(HTTPS 또는 localhost)에서 열어주세요.');
      return null;
    }
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const res = event.results[i];
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          pushTranscript(text);
          checkTriggers(text);
        } else {
          interim += res[0].transcript;
        }
      }
      // Optionally show interim in input
      if (state.micInputToChat) {
        els.chatInput.value = interim;
      }
    };
    r.onerror = (e) => {
      console.debug('SpeechRecognition error', e);
      const type = e?.error;
      if (type === 'not-allowed' || type === 'service-not-allowed') {
        addMessage('bot', '마이크 권한이 차단되어 음성 인식을 시작할 수 없습니다. 브라우저 주소창의 마이크 설정을 "허용"으로 바꾸고 다시 시도해 주세요.');
      } else if (type === 'aborted') {
        addMessage('bot', '음성 인식이 중단되었습니다. 탭을 다시 클릭하거나 리허설을 재시작해 주세요.');
      }
    };
    r.onend = () => {
      // Auto-restart during rehearsal
      if (state.isRehearsing) {
        try { r.start(); } catch {}
      }
    };
    return r;
  }

  function checkTriggers(text) {
    // Normalize(공백 제거/소문자) to catch variants like "리허설끝"
    const cleaned = (text || '').replace(/\s+/g, '').toLowerCase();
    const hit = state.triggerWords.find(w => cleaned.includes(w.replace(/\s+/g, '').toLowerCase()));
    if (!hit) return;
    if (hit === '리허설 끝' || hit === '여기까지') {
      // will stop and produce full report
      stopRehearsal();
      return;
    }
    // Mid feedback: provide segment-level coaching without stopping
    const fb = buildSegmentFeedback();
    if (fb) addMessage('bot', fb);
  }

  function closeCurrentSegment() {
    if (!state.currentSeg) return;
    const nowSec = Math.floor((Date.now() - state.startTs) / 1000);
    if (state.currentSeg.end == null) state.currentSeg.end = nowSec;
    if (state.currentSeg.text && state.currentSeg.text.trim()) {
      state.segments.push({ ...state.currentSeg });
    }
    state.currentSeg = { start: nowSec, end: null, text: '' };
  }

  function buildSegmentFeedback() {
    const seg = state.segments[state.segments.length - 1];
    if (!seg) return null;
    const m = state.metrics;
    const range = toRange(seg);
    const bullets = [];
    bullets.push(`[세그먼트 피드백 ${range}]`);
    // Positive
    bullets.push('• Positive: 안정적인 전달입니다. 핵심 문장을 분명히 하려는 의도가 좋습니다.');
    // Exact
    if (m?.wpm > 170) bullets.push('• Exact: 속도가 다소 빠른 구간입니다(>170 WPM 추정).');
    if (m?.fPerMin > 3) bullets.push('• Exact: 군말 빈도가 높은 편입니다(>3회/분 추정).');
    if (m?.prosody < 25) bullets.push('• Exact: 억양 다양성이 부족해 단조롭게 들립니다.');
    // Actionable
    const acts = [];
    if (m?.wpm > 170) acts.push('문장 끝에 0.5초 정지로 완급 조절');
    if (m?.fPerMin > 3) acts.push('군말 대신 호흡 1회로 여백 만들기');
    if (m?.prosody < 25) acts.push('전환어에서 억양 살짝 상승');
    if (acts.length) bullets.push(`• Actionable: ${acts.join(' · ')}`);
    return bullets.join('\n');
  }

  function pushTranscript(text) {
    if (!text) return;
    const t = (Date.now() - state.startTs) / 1000;
    state.transcripts.push({ t, text });
    state.transcriptFull = (state.transcriptFull + ' ' + text).trim();
    // append to current segment text and ensure a start
    if (!state.currentSeg.start) state.currentSeg.start = Math.floor((Date.now() - state.startTs) / 1000);
    state.currentSeg.text += (state.currentSeg.text ? ' ' : '') + text;
    // live metrics
    const m = computeMetrics(state.transcriptFull, Math.max(1, state.elapsedSec), state);
    state.metrics = m;
    renderLiveMetrics(m);
  }

  // Metrics
  function estimateWPM(text, elapsedSec) {
    // For Korean, whitespace tokenization is an approximation; still useful as a pace indicator
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.round((words / elapsedSec) * 60);
  }

  function countFillers(text, fillers) {
    let count = 0;
    for (const f of fillers) {
      // word boundary-ish; for Korean, simple substring also useful
      const re = new RegExp(`(?:^|\b|\s)${escapeRegExp(f)}(?:\b|\s|$)`, 'gi');
      const matches = text.match(re);
      if (matches) count += matches.length;
    }
    return count;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function prosodyVariance(analyser) {
    // Proxy using waveform variance (amplitude dynamics). 0..100
    if (!analyser) return 0;
    const arr = new Uint8Array(256);
    analyser.getByteTimeDomainData(arr);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
    const norm = fmt.clamp((variance / (128 * 128)) * 1000, 0, 100);
    return Math.round(norm);
  }

  function keywordAlignment(reference, transcript) {
    if (!reference || !reference.trim()) return null;
    const refTokens = Array.from(new Set(reference.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1)));
    if (refTokens.length === 0) return null;
    const got = transcript.toLowerCase();
    let hit = 0;
    for (const k of refTokens) if (got.includes(k)) hit++;
    return Math.round((hit / refTokens.length) * 100);
  }

  function computeMetrics(text, elapsedSec, st) {
    const wpm = estimateWPM(text, elapsedSec);
    const fillers = countFillers(text, st.fillers);
    const fPerMin = Math.round((fillers / Math.max(1, elapsedSec)) * 60 * 10) / 10;
    const prosody = prosodyVariance(st.analyser);
    const align = keywordAlignment(els.referenceText.value || '', text);
    return { wpm, fillers, fPerMin, prosody, align, elapsedSec, words: text.trim().split(/\s+/).filter(Boolean).length };
  }

  function renderLiveMetrics(m) {
    if (!m) return;
    // show 0 as 0 (not '-')
    els.wpm.textContent = (m.wpm ?? '-')
    const pace = fmt.clamp(((m.wpm - 80) / (200 - 80)) * 100, 0, 100); // 80..200 scale
    els.paceGauge.style.width = `${pace}%`;
    els.paceHint.textContent = m.wpm < 120 ? '조금 느려요. 템포를 올려보세요.' : m.wpm > 170 ? '조금 빨라요. 간격을 주세요.' : '좋은 속도입니다.';

    els.fillerCount.textContent = m.fillers;
    els.fillerPerMin.textContent = isFinite(m.fPerMin) ? m.fPerMin.toFixed(1) : '-';
    els.fillerHint.textContent = m.fPerMin > 4 ? '군말이 잦아요. 멈춤을 활용하세요.' : '안정적입니다.';

    els.prosodyVar.textContent = `${m.prosody}`;
    els.prosodyBar.style.width = `${m.prosody}%`;

    els.alignment.textContent = m.align == null ? '-' : `${m.align}`;
  }

  // Report
  function buildRecommendations(m) {
    const recs = [];
    if (m.wpm < 120) recs.push('속도를 약간 올리고 문장 간 간격을 짧게 유지하세요.');
    if (m.wpm > 170) recs.push('중요 포인트에서 0.5초 멈춤으로 전달력을 높이세요.');
    if (m.fPerMin > 3) recs.push('군말 대신 숨 고르기와 시선 처리로 여백을 만드세요.');
    if (m.prosody < 25) recs.push('문장 끝, 숫자/키워드에서 억양 대비를 키우세요.');
    if (m.align != null && m.align < 60) recs.push('참고 자료의 핵심 키워드를 명시적으로 언급하세요.');
    if (recs.length === 0) recs.push('전반적으로 안정적입니다. 사례/데모를 추가해 완성도를 높이세요.');
    return recs;
  }

  function buildReport(m) {
    const score = Math.round(
      0.25 * scaleScore(m.wpm, 120, 170) +
      0.25 * (100 - Math.min(100, m.fPerMin * 20)) +
      0.2 * m.prosody +
      0.3 * (m.align == null ? 70 : m.align)
    );
    const recs = buildRecommendations(m);
    const table = buildDetailedTable(m);
    const pointers = buildPrecisionPointers(state.segments);
    return {
      createdAt: new Date().toISOString(),
      durationSec: m.elapsedSec,
      words: m.words,
      metrics: {
        speedWPM: m.wpm,
        fillersPerMin: m.fPerMin,
        prosodyVar: m.prosody,
        alignment: m.align,
      },
      score,
      recommendations: recs,
      table,
      pointers,
    };
  }

  function scaleScore(v, lo, hi) {
    const p = fmt.clamp((v - lo) / (hi - lo), 0, 1);
    return Math.round(100 * (0.2 + 0.8 * p));
  }

  function renderReport(report) {
    const lines = [];
    lines.push(`총점: ${report.score}/100`);
    lines.push(`시간: ${fmt.time(report.durationSec)} / 단어: ${report.words}`);
    const m = report.metrics;
    lines.push(`- 속도: ${m.speedWPM} WPM`);
    lines.push(`- 군말: ${m.fillersPerMin}/분`);
    lines.push(`- 억양 다양성: ${m.prosodyVar}`);
    lines.push(`- 자료 일치: ${m.alignment == null ? '-' : m.alignment + '%'}`);
    lines.push('세부 진단표 (10점 만점)');
    if (report.table) {
      for (const r of report.table) lines.push(`• ${r.항목}: ${r.점수}/10 — ${r.근거}`);
    }
    lines.push('권장 수정 사항:');
    for (const r of report.recommendations) lines.push(`• ${r}`);
    if (report.pointers && report.pointers.length) {
      lines.push('정확 포인트 코칭:');
      for (const p of report.pointers) lines.push(`• ${p.range} "${p.quote}" → ${p.action}`);
    }
    if (report.nextLoop) {
      lines.push(`다음 루프 제안: ${report.nextLoop.mode} — ${report.nextLoop.reason}`);
    }
    els.reportSummary.textContent = lines.join('\n');
  }

  function buildDetailedTable(m) {
    const speedScore = clamp10(scaleScore(m.wpm, 120, 170) / 10);
    const fillerScore = clamp10(10 - Math.min(10, (m.fPerMin || 0) * 2));
    const prosodyScore = clamp10(((m.prosody || 0) / 100) * 10);
    const logicScore = clamp10(((m.align == null ? 70 : m.align) / 100) * 10);
    const audienceScore = clamp10(((m.align == null ? 70 : m.align) / 100) * 6 + ((m.prosody || 0) / 100) * 4);
    return [
      { 항목: '내용 구조(논리·전환)', 점수: logicScore, 근거: 'Problem→Solution→Impact→Ask 근사' },
      { 항목: '표현력(발음·억양·감정)', 점수: prosodyScore, 근거: 'prosody variance 근사치' },
      { 항목: '언어 구사(군말·반복·정확성)', 점수: fillerScore, 근거: '군말 분당 빈도' },
      { 항목: '비언어 요소(호흡·속도·침묵)', 점수: speedScore, 근거: '속도 범위 적합도' },
      { 항목: '청중 관점(Ethos/Pathos/Logos)', 점수: audienceScore, 근거: '일치도/억양 조합' },
    ];
  }

  function buildPrecisionPointers(segments) {
    return (segments || []).slice(-3).map(s => ({
      range: toRange(s),
      quote: (s.text || '').slice(0, 40),
      action: '전환부에 0.5초 여백과 상승 억양을 넣어보세요.'
    }));
  }

  function toRange(s) {
    const f = (x) => new Date(x * 1000).toISOString().substr(14, 5);
    if (s.start != null && s.end != null) return `${f(s.start)}–${f(s.end)}`;
    if (s.start != null) return `${f(s.start)}–`;
    return '';
  }

  function clamp10(v) { return Math.max(0, Math.min(10, Math.round(v))); }

  // ===== Auth (localStorage template) =====
  const AUTH_USERS_KEY = 'ai_coach_users';
  const AUTH_SESSION_KEY = 'ai_coach_session';

  function readUsers() {
    try { return JSON.parse(localStorage.getItem(AUTH_USERS_KEY)) || []; } catch { return []; }
  }
  function writeUsers(list) { localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(list)); }
  function readSession() { try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY)); } catch { return null; } }
  function writeSession(s) { if (s) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(AUTH_SESSION_KEY); }

  async function hash(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function signup({ name, email, password }) {
    const users = readUsers();
    if (users.find(u => u.email === email)) throw new Error('이미 등록된 이메일입니다.');
    const hpw = await hash(password);
    const user = { id: 'u_' + Date.now(), name, email, hpw, createdAt: Date.now() };
    users.push(user); writeUsers(users); writeSession({ uid: user.id });
    return user;
  }

  async function login({ email, password }) {
    const users = readUsers();
    const user = users.find(u => u.email === email);
    if (!user) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
    const hpw = await hash(password);
    if (user.hpw !== hpw) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
    writeSession({ uid: user.id });
    return user;
  }

  function logout() { writeSession(null); }
  function currentUser() { const s = readSession(); if (!s) return null; return readUsers().find(u => u.id === s.uid) || null; }

  async function updateProfile({ name, password }) {
    const s = readSession(); if (!s) throw new Error('로그인 필요');
    const users = readUsers();
    const i = users.findIndex(u => u.id === s.uid);
    if (i < 0) throw new Error('사용자를 찾을 수 없습니다.');
    if (name) users[i].name = name;
    if (password && password.length >= 6) users[i].hpw = await hash(password);
    writeUsers(users); return users[i];
  }

  function deleteAccount() {
    const s = readSession(); if (!s) throw new Error('로그인 필요');
    const next = readUsers().filter(u => u.id !== s.uid);
    writeUsers(next); writeSession(null);
  }

  function renderAuthUI() {
    const u = currentUser();
    if (u) {
      els.authAreaLoggedOut && (els.authAreaLoggedOut.style.display = 'none');
      els.authAreaLoggedIn && (els.authAreaLoggedIn.style.display = '');
      if (els.userDisplayName) els.userDisplayName.textContent = u.name || '사용자';
    } else {
      els.authAreaLoggedOut && (els.authAreaLoggedOut.style.display = '');
      els.authAreaLoggedIn && (els.authAreaLoggedIn.style.display = 'none');
      els.userMenu && els.userMenu.classList.remove('show');
    }
  }

  // ===== Prompt settings =====
  const PROMPT_KEY = 'ai_coach_prompts';
  function loadPrompts() {
    const dflt = {
      system: '당신은 전문 발표 리허설 코치이자 음성 분석 전문가입니다. 비중단 원칙(신호어로만 개입), 세그먼트 코칭(30–60초), PEA(Positive·Exact·Actionable)를 준수하고, 음성으로 판단 불가한 시각 요소는 제외합니다.',
      guidelines: '멘토형 톤으로 친절하지만 평가 기준은 엄격하게. 수치/타임스탬프/인용을 포함해 구체적으로. 군말에는 대체 행동(침묵/호흡)을 제안.',
      rubric: '내용 구조·표현력·언어 구사·비언어 요소·청중 관점 각 10점 만점(총 50) 또는 100점 환산. 권장 속도 120–170 WPM, 군말 >3회/분 주의.'
    };
    try { return JSON.parse(localStorage.getItem(PROMPT_KEY)) || dflt; } catch { return dflt; }
  }
  function savePrompts(p) { localStorage.setItem(PROMPT_KEY, JSON.stringify(p)); }

  function initPromptEditor() {
    if (!els.promptSystem) return;
    const p = loadPrompts();
    els.promptSystem.value = p.system || '';
    els.promptGuidelines.value = p.guidelines || '';
    els.promptRubric.value = p.rubric || '';
    els.btnSavePrompts.addEventListener('click', () => {
      const next = { system: els.promptSystem.value, guidelines: els.promptGuidelines.value, rubric: els.promptRubric.value };
      savePrompts(next);
    });
  }

  // Local rule-based response using prompt settings
  function composeCoachResponse(userText, m, prompts) {
    const tips = [];
    if (prompts && prompts.system) tips.push(`[시스템] ${prompts.system}`);
    if (prompts && prompts.guidelines) tips.push(`[지침] ${prompts.guidelines}`);
    if (!m) tips.push('리허설을 시작하면 실시간 피드백을 제공합니다.');
    else {
      tips.push(`현재 속도는 ${m.wpm} WPM 입니다. ` + (m.wpm < 120 ? '조금 올려보세요.' : m.wpm > 170 ? '약간 낮춰보세요.' : '적절합니다.'));
      tips.push(`군말은 분당 ${m.fPerMin}회 수준입니다. ` + (m.fPerMin > 3 ? '멈춤과 호흡으로 조절하세요.' : '좋습니다.'));
      if (m.align != null) tips.push(`자료 일치도는 약 ${m.align}% 입니다.`);
    }
    if (/자료|레퍼|참고/.test(userText)) tips.push('상단의 "발표 참고 자료"에 핵심 내용을 붙여 넣어 주세요.');
    if (/속도|빨리|천천히/.test(userText)) tips.push('핵심 문장 전후에 0.3~0.5초 멈춤을 권장합니다.');
    if (prompts && prompts.rubric) tips.push(`[루브릭] ${prompts.rubric}`);
    return tips.join('\n');
  }

  // Chat backend hook (replace with your API)
  async function sendChatToBackend(userText, context) {
    // Try backend first
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: userText, context }) });
      if (r.ok) { const d = await r.json(); if (d?.reply) return d.reply; }
    } catch {}
    // Fallback: local rule-based
    return composeCoachResponse(userText, state.metrics, loadPrompts());
  }

  function fakeCoachResponse(userText, m, prompts) {
    const tips = [];
    if (prompts && prompts.system) tips.push(`[시스템] ${prompts.system}`);
    if (prompts && prompts.guidelines) tips.push(`[지침] ${prompts.guidelines}`);
    if (!m) tips.push('리허설을 시작하면 실시간 피드백을 제공합니다.');
    else {
      tips.push(`현재 속도는 ${m.wpm} WPM 입니다. ` + (m.wpm < 120 ? '조금 올려보세요.' : m.wpm > 170 ? '약간 낮춰보세요.' : '적절합니다.'));
      tips.push(`군말은 분당 ${m.fPerMin}회 수준입니다. ` + (m.fPerMin > 3 ? '멈춤과 호흡으로 조절하세요.' : '좋습니다.'));
      if (m.align != null) tips.push(`자료 일치도는 약 ${m.align}% 입니다.`);
    }
    if (/자료|레퍼|참고/.test(userText)) tips.push('상단의 "발표 참고 자료"에 핵심 내용을 붙여 넣어 주세요.');
    if (/속도|빨리|천천히/.test(userText)) tips.push('핵심 문장 전후에 0.3~0.5초 멈춤을 권장합니다.');
    return tips.join('\n');
  }

  // Optional: stream audio chunks to backend (replace endpoint)
  async function sendAudioChunk(blob, seq) {
    // Example only (commented due to no backend in this template)
    // const form = new FormData();
    // form.append('chunk', blob, `chunk-${seq}.webm`);
    // await fetch('/api/stream', { method: 'POST', body: form });
  }

  // Rehearsal control
  async function startRehearsal() {
    state.isRehearsing = true;
    state.startTs = Date.now();
    state.elapsedSec = 0;
    state.transcripts = [];
    state.transcriptFull = '';
    els.recTimer.textContent = '00:00';
    setStatusLive(true);
    setButtonsDuringRehearsal(true);

    try { await startAudio(); } catch (e) {
      console.error(e);
      addMessage('bot', '마이크 접근에 실패했습니다. 브라우저 권한을 확인하세요.');
    }
    if (!recog) recog = setupSpeechRecognition();
    try { recog && recog.start(); } catch {}

    state.timerHandle = setInterval(() => {
      state.elapsedSec = Math.floor((Date.now() - state.startTs) / 1000);
      els.recTimer.textContent = fmt.time(state.elapsedSec);
      // Update prosody live even without new transcript
      if (state.isRehearsing) {
        const m = computeMetrics(state.transcriptFull, Math.max(1, state.elapsedSec), state);
        state.metrics = m;
        renderLiveMetrics(m);
      }
    }, 500);
  }

  async function stopRehearsal() {
    state.isRehearsing = false;
    clearInterval(state.timerHandle);
    setStatusLive(false);
    setButtonsDuringRehearsal(false);
    try { recog && recog.stop(); } catch {}
    stopAudio();

    // Build final report
    // close open segment on stop
    closeCurrentSegment();
    const m = computeMetrics(state.transcriptFull, Math.max(1, state.elapsedSec), state);
    state.metrics = m;
    let report = buildReport(m);
    // Try server-side strict report
    try {
      const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metrics: m, segments: state.segments, reference: els.referenceText.value || '', prompt: loadPrompts() }) });
      if (r.ok) {
        const d = await r.json();
        report = { ...report, ...d };
      }
    } catch {}
    state.lastReport = report;
    renderReport(report);

    if (!state.transcriptFull.trim()) {
      addMessage('bot', '음성 인식 결과를 받지 못했습니다. 브라우저 마이크 권한과 지원 여부를 확인해 주세요. Chrome의 https/localhost 환경에서 가장 안정적으로 동작합니다.');
    }

    addMessage('bot', '리허설이 종료되었습니다. 리포트를 확인하세요. 궁금한 점을 물어보세요!');
  }

  // Event wiring
  els.btnToggleRehearsal.addEventListener('click', async () => {
    if (!state.isRehearsing) {
      els.btnToggleRehearsal.textContent = '리허설 종료';
      await startRehearsal();
    } else {
      els.btnToggleRehearsal.textContent = '리허설 시작';
      await stopRehearsal();
    }
  });

  els.btnToggleMic.addEventListener('click', () => {
    state.micInputToChat = !state.micInputToChat;
    els.btnToggleMic.classList.toggle('btn-primary', state.micInputToChat);
    if (state.micInputToChat) {
      if (!recog) recog = setupSpeechRecognition();
      try { recog && recog.start(); } catch {}
    } else {
      try { recog && recog.stop(); } catch {}
    }
  });

  els.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    addMessage('user', text);
    els.chatInput.value = '';
    try {
      const reply = await sendChatToBackend(text, {
        metrics: state.metrics,
        reference: els.referenceText.value || '',
      });
      addMessage('bot', reply);
    } catch (err) {
      console.error(err);
      addMessage('bot', '코치 응답에 실패했습니다. 나중에 다시 시도해 주세요.');
    }
  });

  // Auth UI handlers
  function hideAllModals() {
    [els.modalLogin, els.modalSignup, els.modalProfile].forEach(m => m && m.classList.remove('show'));
  }
  function toggleUserMenu() { if (els.userMenu) els.userMenu.classList.toggle('show'); }

  els.btnOpenLogin && els.btnOpenLogin.addEventListener('click', () => { hideAllModals(); els.modalLogin && els.modalLogin.classList.add('show'); });
  els.btnOpenSignup && els.btnOpenSignup.addEventListener('click', () => { hideAllModals(); els.modalSignup && els.modalSignup.classList.add('show'); });
  els.closeLogin && els.closeLogin.addEventListener('click', () => { els.modalLogin && els.modalLogin.classList.remove('show'); });
  els.closeSignup && els.closeSignup.addEventListener('click', () => { els.modalSignup && els.modalSignup.classList.remove('show'); });
  els.closeProfile && els.closeProfile.addEventListener('click', () => { els.modalProfile && els.modalProfile.classList.remove('show'); });
  els.btnUser && els.btnUser.addEventListener('click', toggleUserMenu);
  document.addEventListener('click', (e) => { if (els.authAreaLoggedIn && !els.authAreaLoggedIn.contains(e.target)) els.userMenu && els.userMenu.classList.remove('show'); });

  els.formLogin && els.formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await login({ email: els.loginEmail.value.trim(), password: els.loginPassword.value });
      els.modalLogin && els.modalLogin.classList.remove('show');
      renderAuthUI();
    } catch (err) { alert(err.message || '로그인 실패'); }
  });

  els.formSignup && els.formSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await signup({ name: els.signupName.value.trim(), email: els.signupEmail.value.trim(), password: els.signupPassword.value });
      els.modalSignup && els.modalSignup.classList.remove('show');
      renderAuthUI();
    } catch (err) { alert(err.message || '가입 실패'); }
  });

  els.btnLogout && els.btnLogout.addEventListener('click', () => { logout(); renderAuthUI(); });

  els.btnOpenProfile && els.btnOpenProfile.addEventListener('click', () => {
    const u = currentUser(); if (!u) return;
    els.profileName.value = u.name || '';
    els.profileEmail.value = u.email || '';
    els.profilePassword.value = '';
    hideAllModals(); els.modalProfile && els.modalProfile.classList.add('show');
  });

  els.formProfile && els.formProfile.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await updateProfile({ name: els.profileName.value.trim(), password: els.profilePassword.value });
      els.modalProfile && els.modalProfile.classList.remove('show');
      renderAuthUI();
    } catch (err) { alert(err.message || '저장 실패'); }
  });

  els.btnDeleteAccount && els.btnDeleteAccount.addEventListener('click', () => {
    if (!confirm('정말로 계정을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return;
    try { deleteAccount(); hideAllModals(); renderAuthUI(); } catch (err) { alert(err.message || '삭제 실패'); }
  });

  els.btnCopyReport.addEventListener('click', async () => {
    const rep = state.lastReport || (state.metrics && buildReport(state.metrics));
    if (!rep) return;
    const txt = JSON.stringify(rep, null, 2);
    try { await navigator.clipboard.writeText(txt); } catch {}
  });

  els.btnDownloadReport.addEventListener('click', () => {
    const rep = state.lastReport || (state.metrics && buildReport(state.metrics));
    if (!rep) return;
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `rehearsal-report-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // Initialize prompt editor and auth UI
  initPromptEditor();
  renderAuthUI();

  // Initial bot greeting (PREP hints)
  addMessage('bot', '안녕하세요 😊 발표 리허설 코치입니다. 먼저 PREP 인터뷰를 간단히 진행해볼까요?\n1) 발표 목적은 무엇인가요? (수업/공모전/IR/면접 등)\n2) 형태/장소는요? (무대/온라인/심사 등)\n3) 발표 시간은?\n4) 주제와 핵심 메시지는?\n5) 자신 있는 부분/보완하고 싶은 부분은?\n준비되면 "시작하겠습니다"라고 말해 주세요. 리허설 중에는 제가 개입하지 않으며, "중간 피드백"이라고 말하면 구간 피드백을 드립니다.');
  if (!state.speechSupported) {
    addMessage('bot', '⚠️ 참고: 현재 브라우저에서는 음성 인식 API를 지원하지 않습니다. Chrome/Edge 최신 버전을 사용해 https 또는 localhost 환경에서 열어야 속도·군말·자동 종료 기능을 사용할 수 있어요.');
  }
})();
