import youtubedl from "youtube-dl-exec";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ytdlpPath = process.env.YTDLP_PATH || path.join(__dirname, "..", "yt-dlp.exe");

// ── Stopwords ─────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","is","was","are","were","be","been","being","have","has","had","do",
  "does","did","will","would","could","should","may","might","shall","can",
  "this","that","these","those","i","you","he","she","it","we","they","what",
  "which","who","when","where","why","how","all","each","every","both","few",
  "more","most","other","some","such","no","not","only","same","than","too",
  "very","s","t","just","about","up","out","so","if","as","into","also","like",
  "get","got","now","one","two","three","know","think","going","go","make",
  "made","time","right","back","way","even","well","our","your","their","my",
  "his","her","me","him","us","them","re","ve","ll","d","m","ok","oh","uh","um",
  "yeah","yes","actually","basically","really","literally","obviously","probably",
  "something","anything","everything","nothing","someone","anyone","let","see",
  "look","want","need","use","using","used","come","take","put","give","say",
  "said","tell","much","many","new","old","big","small","long","great","good",
  "bad","little","first","last","own","between","after","before","over","under",
  "again","further","then","once","here","there","while","however","though",
  "although","because","since","until","unless","whether","without","within",
  "through","during","against","around","among","along","across","behind",
  "beyond","plus","except","toward","per","never","always","still","already",
  "yet","ever","else","together","often","later","soon","today","sure","hey",
  "guys","things","thing","kind","sort","bit","lot","lots","enough","quite",
  "just","dont","cant","wont","doesnt","didnt","havent","hasnt","hadnt","isnt",
  "arent","wasnt","werent","im","ive","ill","id","youre","youve","youll",
  "youd","hes","shes","its","weve","theyre","theyve","thats","whats","heres"
]);

// ── VTT parser ────────────────────────────────────────────────────────────────
export function parseVTT(content) {
  const lines = content.split("\n");
  const textLines = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("WEBVTT") || t.startsWith("NOTE") ||
        t.startsWith("Kind:") || t.startsWith("Language:")) continue;
    if (/^\d+$/.test(t)) continue;
    if (/\d{2}:\d{2}:\d{2}[\.,]\d{3}\s*-->/.test(t)) continue;

    const clean = t
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "")
      .trim();

    if (clean.length > 2) textLines.push(clean);
  }

  const deduped = [];
  for (const line of textLines) {
    if (!deduped.length || deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

// ── TF-IDF keyword extraction ─────────────────────────────────────────────────
export function extractKeywords(text, topN = 60) {
  const words = text.toLowerCase().match(/\b[a-z]{3,15}\b/g) || [];
  const freq = {};

  for (const w of words) {
    if (!STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }

  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i], w2 = words[i + 1];
    if (!STOPWORDS.has(w1) && !STOPWORDS.has(w2)) {
      const bg = `${w1} ${w2}`;
      freq[bg] = (freq[bg] || 0) + 0.7;
    }
  }

  const entries = Object.entries(freq)
    .filter(([, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  if (!entries.length) return [];
  const max = entries[0][1];
  return entries.map(([text, count]) => ({
    text,
    weight: count / max,
    count: Math.round(count),
  }));
}

// ── Groq AI summary ───────────────────────────────────────────────────────────
export async function groqSummarize(transcript) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set in .env");

  const trimmed = transcript.split(" ").slice(0, 2000).join(" ");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "You are a YouTube video summarizer. Given a transcript, write 6 to 8 key insights as plain sentences. " +
            "Each insight must start with a capital letter and end with a period. " +
            "Output ONLY the sentences, one per line, with no bullet symbols, numbers, or extra formatting.",
        },
        {
          role: "user",
          content: `Summarize this transcript:\n\n${trimmed}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq API error ${res.status}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 15);
}

// ── Main summarize function (used by both SSE route and REST API) ──────────────
export async function summarizeUrl(url) {
  const subsDir = path.join(__dirname, "..", "downloads", "subs");
  fs.mkdirSync(subsDir, { recursive: true });
  const tmpId = `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputTemplate = path.join(subsDir, tmpId);

  let subsFile = null;

  try {
    await youtubedl(
      url,
      {
        writeAutoSubs: true,
        writeSubs: true,
        subFormat: "vtt",
        subLang: "en",
        skipDownload: true,
        output: outputTemplate,
        noCheckCertificates: true,
        noWarnings: true,
        quiet: true,
      },
      { ytDlpPath: ytdlpPath }
    );

    const allFiles = fs.readdirSync(subsDir).filter((f) => f.startsWith(tmpId));
    const vttFiles = allFiles.filter((f) => f.endsWith(".vtt"));

    allFiles
      .filter((f) => !f.endsWith(".vtt"))
      .forEach((f) => { try { fs.unlinkSync(path.join(subsDir, f)); } catch {} });

    if (!vttFiles.length) {
      throw new Error("No captions found for this video. Try a video that has subtitles or auto-generated captions enabled.");
    }

    subsFile = path.join(subsDir, vttFiles[0]);
    const vttContent = fs.readFileSync(subsFile, "utf-8");

    const transcript = parseVTT(vttContent);
    if (transcript.length < 100) throw new Error("Transcript too short to summarize.");

    const [keywords, summary] = await Promise.all([
      Promise.resolve(extractKeywords(transcript)),
      groqSummarize(transcript),
    ]);

    return { keywords, summary };
  } finally {
    if (subsFile) { try { fs.unlinkSync(subsFile); } catch {} }
  }
}
