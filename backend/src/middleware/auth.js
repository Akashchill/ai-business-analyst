import { verifyToken, PERMISSIONS } from '../services/authService.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = verifyToken(header.slice(7));
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    const perms = PERMISSIONS[req.user?.role] || {};
    if (!perms[permission]) {
      return res.status(403).json({ error: `Permission denied: ${permission}` });
    }
    next();
  };
}

// Optional auth — attaches user if token present but doesn't block
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(header.slice(7));
    } catch { /* ignore */ }
  }
  next();
}

/** Query/schema access: auth required by default; set ALLOW_ANONYMOUS_QUERY=true to allow unauthenticated queries. */
export function requireQueryAccess(req, res, next) {
  if (process.env.ALLOW_ANONYMOUS_QUERY === 'true') {
    return optionalAuth(req, res, next);
  }
  authenticate(req, res, () => {
    requirePermission('canQuery')(req, res, next);
  });
}
