// Environment variables
process.env.SUPABASE_URL = 'https://ucxkmzwrwbrqsxucbxtb.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_zyi3KJZEDEGTsR61VN_FCQ_TmOL1tVl';
process.env.VOYAGE_API_KEY = 'pa-vRmwm3XsCN1UFMuTgh7KhuQ1zwYxSIm22lFXisJ74KC';
process.env.ANTHROPIC_API_KEY = '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';

/**
 * MUFTI AI — Backend Server
 * Handles: embedding, Claude analysis, sanad verification
 * Deploy to: Railway / Render / Fly.io (free tier works)
 *
 * Usage:
 *   npm install
 *   node server.js
 */

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { VoyageAIClient } from 'voyageai';
import Anthropic from '@anthropic-ai/sdk';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));  // serves index.html

// ── Clients ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VOYAGE_MODEL = 'voyage-3-large';

const SYSTEM_PROMPT = `أنت مفتي الذكاء الاصطناعي (MUFTI AI)، نظام متخصص في علم الرجال وتخريج الأحاديث النبوية.

لديك قاعدة بيانات تضم 8,828 راوياً مستخرجة من 12 مصدراً:
- تقريب التهذيب (ابن حجر 852هـ) · الكاشف (الذهبي 748هـ)
- الجرح والتعديل (ابن أبي حاتم 327هـ) · تاريخ ابن معين (233هـ)
- الضعفاء (النسائي 303هـ) · سؤالات البرذعي (أبو زرعة 264هـ)
- سؤالات الحاكم (الدارقطني 385هـ) · سؤالات ابن أبي شيبة (ابن المديني 234هـ)
- سؤالات أبي داود + الأثرم (الإمام أحمد 241هـ)

قواعد:
1. استند فقط للنصوص المتاحة — لا تخترع أقوالاً
2. بيّن الاتفاق والاختلاف بين الأئمة
3. استخدم مصطلحات علم الرجال بدقة
4. إذا تعارضت الأقوال، اذكر الراجح مع تعليله
5. أجب بالعربية الفصحى`;

