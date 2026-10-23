const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { SEED_CHALLENGES } = require('./seedChallenges');
const { computeTotalScore } = require('./scoring');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'ranch.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        solution TEXT,
        active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL,
        session_date TEXT NOT NULL,
        nb_equipes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        started_at TEXT NOT NULL,
        ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_challenges (
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        challenge_id INTEGER NOT NULL REFERENCES challenges(id),
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, challenge_id)
    );
`);

const { count: challengeCount } = db.prepare('SELECT COUNT(*) AS count FROM challenges').get();
if (challengeCount === 0) {
    const insert = db.prepare('INSERT INTO challenges (number, title, solution) VALUES (?, ?, ?)');
    for (const c of SEED_CHALLENGES) {
        insert.run(c.number, c.title, c.solution);
    }
}

// ---- Réglages (mot de passe admin, secret de session) ----

function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---- Défis ----

function listActiveChallenges() {
    return db.prepare('SELECT * FROM challenges WHERE active = 1 ORDER BY number').all();
}

function listAllChallenges() {
    return db.prepare('SELECT * FROM challenges ORDER BY number').all();
}

function getChallenge(id) {
    return db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
}

function createChallenge({ number, title, solution }) {
    const info = db.prepare('INSERT INTO challenges (number, title, solution) VALUES (?, ?, ?)')
        .run(number, title, solution ?? '');
    return getChallenge(info.lastInsertRowid);
}

function updateChallenge(id, { number, title, solution, active }) {
    db.prepare('UPDATE challenges SET number = ?, title = ?, solution = ?, active = ? WHERE id = ?')
        .run(number, title, solution ?? '', active ? 1 : 0, id);
    return getChallenge(id);
}

function deleteChallenge(id) {
    db.prepare('UPDATE challenges SET active = 0 WHERE id = ?').run(id);
}

// ---- Sessions ----

function createSession({ client_name, nb_equipes }) {
    const now = new Date().toISOString();
    const info = db.prepare(`
        INSERT INTO sessions (client_name, session_date, nb_equipes, status, started_at)
        VALUES (?, ?, ?, 'in_progress', ?)
    `).run(client_name, now.slice(0, 10), nb_equipes, now);
    const sessionId = info.lastInsertRowid;

    const insertSC = db.prepare('INSERT INTO session_challenges (session_id, challenge_id, count) VALUES (?, ?, 0)');
    for (const c of listActiveChallenges()) {
        insertSC.run(sessionId, c.id);
    }

    return getSession(sessionId);
}

function getSession(id) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function listSessions({ status } = {}) {
    if (status) {
        return db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY started_at DESC').all(status);
    }
    return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
}

function closeSession(id) {
    const now = new Date().toISOString();
    db.prepare("UPDATE sessions SET status = 'archived', ended_at = ? WHERE id = ?").run(now, id);
    return getSession(id);
}

function getSessionState(sessionId) {
    return db.prepare(`
        SELECT sc.challenge_id AS challenge_id, sc.count AS count, c.number AS number, c.title AS title, c.solution AS solution
        FROM session_challenges sc
        JOIN challenges c ON c.id = sc.challenge_id
        WHERE sc.session_id = ?
        ORDER BY c.number
    `).all(sessionId);
}

function updateChallengeCount(sessionId, challengeId, action) {
    const row = db.prepare('SELECT count FROM session_challenges WHERE session_id = ? AND challenge_id = ?')
        .get(sessionId, challengeId);
    if (!row) return null;

    let count = row.count;
    if (action === 'increment' && count < 3) count++;
    else if (action === 'decrement' && count > 0) count--;

    db.prepare('UPDATE session_challenges SET count = ? WHERE session_id = ? AND challenge_id = ?')
        .run(count, sessionId, challengeId);
    return count;
}

// ---- Résultats / classement ----

const MIN_DUREE_HEURES = 1 / 60; // plancher à 1 minute pour éviter une division par ~0

function getArchivedSessionsWithScores() {
    return listSessions({ status: 'archived' }).map(s => {
        const counts = db.prepare('SELECT count FROM session_challenges WHERE session_id = ?')
            .all(s.id)
            .map(r => r.count);
        const score_total = computeTotalScore(counts);
        const duree_heures = Math.max((new Date(s.ended_at) - new Date(s.started_at)) / 3_600_000, MIN_DUREE_HEURES);
        const score_comparable = score_total / (s.nb_equipes * duree_heures);
        return { ...s, score_total, duree_heures, score_comparable };
    });
}

module.exports = { db, getSetting, setSetting, listActiveChallenges, listAllChallenges, getChallenge, createChallenge, updateChallenge, deleteChallenge, createSession, getSession, listSessions, closeSession, getSessionState, updateChallengeCount, getArchivedSessionsWithScores };
