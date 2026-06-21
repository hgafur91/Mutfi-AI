/**
 * MUFTI AI — Backend Server v2
 * Modes: search (hybrid), sanad, chat
 */

process.env.SUPABASE_URL = 'https://ucxkmzwrwbrqsxucbxtb.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjeGttendyd2JycXN4dWNieHRiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTk3MjA3MCwiZXhwIjoyMDk3NTQ4MDcwfQ.xw9liA1ODmCj6HSQBvSV_Q1TGpYaSy2gSwg7QeVQMDc';
process.env.VOYAGE_API_KEY = 'pa-vRmwm3XsCN1UFMuTgh7KhuQ1zwYxSIm22lFXisJ74KC';
process.env.ANTHROPIC_API_KEY = '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';

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { VoyageAIClient } from 'voyageai';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VOYAGE_MODEL = 'voyage-3-large';

const SYSTEM_PROMPT = `أنت "مفتي AI"، عالم متخصص في علم الرجال والجرح والتعديل وعلم الحديث.

# مصادرك (12 مصدراً فقط — لا تتجاوزها أبداً):
المصادر الأصلية (قبل 400هـ):
- الجرح والتعديل لابن أبي حاتم (327هـ)
- العلل ومعرفة الرجال للإمام أحمد (241هـ)
- تاريخ ابن معين برواية الدوري وابن محرز (233هـ)
- الضعفاء والمتروكون للنسائي (303هـ)
- سؤالات ابن أبي شيبة لابن المديني (234هـ)
- سؤالات أبي داود والأثرم للإمام أحمد (241هـ)
- سؤالات البرذعي لأبي زرعة الرازي (264هـ)
- سؤالات الحاكم للدارقطني (385هـ)
- سؤالات السجزي للحاكم (405هـ)
المصادر الثانوية:
- تقريب التهذيب لابن حجر (852هـ)
- الكاشف للذهبي (748هـ)

# قواعد صارمة:
1. لا تستند إلا للنصوص المتاحة في قاعدة البيانات المعطاة لك. إذا لم يرد راوٍ أو قول، قل بصراحة "لم أجد هذا في المصادر المتاحة لدي".
2. لا تخترع أقوالاً للأئمة أبداً. لا تستعمل معرفتك العامة خارج المصادر.
3. فرّق بين المصادر الأصلية (التي تنقل بالسند) والثانوية (التي تلخّص).
4. عند تعارض الأقوال، اذكر القولين وبيّن الراجح بمنهج المحدّثين.
5. استعمل مصطلحات علم الرجال بدقة (ثقة، صدوق، ضعيف، متروك، إلخ).
6. أجب بالعربية الفصحى بأسلوب علمي رصين.`;

async function embedText(text, type='query') {
  const r = await voyage.embed({ model: VOYAGE_MODEL, input: [text], inputType: type });
  return r.data[0].embedding;
}

// Hybrid search: exact name match first, then vector
async function hybridSearch(query, topK=6) {
  // 1. Try exact text match
  let { data: exact } = await supabase.rpc('search_rijal_by_name', {
    search_term: query, max_count: topK
  });

  // 2. Vector search
  const embedding = await embedText(query);
  let { data: vector } = await supabase.rpc('match_rijal', {
    query_embedding: embedding, match_count: topK
  });

  // Merge: exact matches first (dedup by narrator_id)
  const seen = new Set();
  const merged = [];
  for (const r of (exact || [])) {
    if (!seen.has(r.narrator_id)) { seen.add(r.narrator_id); merged.push(r); }
  }
  for (const r of (vector || [])) {
    if (!seen.has(r.narrator_id)) { seen.add(r.narrator_id); merged.push(r); }
  }
  return merged.slice(0, topK);
}

