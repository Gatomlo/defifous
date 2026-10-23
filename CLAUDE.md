# Ranch du Phoenix — Suivi des défis

## Objectif
Encoder en direct (multi-appareils) les défis réalisés par les équipes pendant une session de team building, archiver les sessions, publier les résultats aux joueurs et classer les sessions entre elles.

## Stack
Node.js ≥ 22.13 (`node:sqlite` sans flag ; testé v24) + Express 4 (aligné sur node-gateway) + SQLite natif (`node:sqlite`, aucune dépendance native). Code serveur en CommonJS. Front : HTML/JS vanilla + Tailwind CDN, pas de build.

## Architecture
- `server/index.js` : exporte l'app Express (`module.exports = app`) ; `app.listen` seulement si lancé seul. Routes pages (`/`, `/session/:id`, `/resultats/:id`, `/classement`, `/defis`) et API (`/api/sessions…`, `/api/classement`, `/api/challenges…`).
- `server/db.js` : schéma SQLite (`challenges`, `sessions`, `session_challenges`), seed initial des 50 défis, classement.
- `server/scoring.js` : points par défi selon nb de réalisations (1 → 3 pts, 2 → 7 pts au total, 3+ → 0 ; PAS cumulatif).
- `server/seedChallenges.js` : contenu initial des défis (utilisé une seule fois si la table est vide).
- `public/*.html` : pages (accueil, encodage session, résultats, classement, CRUD défis). Boutons d'en-tête = icônes seules (`.btn-icon`). Chemins RELATIFS uniquement (`api/...`, `session/..`) : le serveur injecte `<base href="<préfixe>/">` dans chaque page pour fonctionner seul (`/`) ou monté dans la passerelle (`/ranch/`).
- `data/ranch.db` : base créée au premier lancement (ne pas déployer une base de test).

## Modèle de données non évident
- Une session fige ses défis à la création (`session_challenges` pré-rempli avec les défis actifs).
- Suppression d'un défi = soft-delete (`active=0`) pour préserver l'historique.
- Score comparable = `score_total / (nb_equipes × durée_h)`, durée plancher 1 min. Sert au classement et au positionnement.
- Une session `archived` est en lecture seule (API renvoie 409).
- Authentification (`server/auth.js`, sans dépendance) : un seul mot de passe admin, créé à la première visite (page `login`, mode « création » tant que `settings.password_hash` est vide), modifiable via `/compte`. Hash scrypt + cookie signé HMAC (`ranch_auth`, HttpOnly, 7 j, invalidé si le mot de passe change), verrouillage 5 échecs → 5 min. Publics : `/login`, `/resultats/:id`, `/classement` et leurs API ; tout le reste exige la connexion (401 côté API → redirection vers `login`). Un 401 est réservé à « non connecté » (mauvais mot de passe actuel = 403).
- Variable `DATA_DIR` : dossier de la base (défaut `./data`) ; à pointer hors du dossier déployé pour survivre aux redéploiements.

## Commandes
- Lancer : `npm start` (port via `PORT`, défaut 3000). Dans Claude Code : `preview_start` avec `.claude/launch.json` (port 4173 ; le port 3000 est souvent pris par une autre appli locale).
- Pas de tests automatisés : vérifier par API (`fetch`/curl) puis navigateur.
- Déploiement : monté dans `Gatomlo/node-gateway` (dossier `apps/<nom>`, route `ranch` déclarée dans le bloc `gateway` de `package.json`). Copier le projet SANS `node_modules` ni `data/` (la base se recrée), puis `npm install` à la racine de la passerelle et redémarrer. Les fichiers Apache/PHP historiques (`.htaccess`, `.user.ini`, `.infomaniak-maintenance.html`) ne servent pas cette appli.

## Méthode
Répondre en français, concis. Tester l'auth avec une base temporaire (`DATA_DIR`), jamais sur `data/ranch.db`. Éviter `confirm()` natif : utiliser des modales intégrées.
