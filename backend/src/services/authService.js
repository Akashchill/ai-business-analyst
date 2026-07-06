import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// In-memory user store — replace with DB table in production
const users = new Map();

// Seed default users on startup
async function seedUsers() {
  const defaults = [
    { email: 'admin@company.com', password: 'admin123', name: 'Admin User', role: 'admin' },
    { email: 'manager@company.com', password: 'manager123', name: 'Jane Manager', role: 'manager' },
    { email: 'analyst@company.com', password: 'analyst123', name: 'Bob Analyst', role: 'analyst' },
  ];
  for (const u of defaults) {
    const hash = await bcrypt.hash(u.password, 10);
    const id = uuidv4();
    users.set(u.email, { id, ...u, password: hash, createdAt: new Date().toISOString() });
  }
  console.log('👤 Default users seeded (admin / manager / analyst)');
}
seedUsers();

// Role permissions matrix
export const PERMISSIONS = {
  admin:   { canQuery: true, canUploadDocs: true, canManageUsers: true, canScheduleReports: true, canViewAllHistory: true },
  manager: { canQuery: true, canUploadDocs: true, canManageUsers: false, canScheduleReports: true, canViewAllHistory: true },
  analyst: { canQuery: true, canUploadDocs: false, canManageUsers: false, canScheduleReports: false, canViewAllHistory: false },
};

export async function registerUser({ email, password, name, role = 'analyst' }) {
  if (users.has(email)) throw new Error('Email already registered');
  if (!['admin', 'manager', 'analyst'].includes(role)) throw new Error('Invalid role');
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const user = { id, email, name, role, password: hash, createdAt: new Date().toISOString() };
  users.set(email, user);
  return sanitize(user);
}

export async function loginUser({ email, password }) {
  const user = users.get(email);
  if (!user) throw new Error('Invalid credentials');
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) throw new Error('Invalid credentials');
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, user: sanitize(user) };
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function getUserById(id) {
  for (const u of users.values()) {
    if (u.id === id) return sanitize(u);
  }
  return null;
}

export function listUsers() {
  return [...users.values()].map(sanitize);
}

function sanitize(u) {
  const { password, ...rest } = u;
  return { ...rest, permissions: PERMISSIONS[u.role] };
}
