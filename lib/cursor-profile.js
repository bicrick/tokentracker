
function sliceBalancedObject(text, start) {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function profileFromObject(parsed, handle) {
  if (!parsed || typeof parsed !== 'object') return null;
  const profile = parsed.handle === handle ? parsed : parsed.profile;
  if (profile?.handle === handle && Array.isArray(profile.activityCounts)) {
    return profile;
  }
  return null;
}

function findProfileInText(text, handle) {
  const handleNeedle = `"handle":"${handle}"`;
  let from = 0;

  while (from < text.length) {
    const handleAt = text.indexOf(handleNeedle, from);
    if (handleAt === -1) return null;

    let start = handleAt;
    while (start >= 0) {
      start = text.lastIndexOf('{', start);
      if (start === -1) break;

      const blob = sliceBalancedObject(text, start);
      if (blob) {
        try {
          const profile = profileFromObject(JSON.parse(blob), handle);
          if (profile) return profile;
        } catch (_) {
          // keep walking outward
        }
      }

      start -= 1;
    }

    from = handleAt + handleNeedle.length;
  }

  return null;
}

function collectFlightStrings(html) {
  const strings = [];
  const pushPattern = /self\.__next_f\.push\(\[1,(.*?)\]\)\s*<\/script>/gs;
  let match;

  while ((match = pushPattern.exec(html)) !== null) {
    try {
      const decoded = JSON.parse(match[1]);
      if (typeof decoded === 'string') {
        strings.push(decoded);
      }
    } catch (_) {
      // skip malformed push payloads
    }
  }

  return strings;
}

export function extractProfile(html, handle) {
  for (const flight of collectFlightStrings(html)) {
    const profile = findProfileInText(flight, handle);
    if (profile) return profile;
  }

  const fromHtml = findProfileInText(html, handle);
  if (fromHtml) return fromHtml;

  throw new Error('profile payload not found');
}

export async function fetchCursorDaily(handle) {
  const response = await fetch(`https://cursor.com/@${encodeURIComponent(handle)}`, {
    headers: { Accept: 'text/html', 'User-Agent': 'tokentracker/0.1' },
  });
  if (!response.ok) throw new Error(`cursor profile fetch failed: ${response.status}`);
  const profile = extractProfile(await response.text(), handle);
  return (profile.activityCounts || []).map((r) => ({ date: r.date, count: Number(r.count) || 0 }));
}
