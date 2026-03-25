const express  = require('express');
const { DatabaseSync } = require('node:sqlite');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'momentum2024';
const ADMIN_TOKEN    = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');

// ── Database setup ─────────────────────────────────────────────────────────
const db = new DatabaseSync(path.join(__dirname, 'trivia.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    question_number INTEGER UNIQUE NOT NULL,
    question_text   TEXT NOT NULL,
    option_a        TEXT NOT NULL,
    option_b        TEXT NOT NULL,
    option_c        TEXT NOT NULL,
    option_d        TEXT NOT NULL,
    correct_answer  TEXT NOT NULL CHECK(correct_answer IN ('A','B','C','D')),
    points          INTEGER DEFAULT 1,
    revealed        INTEGER DEFAULT 0,
    locked          INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_number    INTEGER NOT NULL,
    team_name       TEXT,
    question_number INTEGER NOT NULL,
    answer          TEXT NOT NULL CHECK(answer IN ('A','B','C','D')),
    submitted_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(table_number, question_number)
  );

  CREATE TABLE IF NOT EXISTS table_registrations (
    table_number  INTEGER PRIMARY KEY,
    team_name     TEXT,
    registered_at TEXT DEFAULT (datetime('now'))
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin auth middleware ──────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin login ────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// ── Player: look up a table (returns team_name if already registered) ─────
app.get('/api/table/:number', (req, res) => {
  const row = db.prepare('SELECT team_name FROM table_registrations WHERE table_number = ?')
    .get(Number(req.params.number));
  if (row) {
    res.json({ registered: true, team_name: row.team_name });
  } else {
    res.json({ registered: false, team_name: null });
  }
});

// ── Player: register a table (first time only) ────────────────────────────
app.post('/api/table/register', (req, res) => {
  const { table_number, team_name } = req.body;
  if (!table_number) return res.status(400).json({ error: 'table_number required' });

  // If already registered, return existing name — no overwrite allowed
  const existing = db.prepare('SELECT team_name FROM table_registrations WHERE table_number = ?')
    .get(Number(table_number));
  if (existing) {
    return res.json({ registered: true, team_name: existing.team_name });
  }

  db.prepare('INSERT INTO table_registrations (table_number, team_name) VALUES (?, ?)')
    .run(Number(table_number), team_name || null);
  res.json({ registered: true, team_name: team_name || null });
});

// ── Player: get question (no correct answer exposed) ──────────────────────
app.get('/api/questions/:number', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE question_number = ?').get(Number(req.params.number));
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const { correct_answer, ...safe } = q;
  // If the caller passes ?table_number=X, include their existing answer (if any)
  const { table_number } = req.query;
  if (table_number) {
    const existing = db.prepare(
      'SELECT answer FROM submissions WHERE table_number = ? AND question_number = ?'
    ).get(Number(table_number), Number(req.params.number));
    safe.existing_answer = existing ? existing.answer : null;
  }
  res.json(safe);
});

// ── Player: submit answer ─────────────────────────────────────────────────
app.post('/api/submit', (req, res) => {
  const { table_number, team_name, question_number, answer } = req.body;
  if (!table_number || !question_number || !answer) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const q = db.prepare('SELECT * FROM questions WHERE question_number = ?').get(Number(question_number));
  if (!q) return res.status(404).json({ error: 'Question not found' });
  if (q.locked) return res.status(400).json({ error: 'This question is locked — no more answers accepted.' });

  const up = answer.toUpperCase();
  if (!['A','B','C','D'].includes(up)) return res.status(400).json({ error: 'Answer must be A, B, C, or D' });

  // Block duplicate submissions — answers are final once submitted
  const existing = db.prepare(
    'SELECT answer FROM submissions WHERE table_number = ? AND question_number = ?'
  ).get(Number(table_number), Number(question_number));
  if (existing) {
    return res.status(409).json({
      error: `Your table already submitted "${existing.answer}" for this question. Answers cannot be changed.`,
      existing_answer: existing.answer
    });
  }

  db.prepare(`
    INSERT INTO submissions (table_number, team_name, question_number, answer)
    VALUES (?, ?, ?, ?)
  `).run(Number(table_number), team_name || null, Number(question_number), up);

  res.json({ success: true, message: 'Answer submitted!' });
});

// ── Public leaderboard (only revealed questions count) ────────────────────
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT
      s.table_number,
      MAX(s.team_name) AS team_name,
      COALESCE(SUM(CASE WHEN s.answer = q.correct_answer AND q.revealed = 1 THEN q.points ELSE 0 END), 0) AS score,
      COUNT(DISTINCT s.question_number) AS questions_answered
    FROM submissions s
    JOIN questions q ON s.question_number = q.question_number
    GROUP BY s.table_number
    ORDER BY score DESC, questions_answered DESC
  `).all();
  res.json(rows);
});

// ── Admin: list all questions ─────────────────────────────────────────────
app.get('/api/admin/questions', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM questions ORDER BY question_number').all());
});

// ── Admin: upload questions ───────────────────────────────────────────────
app.post('/api/admin/questions', adminAuth, (req, res) => {
  const { questions, replace } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty questions array' });
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO questions
      (question_number, question_text, option_a, option_b, option_c, option_d, correct_answer, points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    if (replace) {
      db.exec('DELETE FROM submissions');
      db.exec('DELETE FROM questions');
    }
    for (const q of questions) {
      upsert.run(
        Number(q.question_number), q.question_text,
        q.option_a, q.option_b, q.option_c, q.option_d,
        q.correct_answer.toUpperCase(), Number(q.points) || 1
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(400).json({ error: e.message });
  }

  res.json({ success: true, count: questions.length });
});

// ── Admin: delete one question ────────────────────────────────────────────
app.delete('/api/admin/questions/:number', adminAuth, (req, res) => {
  const n = Number(req.params.number);
  db.prepare('DELETE FROM submissions WHERE question_number = ?').run(n);
  db.prepare('DELETE FROM questions WHERE question_number = ?').run(n);
  res.json({ success: true });
});

// ── Admin: clear scores only (requires password re-entry) ────────────────
// ── Admin: list all registered tables ────────────────────────────────────
app.get('/api/admin/tables', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      r.table_number,
      r.team_name,
      r.registered_at,
      COUNT(s.id) AS answers_submitted
    FROM table_registrations r
    LEFT JOIN submissions s ON r.table_number = s.table_number
    GROUP BY r.table_number
    ORDER BY r.table_number
  `).all();
  res.json(rows);
});

