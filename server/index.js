import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Load system prompt from file if present, else default
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptFileCandidates = [
  path.join(__dirname, '..', 'prompts', 'SystemPrompt_ko.txt'),
  path.join(__dirname, '..', 'prompts', 'OperationalPrinciples.md'),
];
let PROMPT_FROM_FILE = '';
for (const p of promptFileCandidates) {
  try { if (fs.existsSync(p)) { PROMPT_FROM_FILE = fs.readFileSync(p, 'utf8'); break; } } catch {}
}

const SYSTEM_PROMPT = (PROMPT_FROM_FILE || `당신은 전문 발표 리허설 코치이자 음성 분석 전문가입니다.

운영 원칙:
- 비중단 원칙: 사용자가 "중간 피드백", "잠깐", "리허설 끝"을 말할 때만 개입
- 세그먼트 코칭: 30–60초 단위, 자연스런 정지 기준
- 정확 포인트 캐치: 타임스탬프 또는 인용 포함
- PEA: Positive → Exact → Actionable
- 톤: 멘토형, 따뜻하지만 전문적, 엄격한 기준
- 시각적 요소 등 음성으로 판단 불가 항목은 평가 제외

평가 루브릭(10점 만점 각 항목):
- 내용 구조(논리·전환)
- 표현력(발음·억양·감정)
- 언어 구사(군말·반복·정확성)
- 비언어 요소(호흡·속도·침묵)
- 청중 관점(Ethos/Pathos/Logos)
`);

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function strictCoachingReply({ user, metrics, reference, prompt }) {
  const p = prompt || {};
  const sys = p.system || SYSTEM_PROMPT;
  const lines = [];
  if (sys) lines.push(`[시스템] ${sys}`);
  if (p.guidelines) lines.push(`[지침] ${p.guidelines}`);

  // Summary (strict, mentor tone)
  if (metrics) {
    const speed = metrics?.wpm ?? '-';
    const fpm = metrics?.fPerMin ?? '-';
    const pros = metrics?.prosody ?? '-';
    const align = metrics?.align ?? '-';
    lines.push(`요약: 속도 ${speed} WPM, 군말 ${fpm}/분, 억양 다양성 ${pros}, 자료 일치 ${align === null ? '-' : align + '%'}`);
    if (speed !== '-' && speed > 170) lines.push('속도가 빠릅니다. 문장 끝 0.5초 정지로 완급을 주십시오.');
    if (speed !== '-' && speed < 120) lines.push('속도가 다소 느립니다. 핵심 문장 사이 간격을 약간 좁혀보세요.');
    if (fpm !== '-' && fpm > 3) lines.push('군말이 잦습니다. 군말 대신 짧은 침묵과 호흡으로 여백을 만드세요.');
    if (align !== null && align < 60) lines.push('참고 자료 핵심 키워드 언급 비율이 낮습니다. 핵심 용어를 명시적으로 호출하세요.');
  }

  if (p.rubric) lines.push(`[루브릭] ${p.rubric}`);
  return lines.join('\n');
}

// Chat endpoint: shape responses using metrics and prompt context
app.post('/api/chat', async (req, res) => {
  const { user, context } = req.body || {};
  try {
    if (openai) {
      const model = process.env.COACH_MODEL || 'gpt-4o-mini';
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT + (context?.prompt?.system ? ('\n' + context.prompt.system) : '') },
        { role: 'user', content: JSON.stringify({
          instruction: '멘토형 톤, PEA 원칙, 숫자/타임스탬프/인용 포함. 음성으로 판단 불가 항목 제외. 간결한 불릿.',
          user,
          context,
        }) }
      ];
      const r = await openai.chat.completions.create({ model, messages, temperature: 0.2 });
      const reply = r.choices?.[0]?.message?.content?.trim() || '';
      if (reply) return res.json({ reply });
    }
    const reply = strictCoachingReply({ user, ...context });
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'chat_failed', message: e?.message || 'unknown' });
  }
});

