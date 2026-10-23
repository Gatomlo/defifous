const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const COOKIE = 'ranch_auth';
const MAX_AGE_S = 7 * 24 * 3600;
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

const failures = new Map();

function isConfigured() {
    return !!getSetting('password_hash');
}

function secret() {
    let s = getSetting('session_secret');
    if (!s) {
        s = crypto.randomBytes(32).toString('hex');
        setSetting('session_secret', s);
    }
    return s;
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Le jeton embarque une empreinte du mot de passe : changer de mot de passe invalide les anciennes connexions.
function passwordVersion() {
    const stored = getSetting('password_hash');
    return stored ? stored.slice(-16) : null;
}

function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    return `${body}.${mac}`;
}

function readToken(token) {
    if (!token || !isConfigured()) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (payload.exp < Date.now() || payload.v !== passwordVersion()) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

function getCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
}

function isAuthenticated(req) {
    return !!readToken(getCookie(req, COOKIE));
}

function setAuthCookie(req, res, token, maxAgeS) {
    const parts = [`${COOKIE}=${token}`, `Path=${req.baseUrl || ''}/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
}

function startSession(req, res) {
    setAuthCookie(req, res, sign({ exp: Date.now() + MAX_AGE_S * 1000, v: passwordVersion() }), MAX_AGE_S);
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Le mot de passe doit contenir au moins ${MIN_LENGTH} caractères.`;
    if (password.length > MAX_LENGTH) return 'Mot de passe trop long.';
    return null;
}

function isLocked(ip) {
    const f = failures.get(ip);
    return !!f && f.until > Date.now();
}

function recordFailure(ip) {
    const f = failures.get(ip) || { count: 0, until: 0 };
    if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
    f.count += 1;
    if (f.count >= MAX_FAILURES) f.until = Date.now() + LOCK_MS;
    failures.set(ip, f);
}

function requireAuthApi(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
}

function requireAuthPage(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.redirect(`${req.baseUrl}/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// API accessibles sans connexion : routes d'authentification, page de résultats d'une session et classement.
function isPublicApi(req) {
    return req.path.startsWith('/auth/')
        || req.path === '/classement'
        || (req.method === 'GET' && /^\/sessions\/\d+\/resultats$/.test(req.path));
}

function registerAuth(app) {
    app.get('/api/auth/status', (req, res) => {
        res.json({ configured: isConfigured(), authenticated: isAuthenticated(req) });
    });

    app.post('/api/auth/setup', (req, res) => {
        if (isConfigured()) return res.status(409).json({ error: 'already_configured' });
        const { password } = req.body || {};
        const problem = validatePassword(password);
        if (problem) return res.status(400).json({ error: 'invalid_password', message: problem });
        setSetting('password_hash', hashPassword(password));
        startSession(req, res);
        res.json({ ok: true });
    });

    app.post('/api/auth/login', (req, res) => {
        if (!isConfigured()) return res.status(409).json({ error: 'not_configured' });
        if (isLocked(req.ip)) return res.status(429).json({ error: 'locked', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
        const { password } = req.body || {};
        if (typeof password !== 'string' || password.length > MAX_LENGTH || !verifyPassword(password, getSetting('password_hash'))) {
            recordFailure(req.ip);
            return res.status(401).json({ error: 'bad_credentials', message: 'Mot de passe incorrect.' });
        }
        failures.delete(req.ip);
        startSession(req, res);
        res.json({ ok: true });
    });

    app.post('/api/auth/logout', (req, res) => {
        setAuthCookie(req, res, '', 0);
        res.json({ ok: true });
    });

    app.post('/api/auth/password', requireAuthApi, (req, res) => {
        if (isLocked(req.ip)) return res.status(429).json({ error: 'locked', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
        const { current, next } = req.body || {};
        if (typeof current !== 'string' || current.length > MAX_LENGTH || !verifyPassword(current, getSetting('password_hash'))) {
            recordFailure(req.ip);
            return res.status(403).json({ error: 'bad_credentials', message: 'Mot de passe actuel incorrect.' });
        }
        const problem = validatePassword(next);
        if (problem) return res.status(400).json({ error: 'invalid_password', message: problem });
        setSetting('password_hash', hashPassword(next));
        startSession(req, res);
        res.json({ ok: true });
    });

    app.use('/api', (req, res, next) => (isPublicApi(req) ? next() : requireAuthApi(req, res, next)));
}

module.exports = { registerAuth, requireAuthPage, isAuthenticated };
