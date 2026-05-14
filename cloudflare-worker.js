// ── YSummarize Transcript Proxy — Cloudflare Worker ──────────────────────────
// Uses YouTube's InnerTube API (Android client) — not blocked like browser requests.
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const { searchParams } = new URL(request.url);
    const videoUrl = searchParams.get("url");
    if (!videoUrl) return json({ error: "Missing url parameter" }, 400);

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return json({ error: "Invalid YouTube URL" }, 400);

    try {
      const transcript = await getTranscript(videoId);
      return json({ transcript });
    } catch (err) {
      return json({ error: err.message || "Failed to fetch transcript" }, 500);
    }
  },
};

// ── Core: InnerTube API (YouTube Android client) ──────────────────────────────
async function getTranscript(videoId) {
  // Step 1: get caption track URLs from InnerTube /player endpoint
  const playerRes = await fetch(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip",
        "X-YouTube-Client-Name": "3",
        "X-YouTube-Client-Version": "17.31.35",
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "17.31.35",
            androidSdkVersion: 30,
            hl: "en",
            gl: "US",
          },
        },
      }),
    }
  );

  if (!playerRes.ok) {
    throw new Error(`InnerTube API error: ${playerRes.status}`);
  }

  const playerData = await playerRes.json();
  const tracks =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || !tracks.length) {
    throw new Error(
      "No captions found for this video. Try a video with subtitles or auto-generated captions enabled."
    );
  }

  // Prefer manual English → auto English → first available
  const track =
    tracks.find((t) => t.languageCode === "en" && !t.kind) ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks[0];

  // Step 2: fetch the actual timed-text in JSON format
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractVideoId(url) {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([a-zA-Z0-9_-]{11})/
  );
  return m ? m[1] : null;
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