// Report endpoint: generate strict rubric-based table and suggestions
app.post('/api/report', (req, res) => {
  const { metrics, segments, reference, prompt } = req.body || {};
  try {
    const m = metrics || {};
    const score = Math.round(
      0.25 * scaleScore(m.wpm ?? 0, 120, 170) +
      0.25 * (100 - Math.min(100, (m.fPerMin ?? 0) * 20)) +
      0.2 * (m.prosody ?? 0) +
      0.3 * (m.align == null ? 70 : m.align)
    );
    const table = buildDetailedTable(m);
    const pointers = buildPrecisionPointers(segments || []);
    const nextLoop = suggestAdaptiveLoop(m);
    res.json({ score, metrics: m, table, pointers, nextLoop });
  } catch (e) {
    res.status(500).json({ error: 'report_failed', message: e?.message || 'unknown' });
  }
});

// Optional stream acceptor (noop template)
app.post('/api/stream', (req, res) => {
  res.json({ ok: true });
});

// Helpers
function scaleScore(v, lo, hi) {
  const p = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return Math.round(100 * (0.2 + 0.8 * p));
}

function buildDetailedTable(m) {
  const rows = [];
  // 10-point strict estimates based on heuristics
  const speedScore = clamp10(scaleScore(m.wpm ?? 0, 120, 170) / 10);
  const fillerScore = clamp10(10 - Math.min(10, (m.fPerMin ?? 0) * 2));
  const prosodyScore = clamp10(((m.prosody ?? 0) / 100) * 10);
  const logicScore = clamp10(((m.align ?? 70) / 100) * 10);
  const audienceScore = clamp10(((m.align ?? 70) / 100) * 6 + ((m.prosody ?? 0) / 100) * 4);
  rows.push({ 항목: '내용 구조(논리·전환)', 점수: logicScore, 근거: 'Problem→Solution→Impact→Ask 흐름 근사' });
  rows.push({ 항목: '표현력(발음·억양·감정)', 점수: prosodyScore, 근거: 'prosody variance 근사치' });
  rows.push({ 항목: '언어 구사(군말·반복·정확성)', 점수: fillerScore, 근거: '군말 분당 빈도' });
  rows.push({ 항목: '비언어 요소(호흡·속도·침묵)', 점수: speedScore, 근거: '속도 범위 적합도' });
  rows.push({ 항목: '청중 관점(Ethos/Pathos/Logos)', 점수: audienceScore, 근거: '일치도/억양 조합' });
  return rows;
}

function buildPrecisionPointers(segments) {
  // Use segment times to craft example pointers
  return (segments || []).slice(-3).map(s => ({
    range: toRange(s),
    quote: s.text?.slice(0, 40) || '',
    action: '전환부에 0.5초 여백과 상승 억양을 넣어보세요.'
  }));
}

function suggestAdaptiveLoop(m) {
  if (!m) return { mode: 'general', reason: '기본' };
  if ((m.fPerMin ?? 0) > 4) return { mode: '발음 안정/군말 감소 루프', reason: '군말 빈도 높음' };
  if ((m.wpm ?? 0) > 170) return { mode: '호흡 템포 루프', reason: '속도 빠름' };
  if ((m.prosody ?? 0) < 25) return { mode: '감정선 강화 루프', reason: '억양 다양성 낮음' };
  return { mode: '도입부 정교화 루프', reason: '일반적 개선' };
}

function clamp10(v) { return Math.max(0, Math.min(10, Math.round(v))); }
function toRange(s) {
  const f = (x) => new Date(x * 1000).toISOString().substr(14, 5);
  if (s.start != null && s.end != null) return `${f(s.start)}–${f(s.end)}`;
  if (s.start != null) return `${f(s.start)}–`;
  return '';
}

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`AI Coach API listening on :${port}`));
