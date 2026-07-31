// Protege TODO o site (index.html, painel_publico.html e qualquer outro arquivo do
// mesmo repositório) atrás de usuário/senha, verificados aqui no servidor do Vercel
// ANTES de qualquer conteúdo ser enviado ao navegador. Diferente de uma máscara em
// JavaScript, quem não souber a senha nunca chega a baixar o HTML.
//
// Suporta VÁRIOS usuários (ex.: você, um sócio, um contador), cada um com seu próprio
// usuário e senha, todos guardados numa única Environment Variable no Vercel chamada
// SITE_USERS — nunca escritos aqui no código (este arquivo pode ficar num repositório
// público no GitHub).
//
// Formato da variável SITE_USERS (Vercel → Settings → Environment Variables):
//   usuario1:senha1|usuario2:senha2|usuario3:senha3
// Exemplo real:
//   guido.junior:JRdani061221|socio:outraSenha123
// Cada par "usuario:senha" fica separado por "|" (barra vertical) — não use "|" nem
// ":" dentro do próprio usuário ou senha, senão a leitura quebra.
import { next } from '@vercel/functions';

export const config = {
  matcher: '/:path*',
};

function credenciaisValidas() {
  const raw = process.env.SITE_USERS || '';
  return raw
    .split('|')
    .map((par) => par.trim())
    .filter(Boolean)
    .map((par) => {
      const i = par.indexOf(':');
      if (i === -1) return null;
      return [par.slice(0, i), par.slice(i + 1)];
    })
    .filter(Boolean);
}

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      let user = '', pass = '';
      try {
        [user, pass] = atob(encoded).split(':');
      } catch (e) {
        // credencial mal formada — cai para o 401 abaixo
      }
      const validos = credenciaisValidas();
      if (validos.some(([u, p]) => u === user && p === pass)) {
        return next();
      }
    }
  }

  return new Response('Autenticação necessária.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Painel Viação Sete"',
    },
  });
}