// ── POST /embed ────────────────────────────────────────────────────────────
app.post('/embed', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await voyage.embed({
      model: VOYAGE_MODEL,
      input: [text],
      inputType: 'query',
    });
    res.json({ embedding: response.data[0].embedding });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /analyze ──────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { question, context } = req.body;
    const response = await claude.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `السؤال: ${question}\n\nالمعلومات المستخرجة:\n\n${context}\n\nأجب بتحليل علمي مختصر ودقيق.`
      }]
    });
    res.json({ answer: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sanad ────────────────────────────────────────────────────────────
app.post('/sanad', async (req, res) => {
  try {
    const { narrators } = req.body;
    if (!narrators || narrators.length < 2) {
      return res.status(400).json({ error: 'أدخل راويين على الأقل' });
    }

    // Retrieve each narrator from Supabase
    const allResults = await Promise.all(narrators.map(async (name) => {
      const embRes = await voyage.embed({
        model: VOYAGE_MODEL,
        input: [name],
        inputType: 'query',
      });
      const embedding = embRes.data[0].embedding;
      const { data } = await supabase.rpc('match_rijal', {
        query_embedding: embedding,
        match_count: 1,
      });
      return data?.[0] || null;
    }));

    // Build chain links
    const ITTISAL_LEVELS = {
      SAMA:             { ar: 'سماع',           rank: 3, label: '✅ سماع — ثابت' },
      LUQYA:            { ar: 'لقيا',           rank: 2, label: '🔶 لقيا — محتمل' },
      MUASARA:          { ar: 'معاصرة',         rank: 1, label: '🔷 معاصرة — ممكن' },
      MUASARA_POSSIBLE: { ar: 'معاصرة_محتملة',  rank: 1, label: '🔹 معاصرة محتملة' },
      INQITA:           { ar: 'انقطاع',         rank: 0, label: '❌ انقطاع' },
      INQITA_POSSIBLE:  { ar: 'انقطاع_محتمل',   rank: 0, label: '⚠️ انقطاع محتمل' },
      UNKNOWN:          { ar: 'غير محدد',       rank: -1, label: '❓ غير محدد' },
    };

    const TABAQAH_RANGES = {
      1:{active:[30,100]}, 2:{active:[40,120]}, 3:{active:[80,160]},
      4:{active:[100,180]}, 5:{active:[120,200]}, 6:{active:[140,220]},
      7:{active:[170,260]}, 8:{active:[190,280]}, 9:{active:[210,300]},
      10:{active:[230,320]}, 11:{active:[250,340]}, 12:{active:[280,360]},
    };

    function parseYear(text) {
      if (!text) return null;
      const m = text.match(/\b(\d{2,3})\b/);
      return m ? parseInt(m[1]) : null;
    }

    function checkLink(a, b) {
      const textsA = [a.full_text, a.kashif_text, a.jarh_text].filter(Boolean).join(' ');
      const textsB = [b.full_text, b.kashif_text, b.jarh_text].filter(Boolean).join(' ');
      const all = textsA + ' ' + textsB;

      const SAMA   = ['حدثنا','حدثني','سمعت','أخبرنا','أخبرني','أنبأنا'];
      const LUQYA  = ['لقي','لقيه','أدرك','أدركه','رأى','رآه'];
      const INQITA = ['لم يسمع','لم يلق','لم يدرك','مرسل','منقطع'];

      const evidence = [];
      const details = {};

      if (INQITA.some(w => all.includes(w))) {
        evidence.push('وُجد لفظ يدل على الانقطاع');
        return { level: ITTISAL_LEVELS.INQITA_POSSIBLE, evidence, details };
      }

      if (SAMA.some(w => textsB.includes(w))) {
        evidence.push('وُجد لفظ التحديث في ترجمة أحد الراويين');
        return { level: ITTISAL_LEVELS.SAMA, evidence, details };
      }

      if (LUQYA.some(w => all.includes(w))) {
        evidence.push('وُجد لفظ اللقاء');
        return { level: ITTISAL_LEVELS.LUQYA, evidence, details };
      }

      const tabA = a.tabaqah_num || 0;
      const tabB = b.tabaqah_num || 0;
      const tabDiff = Math.abs(tabA - tabB);

      const dyA = parseYear(a.death_year);
      const dyB = parseYear(b.death_year);
      if (dyA && dyB) {
        details.death_years = `وفاة أ: ${dyA}هـ · وفاة ب: ${dyB}هـ · الفارق: ${Math.abs(dyA-dyB)} سنة`;
      }

      const rangeA = TABAQAH_RANGES[tabA];
      const rangeB = TABAQAH_RANGES[tabB];
      if (rangeA && rangeB) {
        const overlap = Math.min(rangeA.active[1], rangeB.active[1]) - Math.max(rangeA.active[0], rangeB.active[0]);
        if (overlap > 0) details.active_overlap = `تداخل فترة النشاط: ~${overlap} سنة`;
      }

      if (tabDiff <= 1) {
        evidence.push(`الطبقتان متقاربتان (${a.tabaqah || '؟'} و${b.tabaqah || '؟'})`);
        return { level: ITTISAL_LEVELS.MUASARA, evidence, details };
      } else if (tabDiff === 2) {
        evidence.push(`فارق الطبقة ${tabDiff} — معاصرة محتملة`);
        return { level: ITTISAL_LEVELS.MUASARA_POSSIBLE, evidence, details };
      } else {
        evidence.push(`فارق الطبقة ${tabDiff} — الانقطاع راجح`);
        return { level: ITTISAL_LEVELS.INQITA, evidence, details };
      }
    }

    const links = [];
    let overallVerdict = 'متصل';

    for (let i = 1; i < allResults.length; i++) {
      const a = allResults[i-1];
      const b = allResults[i];
      if (!a || !b) {
        links.push({ from: narrators[i-1], to: narrators[i], level: ITTISAL_LEVELS.UNKNOWN, evidence: ['لم يُعثر على أحد الراويين'], details: {} });
        continue;
      }
      const link = checkLink(a, b);
      links.push({ from: narrators[i-1], to: narrators[i], ...link });
      if (link.level.rank === 0) overallVerdict = 'منقطع';
      else if (link.level.rank === 1 && overallVerdict === 'متصل') overallVerdict = 'محتمل الاتصال';
    }

    // Claude analysis
    const chainText = links.map((l, i) =>
      `الحلقة ${i+1}: ${l.from} → ${l.to}\nالمستوى: ${l.level.label}\nالأدلة: ${l.evidence.join('؛ ')}`
    ).join('\n\n');

    const aiRes = await claude.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `قيّم اتصال هذا السند:\n${narrators.join(' ← ')}\n\n${chainText}\n\nالحكم الأولي: ${overallVerdict}\n\nأعطِ حكماً مختصراً على اتصال هذا السند مع بيان أضعف حلقة فيه.`
      }]
    });

    res.json({
      links,
      overall_verdict: overallVerdict,
      analysis: aiRes.content[0].text,
      narrators: allResults,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`MUFTI AI running on port ${PORT}`));