// ── SEARCH ──
app.post('/embed', async (req, res) => {
  try { res.json({ embedding: await embedText(req.body.text) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    const narrators = await hybridSearch(query, 6);
    res.json({ narrators });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/analyze', async (req, res) => {
  try {
    const { question, context } = req.body;
    const r = await claude.messages.create({
      model: 'claude-3-5-sonnet-20241022', max_tokens: 1200, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `السؤال: ${question}\n\nالمعلومات من قاعدة البيانات:\n\n${context}\n\nحلل حال الراوي بناءً على هذه المصادر فقط.` }]
    });
    res.json({ answer: r.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHAT (free conversation) ──
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;  // [{role, content}, ...]

    // Get the last user message to search for relevant narrators
    const lastMsg = messages[messages.length - 1]?.content || '';
    const narrators = await hybridSearch(lastMsg, 5);

    const context = narrators.length
      ? narrators.map((n,i) => `[${i+1}] ${n.full_text}\nابن حجر: ${n.hukm||'—'} | الذهبي: ${n.hukm_dhahabi||'—'} | ابن أبي حاتم: ${n.hukm_ibn_abi_hatim||'—'} | ابن معين: ${n.hukm_ibn_maeen||'—'} | النسائي: ${n.hukm_nasai||'—'} | أبو زرعة: ${n.hukm_abu_zuraa||'—'} | الدارقطني: ${n.hukm_daraqutni||'—'}`).join('\n\n')
      : 'لم يتم العثور على رواة مطابقين في قاعدة البيانات لهذا السؤال.';

    const chatMessages = [
      ...messages.slice(0, -1),
      { role: 'user', content: `${lastMsg}\n\n---\nمعلومات ذات صلة من قاعدة البيانات (استند إليها فقط):\n${context}` }
    ];

    const r = await claude.messages.create({
      model: 'claude-3-5-sonnet-20241022', max_tokens: 1500, system: SYSTEM_PROMPT,
      messages: chatMessages
    });
    res.json({ answer: r.content[0].text, narrators });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SANAD ──
app.post('/sanad', async (req, res) => {
  try {
    const { narrators } = req.body;
    if (!narrators || narrators.length < 2) return res.status(400).json({ error: 'أدخل راويين على الأقل' });

    const allResults = await Promise.all(narrators.map(n => hybridSearch(n, 1).then(r => r[0] || null)));

    const LEVELS = {
      SAMA: { ar:'سماع', rank:3, label:'✅ سماع — ثابت' },
      LUQYA: { ar:'لقيا', rank:2, label:'🔶 لقيا — محتمل' },
      MUASARA: { ar:'معاصرة', rank:1, label:'🔷 معاصرة — ممكن' },
      MUASARA_POSSIBLE: { ar:'معاصرة_محتملة', rank:1, label:'🔹 معاصرة محتملة' },
      INQITA: { ar:'انقطاع', rank:0, label:'❌ انقطاع' },
      INQITA_POSSIBLE: { ar:'انقطاع_محتمل', rank:0, label:'⚠️ انقطاع محتمل' },
      UNKNOWN: { ar:'غير محدد', rank:-1, label:'❓ غير محدد' },
    };

    function checkLink(a, b) {
      const all = [a.full_text,a.kashif_text,a.jarh_text,b.full_text,b.kashif_text,b.jarh_text].filter(Boolean).join(' ');
      const textsB = [b.full_text,b.kashif_text,b.jarh_text].filter(Boolean).join(' ');
      const details = {};
      if (['لم يسمع','لم يلق','مرسل','منقطع'].some(w => all.includes(w)))
        return { level: LEVELS.INQITA_POSSIBLE, evidence:['وُجد لفظ يدل على الانقطاع'], details };
      if (['حدثنا','حدثني','سمعت','أخبرنا'].some(w => textsB.includes(w)))
        return { level: LEVELS.SAMA, evidence:['وُجد لفظ التحديث'], details };
      if (['لقي','أدرك','رأى'].some(w => all.includes(w)))
        return { level: LEVELS.LUQYA, evidence:['وُجد لفظ اللقاء'], details };
      const tabDiff = Math.abs((a.tabaqah_num||0)-(b.tabaqah_num||0));
      const dyA = (a.death_year||'').match(/\b(\d{2,3})\b/)?.[1];
      const dyB = (b.death_year||'').match(/\b(\d{2,3})\b/)?.[1];
      if (dyA && dyB) details.death_years = `وفاة أ: ${dyA}هـ · وفاة ب: ${dyB}هـ`;
      if (tabDiff <= 1) return { level: LEVELS.MUASARA, evidence:['الطبقتان متقاربتان'], details };
      if (tabDiff === 2) return { level: LEVELS.MUASARA_POSSIBLE, evidence:[`فارق الطبقة ${tabDiff}`], details };
      return { level: LEVELS.INQITA, evidence:[`فارق الطبقة ${tabDiff} — الانقطاع راجح`], details };
    }

    const links = []; let verdict = 'متصل';
    for (let i=1;i<allResults.length;i++){
      const a=allResults[i-1], b=allResults[i];
      if(!a||!b){links.push({from:narrators[i-1],to:narrators[i],level:LEVELS.UNKNOWN,evidence:['لم يُعثر على أحد الراويين'],details:{}});continue;}
      const link=checkLink(a,b);
      links.push({from:narrators[i-1],to:narrators[i],...link});
      if(link.level.rank===0)verdict='منقطع';
      else if(link.level.rank===1&&verdict==='متصل')verdict='محتمل الاتصال';
    }

    const chainText = links.map((l,i)=>`الحلقة ${i+1}: ${l.from} → ${l.to}\nالمستوى: ${l.level.label}\nالأدلة: ${l.evidence.join('؛ ')}`).join('\n\n');
    const aiRes = await claude.messages.create({
      model:'claude-3-5-sonnet-20241022', max_tokens:800, system:SYSTEM_PROMPT,
      messages:[{role:'user',content:`قيّم اتصال هذا السند:\n${narrators.join(' ← ')}\n\n${chainText}\n\nالحكم الأولي: ${verdict}\n\nأعطِ حكماً مختصراً مع بيان أضعف حلقة.`}]
    });
    res.json({ links, overall_verdict: verdict, analysis: aiRes.content[0].text, narrators: allResults });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`MUFTI AI v2 running on port ${PORT}`));
