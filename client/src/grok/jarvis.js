const GROK_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

const JARVIS_SYSTEM = `You are JARVIS, the AI assistant inside an Iron Man suit.
The player is flying over Johns Hopkins University Homewood campus in Baltimore, Maryland.
You have access to real-time data from X (Twitter).
Be witty, tactical, and cinematic. Maximum 2 sentences. No asterisks or markdown.`;

export const GAME_EVENTS = {
  SENTINEL_LOCKED:  'Sentinel has locked onto the suit.',
  HEALTH_LOW:       'Suit integrity below 20 percent.',
  JUDGE_CRASH:      'The judge player just crashed their suit into a building at JHU.',
  REPULSOR_FIRED:   'Player fired repulsor blast.',
  PLAYER_JOINED:    'A second Iron Man suit has just entered JHU Homewood airspace.',
  CAMPUS_SCAN:      'Scan the JHU Homewood campus on X right now. Generate a tactical threat report. Format: THREAT LEVEL / SECTOR / DETAIL',
};

export async function jarvisComment(event, apiKey) {
  const key = apiKey ?? import.meta.env.VITE_GROK_API_KEY;
  if (!key) {
    console.warn('JARVIS: no Grok API key');
    return null;
  }

  const res = await fetch(GROK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-3',
      max_tokens: 80,
      messages: [
        { role: 'system', content: JARVIS_SYSTEM },
        { role: 'user',   content: event },
      ],
    }),
  });

  if (!res.ok) {
    console.error('JARVIS fetch error', res.status);
    return null;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? null;
}