// ── Admin: delete a single table registration (and its submissions) ───────
app.delete('/api/admin/tables/:number', adminAuth, (req, res) => {
  const n = Number(req.params.number);
  db.prepare('DELETE FROM submissions WHERE table_number = ?').run(n);
  db.prepare('DELETE FROM table_registrations WHERE table_number = ?').run(n);
  res.json({ success: true });
});

app.delete('/api/admin/clear-scores', adminAuth, (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password incorrect.' });
  }
  db.exec('DELETE FROM submissions');
  db.exec('DELETE FROM table_registrations');
  res.json({ success: true });
});

// ── Admin: wipe everything (requires password re-entry) ───────────────────
app.delete('/api/admin/reset', adminAuth, (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password incorrect.' });
  }
  db.exec('DELETE FROM submissions');
  db.exec('DELETE FROM table_registrations');
  db.exec('DELETE FROM questions');
  res.json({ success: true });
});

// ── Admin: reveal / hide answer ───────────────────────────────────────────
app.put('/api/admin/questions/:number/reveal', adminAuth, (req, res) => {
  db.prepare('UPDATE questions SET revealed = ? WHERE question_number = ?')
    .run(req.body.revealed ? 1 : 0, Number(req.params.number));
  res.json({ success: true });
});

// ── Admin: lock / unlock question ─────────────────────────────────────────
app.put('/api/admin/questions/:number/lock', adminAuth, (req, res) => {
  db.prepare('UPDATE questions SET locked = ? WHERE question_number = ?')
    .run(req.body.locked ? 1 : 0, Number(req.params.number));
  res.json({ success: true });
});

// ── Admin: per-question answer distribution ───────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = db.prepare(`
    SELECT
      q.question_number, q.question_text, q.correct_answer,
      q.revealed, q.locked, q.points,
      COUNT(s.id)                                               AS total_submissions,
      SUM(CASE WHEN s.answer = 'A' THEN 1 ELSE 0 END)          AS count_a,
      SUM(CASE WHEN s.answer = 'B' THEN 1 ELSE 0 END)          AS count_b,
      SUM(CASE WHEN s.answer = 'C' THEN 1 ELSE 0 END)          AS count_c,
      SUM(CASE WHEN s.answer = 'D' THEN 1 ELSE 0 END)          AS count_d
    FROM questions q
    LEFT JOIN submissions s ON q.question_number = s.question_number
    GROUP BY q.question_number
    ORDER BY q.question_number
  `).all();
  res.json(stats);
});

// ── Admin: recent submissions ─────────────────────────────────────────────
app.get('/api/admin/submissions', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (s.answer = q.correct_answer) AS is_correct
    FROM submissions s
    JOIN questions q ON s.question_number = q.question_number
    ORDER BY s.submitted_at DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

// ── Admin: full leaderboard (all questions, even unrevealed) ──────────────
app.get('/api/admin/leaderboard', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      s.table_number,
      MAX(s.team_name) AS team_name,
      COALESCE(SUM(CASE WHEN s.answer = q.correct_answer THEN q.points ELSE 0 END), 0) AS score,
      COUNT(DISTINCT s.question_number) AS questions_answered
    FROM submissions s
    JOIN questions q ON s.question_number = q.question_number
    GROUP BY s.table_number
    ORDER BY score DESC
  `).all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`\n🎉 Momentum Trivia is live at http://localhost:${PORT}`);
  console.log(`🔐 Admin panel:    http://localhost:${PORT}/admin.html`);
  console.log(`🏆 Leaderboard:    http://localhost:${PORT}/leaderboard.html`);
  console.log(`🔑 Admin password: ${ADMIN_PASSWORD}\n`);
});
