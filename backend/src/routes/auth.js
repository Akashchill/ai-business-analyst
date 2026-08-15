import express from 'express';
import { registerUser, loginUser, listUsers, getUserById, getUserByEmail } from '../services/authService.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await loginUser({ email, password });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// POST /api/auth/register (admin only)
router.post('/register', authenticate, requireRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, name required' });
  try {
    const user = await registerUser({ email, password, name, role });
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const user = getUserById(req.user.id) || getUserByEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// GET /api/auth/users (admin only)
router.get('/users', authenticate, requireRole('admin'), (req, res) => {
  res.json({ users: listUsers() });
});

export default router;
