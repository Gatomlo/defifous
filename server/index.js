const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const {
    listActiveChallenges, listAllChallenges, getChallenge, createChallenge, updateChallenge, deleteChallenge,
    createSession, getSession, listSessions, closeSession, getSessionState, updateChallengeCount,
    getArchivedSessionsWithScores,
} = require('./db');
const { calculatePoints } = require('./scoring');
const { registerAuth, requireAuthPage } = require('./auth');

const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
registerAuth(app);

// Chaque page reçoit <base href="<préfixe de montage>/"> : les chemins relatifs des pages
// (api/..., session/...) fonctionnent ainsi seuls (/) comme montés dans node-gateway (/ranch/).
// Les pages protégées reçoivent en plus un garde : une réponse 401 (session expirée) renvoie vers la connexion.
const UNAUTH_GUARD = "<script>(function(){var f=window.fetch;window.fetch=function(){return f.apply(this,arguments).then(function(r){if(r.status===401)location.href=\"login?next=\"+encodeURIComponent(location.pathname);return r;});};})();</script>";

function sendPage(file, { protect = false } = {}) {
    const html = fs.readFileSync(path.join(publicDir, file), "utf8");
    const handler = (req, res) => {
        const head = `<head>
    <base href="${req.baseUrl}/">` + (protect ? UNAUTH_GUARD : "");
        res.type("html").send(html.replace("<head>", () => head));
    };
    return protect ? [requireAuthPage, handler] : [handler];
}

app.get("/login", ...sendPage("login.html"));
app.get("/resultats/:id", ...sendPage("resultats.html"));
app.get("/classement", ...sendPage("classement.html"));
app.get("/", ...sendPage("index.html", { protect: true }));
app.get("/session/:id", ...sendPage("session.html", { protect: true }));
app.get("/defis", ...sendPage("defis.html", { protect: true }));
app.get("/compte", ...sendPage("compte.html", { protect: true }));

// ---- Sessions ----

app.get('/api/sessions', (req, res) => {
    const status = req.query.status;
    res.json(listSessions(status ? { status } : {}));
});

app.post('/api/sessions', (req, res) => {
    const { client_name, nb_equipes } = req.body || {};
    if (typeof client_name !== 'string' || !client_name.trim()) {
        return res.status(400).json({ error: 'client_name_required' });
    }
    const nb = Number(nb_equipes);
    if (!Number.isInteger(nb) || nb < 1) {
        return res.status(400).json({ error: 'nb_equipes_invalid' });
    }
    res.status(201).json(createSession({ client_name: client_name.trim(), nb_equipes: nb }));
});

app.get('/api/sessions/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    res.json({ session, challenges: getSessionState(session.id) });
});

app.post('/api/sessions/:id/challenges/:challengeId', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    if (session.status !== 'in_progress') return res.status(409).json({ error: 'session_archived' });

    const { action } = req.body || {};
    if (action !== 'increment' && action !== 'decrement') {
        return res.status(400).json({ error: 'invalid_action' });
    }

    const count = updateChallengeCount(session.id, req.params.challengeId, action);
    if (count === null) return res.status(404).json({ error: 'challenge_not_in_session' });
    res.json({ challenge_id: Number(req.params.challengeId), count, points: calculatePoints(count) });
});

app.post('/api/sessions/:id/close', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    if (session.status !== 'in_progress') return res.status(409).json({ error: 'already_archived' });
    res.json(closeSession(session.id));
});

app.get('/api/sessions/:id/resultats', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    if (session.status !== 'archived') return res.status(409).json({ error: 'session_not_archived' });

    const all = getArchivedSessionsWithScores().sort((a, b) => b.score_comparable - a.score_comparable);
    const rank = all.findIndex(s => s.id === session.id) + 1;
    const total = all.length;
    const current = all.find(s => s.id === session.id);

    const payload = {
        client_name: session.client_name,
        session_date: session.session_date,
        nb_equipes: session.nb_equipes,
        duree_heures: current.duree_heures,
        score_total: current.score_total,
        total_sessions: total,
    };

    if (total > 1) {
        payload.rank = rank;
        payload.top_percent = Math.max(1, Math.round((rank / total) * 100));
    }

    res.json(payload);
});

app.get('/api/classement', (req, res) => {
    const all = getArchivedSessionsWithScores().sort((a, b) => b.score_comparable - a.score_comparable);
    res.json(all.map((s, i) => ({
        rank: i + 1,
        id: s.id,
        client_name: s.client_name,
        session_date: s.session_date,
        nb_equipes: s.nb_equipes,
        duree_heures: s.duree_heures,
        score_total: s.score_total,
        score_comparable: s.score_comparable,
    })));
});

// ---- Défis (CRUD) ----

app.get('/api/challenges', (req, res) => {
    res.json(req.query.all ? listAllChallenges() : listActiveChallenges());
});

app.post('/api/challenges', (req, res) => {
    const { number, title, solution } = req.body || {};
    const num = Number(number);
    if (!Number.isInteger(num) || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'invalid_challenge' });
    }
    res.status(201).json(createChallenge({ number: num, title: title.trim(), solution: solution || '' }));
});

app.put('/api/challenges/:id', (req, res) => {
    const existing = getChallenge(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const { number, title, solution, active } = req.body || {};
    const num = Number(number);
    if (!Number.isInteger(num) || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'invalid_challenge' });
    }
    res.json(updateChallenge(existing.id, { number: num, title: title.trim(), solution: solution || '', active: active !== false }));
});

app.delete('/api/challenges/:id', (req, res) => {
    const existing = getChallenge(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    deleteChallenge(existing.id);
    res.status(204).end();
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
    console.log(`Ranch du Phoenix - serveur démarré sur http://localhost:${PORT}`);
    });
}

module.exports = app;
