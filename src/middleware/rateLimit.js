// src/middleware/rateLimit.js — rate limit simples em memória (v0.1)

const buckets = new Map();

/**
 * Cria um middleware de rate limit baseado em:
 *  - windowMs: tamanho da janela em ms
 *  - max: número máximo de requisições na janela
 *  - keyGenerator: função que gera a chave (por IP, email, etc.)
 *  - message: mensagem de erro opcional
 */
export function createRateLimiter({ windowMs, max, keyGenerator, message }) {
  return function rateLimiter(req, res, next) {
    try {
      const now = Date.now();
      const key = keyGenerator(req);

      if (!key) {
        // Se não conseguimos gerar chave, segue sem limitar
        return next();
      }

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }

      // Limpa registros antigos (fora da janela)
      const cutoff = now - windowMs;
      while (bucket.length > 0 && bucket[0] < cutoff) {
        bucket.shift();
      }

      if (bucket.length >= max) {
        return res.status(429).json({
          error:
            message ||
            'Muitas requisições em um curto espaço de tempo. Tente novamente mais tarde.',
        });
      }

      bucket.push(now);
      return next();
    } catch (err) {
      console.error('[rateLimit] Erro no middleware:', err);
      // Em caso de erro, NÃO bloqueia — falha aberta
      return next();
    }
  };
}

/**
 * Rate limit específico para LOGIN
 * - Janela: 5 minutos
 * - Máx: 10 tentativas por IP+email
 */
export const loginRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const ip =
      req.ip ||
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      'unknown';
    const email =
      (req.body && typeof req.body.email === 'string' && req.body.email) ||
      'no-email';

    return `LOGIN|${ip}|${email.toLowerCase()}`;
  },
  message: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
});

/**
 * Rate limit específico para SIGNUP
 * - Janela: 1 hora
 * - Máx: 20 requisições por IP
 */
export const signupRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const ip =
      req.ip ||
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      'unknown';

    return `SIGNUP|${ip}`;
  },
  message:
    'Muitas tentativas de criação de conta deste IP. Aguarde um pouco e tente novamente.',
});
