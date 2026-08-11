/**
 * Resolve values injected by ECS from AWS Secrets Manager.
 *
 * If valueFrom is the secret ARN without a JSON key, the env var becomes the
 * whole object, e.g. {"DB_PASSWORD":"...","GEMINI_API_KEY":"...","JWT_SECRET":"..."}.
 * Prefer valueFrom with a key: arn:...:secret:name:GEMINI_API_KEY::
 */

export function resolveSecretValue(raw, fieldNames = []) {
  if (raw == null || raw === '') return raw;
  let value = String(raw).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        for (const key of fieldNames) {
          const fromJson = parsed[key];
          if (typeof fromJson === 'string' && fromJson.length > 0) {
            console.warn(
              `⚠️  Secret value looked like JSON; extracted "${key}". ` +
                `Prefer ECS valueFrom with a JSON key, e.g. arn:...:secret:name:${key}::`
            );
            return fromJson.trim();
          }
        }
      }
    } catch {
      // not JSON — use as-is
    }
  }

  return value;
}

/** Read an env var and unwrap Secrets Manager JSON if needed. */
export function secretEnv(name, alternateKeys = []) {
  return resolveSecretValue(process.env[name], [name, ...alternateKeys]);
}
