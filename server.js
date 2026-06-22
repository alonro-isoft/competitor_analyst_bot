const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/auth/linkedin/callback`;

app.use(cors());
app.use(express.json());

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// OAuth callback — extracts code from URL and sends it to the opener via postMessage
app.get('/auth/linkedin/callback', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>LinkedIn Auth</title></head>
<body>
<p style="font-family:Arial;text-align:center;margin-top:2rem">מתחבר ללינקדין...</p>
<script>
  const params = new URLSearchParams(window.location.search);
  if (window.opener) {
    window.opener.postMessage({
      type: 'LINKEDIN_AUTH',
      code: params.get('code') || '',
      state: params.get('state') || '',
      error: params.get('error') || ''
    }, '*');
  }
  setTimeout(() => window.close(), 800);
</script>
</body>
</html>`);
});

// Exchange authorization code for access token
app.post('/api/linkedin/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const { data } = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.response?.data ?? err.message });
  }
});

// Fetch LinkedIn profile — combines OpenID Connect userinfo + extended v2 profile
app.get('/api/linkedin/profile', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  try {
    const { data: userinfo } = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: auth },
    });

    // Try to fetch headline and current position (requires r_liteprofile scope)
    let headline = '';
    let currentRole = '';
    let aboutSection = '';

    try {
      const { data: me } = await axios.get(
        'https://api.linkedin.com/v2/me?projection=(localizedHeadline,headline)',
        { headers: { Authorization: auth } }
      );
      headline = me.localizedHeadline || me.headline || '';
    } catch (_) { /* scope not granted or not available */ }

    try {
      const { data: positions } = await axios.get(
        'https://api.linkedin.com/v2/me?projection=(positions)',
        { headers: { Authorization: auth } }
      );
      const pos = positions?.positions?.values;
      if (pos?.length) {
        const current = pos.find(p => !p.timePeriod?.endDate) || pos[0];
        const title = current.title || '';
        const company = current.company?.name || '';
        currentRole = [title, company].filter(Boolean).join(' at ');
      }
    } catch (_) { /* not available */ }

    res.json({ ...userinfo, headline, currentRole, aboutSection });
  } catch (err) {
    res.status(502).json({ error: err.response?.data ?? err.message });
  }
});

// Publish a text post to LinkedIn
app.post('/api/linkedin/post', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const { text, authorUrn } = req.body;
  if (!text || !authorUrn) {
    return res.status(400).json({ error: 'Missing required fields: text, authorUrn' });
  }
  if (text.length > 3000) {
    return res.status(400).json({ error: 'Post text exceeds 3000 character limit' });
  }

  try {
    const { data } = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      {
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      },
      {
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.response?.data ?? err.message });
  }
});

// Bookmarklet profile import — stores data temporarily until the app polls for it
let pendingProfileImport = null;

app.post('/api/import-profile', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Private-Network', 'true');
  pendingProfileImport = req.body;
  res.json({ success: true });
});

app.options('/api/import-profile', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Private-Network', 'true');
  res.sendStatus(200);
});

app.get('/api/import-profile', (req, res) => {
  const data = pendingProfileImport;
  pendingProfileImport = null;
  res.json(data || {});
});

app.listen(PORT, () => {
  console.log(`\nLinkedIn server ready: http://localhost:${PORT}`);
  console.log(`Redirect URI (add to LinkedIn app): ${REDIRECT_URI}\n`);
});
