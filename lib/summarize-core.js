import { YoutubeTranscript } from "youtube-transcript";
import { Supadata } from "@supadata/js";

// ── Fetch transcript ──────────────────────────────────────────────────────────
// Priority: Supadata API → Cloudflare Worker → local youtube-transcript (dev only)
export async function fetchTranscript(url) {
  // 1. Supadata SDK (handles YouTube bot detection reliably)
  const supadataKey = process.env.SUPADATA_API_KEY;
  if (supadataKey) {
    const client = new Supadata({ apiKey: supadataKey });
    const result = await client.transcript({ url, lang: "en", text: true });
    // result can be a transcript object or a jobId for large files
    if (result && "jobId" in result) {
      throw new Error("Video too large for sync processing — try a shorter video.");
    }
    const text = typeof result?.content === "string"
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map((c) => c.text || "").join(" ")
        : "";
    if (text.length < 100) throw new Error("Transcript too short to summarize.");
    return text;
  }

  // 2. Cloudflare Worker proxy (fallback if no Supadata key)
  const workerUrl = process.env.CF_TRANSCRIPT_URL;
  if (workerUrl) {
    const res = await fetch(`${workerUrl}?url=${encodeURIComponent(url)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Transcript proxy failed");
    if (!body.transcript || body.transcript.length < 100)
      throw new Error("Transcript too short to summarize.");
    return body.transcript;
  }

  // 3. Local dev fallback (works on home/office IPs, not on cloud servers)
  const segments = await YoutubeTranscript.fetchTranscript(url, { lang: "en" })
    .catch(() => YoutubeTranscript.fetchTranscript(url));

  if (!segments || !segments.length)
    throw new Error("No captions found. Set SUPADATA_API_KEY in environment variables.");

  const text = segments
    .map((s) => s.text.replace(/\[.*?\]/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim())
    .filter((t) => t.length > 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 100) throw new Error("Transcript too short to summarize.");
  return text;
}

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
      temperature: 0.4,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content:
            "You are an expert video analyst. Given a YouTube video transcript, write a wholesome narrative summary in 2 to 3 paragraphs. " +
            "Your summary must: explain the full intent and purpose of the video; describe what actually happens from start to finish " +
            "(actions, demonstrations, events, discussions — not just what is said but what is being done); " +
            "capture the meaning and message behind the content. " +
            "Write in flowing prose. No bullet points, no numbered lists, no dashes, no headers. " +
            "Output only the paragraphs, nothing else.",
        },
        { role: "user", content: `Analyze and summarize this video transcript:\n\n${trimmed}` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq API error ${res.status}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// ── Public summarize function (used by REST API) ──────────────────────────────
export async function summarizeUrl(url) {
  const transcript = await fetchTranscript(url);
  const [keywords, summary] = await Promise.all([
    Promise.resolve(extractKeywords(transcript)),
    groqSummarize(transcript),
  ]);
  return { keywords, summary };
}
