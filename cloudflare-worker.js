// ── YSummarize Transcript Proxy — Cloudflare Worker ──────────────────────────
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// Paste this entire file, click Deploy, copy the *.workers.dev URL.

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const { searchParams } = new URL(request.url);
    const videoUrl = searchParams.get("url");
    if (!videoUrl) {
      return json({ error: "Missing url parameter" }, 400);
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return json({ error: "Invalid YouTube URL" }, 400);
    }

    try {
      const transcript = await getTranscript(videoId);
      return json({ transcript });
    } catch (err) {
      return json({ error: err.message || "Failed to fetch transcript" }, 500);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getTranscript(videoId) {
  // Fetch the YouTube watch page from Cloudflare's edge (not blocked)
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!pageRes.ok) throw new Error(`YouTube page fetch failed: ${pageRes.status}`);
  const html = await pageRes.text();

  // Pull caption track list out of the embedded JSON
  const trackMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!trackMatch) throw new Error("No captions found for this video.");

  const tracks = JSON.parse(trackMatch[1]);
  // Prefer English; fall back to first available
  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) ||   // manual EN
    tracks.find((t) => t.languageCode === "en") ||               // auto EN
    tracks[0];

  if (!track) throw new Error("No caption track available.");

  // Fetch the timed-text as JSON
  const ttRes = await fetch(track.baseUrl + "&fmt=json3");
  if (!ttRes.ok) throw new Error("Caption download failed.");
  const ttData = await ttRes.json();

  const text = (ttData.events || [])
    .filter((e) => e.segs)
    .flatMap((e) => e.segs)
    .map((s) => (s.utf8 || "").replace(/\n/g, " "))
    .join(" ")
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 100) throw new Error("Transcript too short.");
  return text;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
